/**
 * Micro-batching and short-lived caching for chain reads.
 *
 * ⭐ WHY THIS EXISTS. Every 30 seconds the forum did **1 × `getHeadsPaged` + N × `getProfile`** — one
 * profile read per row, N up to 50, and the same author re-read once per thread they had posted.
 * Every `VotingWidget` on the page did another **3** (`getTally`, `getScore`, `getUserVote`). On a
 * phone, inside the host, that is a hundred and fifty `.query()` dry-runs twice a minute for a board
 * that has almost certainly not changed.
 *
 * The contracts already shipped the fix and nothing used it: `UserRegistry.getProfiles(address[])`,
 * `Voting.getTallies(bytes32[])` and `Voting.getUserVotes(bytes32[], address)` each read a screenful
 * in one call, and `PostRegistry.headsOf(bytes32, address[])` does the same for heads. All four are
 * present in the deployed ABIs (`frontend/src/contracts/*.json`) **and** in the Solidity — checked,
 * not assumed, because "a call naming a function the target does not have" is this repo's most
 * common bug and reverts as `execution reverted (no data present)`, which reads like a broken
 * contract rather than a wrong call.
 *
 * ⭐ THE SHAPE: the CALL SITES DO NOT CHANGE. Sixteen of them, plus about ten presentation
 * components, ask for one thing at a time — `getDisplayName(author)`, `getVoteTally(entityId)`. A
 * loader collects the keys asked for in one tick, issues ONE batch read, and hands each caller its
 * own answer. Rewriting every consumer to pass arrays would have meant editing files this change is
 * not allowed to touch, and would have made a batching bug and a rendering bug indistinguishable.
 *
 * ⚠️ THIS MODULE MAKES NO NETWORK CALL AND KNOWS NOTHING ABOUT THE SDK. It is handed a `fetch` and
 * only decides *when* to call it and *what to remember*. That is what lets it be tested by
 * `npm run test:lib`, which runs on bare node with zero dependencies.
 *
 * ⚠️ NO FROZEN CLOCKS. `now` is injectable and defaults to `Date.now`; a `() => 0` clock hung a test
 * in this repo indefinitely. A test that wants to age the cache must ADVANCE its clock, never stop it.
 */

// ⚠️ TYPE-ONLY. A value import without a file extension cannot be resolved by bare Node ESM, which
// is what `npm run test:lib` runs on; a type import is erased before it gets there.
import type { Profile, VoteTally, VoteType } from "../types/contracts";

/** A key's answer. ⚠️ `undefined` is reserved as the ABSENT sentinel — see {@link alignBatch}. */
export interface BatchLoader<K, V> {
  /**
   * Ask for one key. Resolves with that key's value.
   *
   * Calls made before the next flush are coalesced into ONE `fetch`; duplicate keys inside one batch
   * are read once and share the answer.
   */
  load(key: K): Promise<V>;
  /** Forget one cached key, or (with no argument) all of them. In-flight reads are unaffected. */
  invalidate(key?: K): void;
  /**
   * Record a value read by some other path, so the next `load` is free.
   *
   * ⚠️ Only for a value that came from the SAME chain read this loader would have done. Priming with
   * something optimistic is how a cache starts lying.
   */
  prime(key: K, value: V): void;
}

export interface BatchLoaderOptions<K, V> {
  /**
   * Read every key in one call.
   *
   * ⚠️ MUST RETURN ONE SLOT PER KEY, IN THE ORDER GIVEN. `undefined` in a slot means *absent* —
   * that key alone fails and every other key in the batch still resolves. A short array is treated
   * the same way for its missing tail. This is the "one bad entry does not sink the page" rule, and
   * it is the whole reason a batch read is allowed to replace a loop at all.
   */
  fetch: (keys: K[]) => Promise<ReadonlyArray<V | undefined>>;
  /** Identity for de-duplication and caching. Defaults to `String(key)`; addresses want lowercase. */
  keyOf?: (key: K) => string;
  /** Keys per call. Defaults to 50; a longer queue is split into several calls, all still batched. */
  maxBatch?: number;
  /**
   * How long a resolved value stays fresh, in ms. **0 (the default) disables caching entirely** and
   * leaves only the batching — which is what a vote tally wants, since voting changes it.
   */
  ttlMs?: number;
  /** Injectable clock. ⚠️ Never freeze it. */
  now?: () => number;
  /** Injectable scheduler. Defaults to `queueMicrotask`, which is the tick a `Promise.all` map fills. */
  schedule?: (flush: () => void) => void;
  /** The message for an absent slot. Defaults to something that names the key and the batch size. */
  missingMessage?: (key: K) => string;
}

/**
 * The batch came back without this key's slot.
 *
 * ⭐ A DISTINCT TYPE BECAUSE ABSENT IS NOT FAILED, AND THE DIFFERENCE IS ACTIONABLE. A call that
 * failed — no reader, a revert, a timeout — is worth a console line, because something is wrong. A
 * slot that simply was not returned is a normal answer on some backends: `?backend=fake` answers
 * every `tuple[]` with `[]` on purpose ("it invents no content"), so on the fake every key in every
 * batch is absent, and logging that once per row would bury the fake scenario in fifty errors per
 * paint. Callers that already have a representation for "nothing to show" use
 * {@link isBatchEntryMissing} to stay quiet about it.
 *
 * ⛔ It is still a REJECTION, not a resolved default. Handing back a zero would be the "missing
 * reply count is 0" lie this codebase keeps refusing to tell.
 */
export class BatchEntryMissingError extends Error {
  /** The `keyOf` identity that had no slot. */
  readonly batchKey: string;

  constructor(message: string, batchKey: string) {
    super(message);
    this.name = "BatchEntryMissingError";
    this.batchKey = batchKey;
  }
}

/** True when a read failed because the batch had no slot for it, rather than because it broke. */
export function isBatchEntryMissing(error: unknown): error is BatchEntryMissingError {
  return error instanceof BatchEntryMissingError;
}

interface Waiter<V> {
  resolve: (value: V) => void;
  reject: (error: unknown) => void;
}

interface QueueEntry<K, V> {
  id: string;
  key: K;
  waiters: Array<Waiter<V>>;
}

export function createBatchLoader<K, V>(options: BatchLoaderOptions<K, V>): BatchLoader<K, V> {
  const keyOf = options.keyOf ?? ((key: K) => String(key));
  const maxBatch = Math.max(1, Math.floor(options.maxBatch ?? 50));
  const ttlMs = Math.max(0, options.ttlMs ?? 0);
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? ((flush: () => void) => queueMicrotask(flush));

  const cache = new Map<string, { value: V; at: number }>();
  /** Keys waiting for the next flush, in arrival order, one entry per distinct key. */
  let queue: Array<QueueEntry<K, V>> = [];
  const queued = new Map<string, QueueEntry<K, V>>();
  let scheduled = false;

  async function run(entries: Array<QueueEntry<K, V>>): Promise<void> {
    try {
      const values = await options.fetch(entries.map((entry) => entry.key));
      entries.forEach((entry, index) => {
        const value = index < values.length ? values[index] : undefined;
        if (value === undefined) {
          // ⛔ ABSENT IS NOT EMPTY. This key alone fails; the rest of the batch has already been (or
          // is about to be) resolved by this same loop. The caller decides what an absent answer
          // means — `useForumThread` renders no name, `useForumThread.replyCounts` leaves the key
          // out of the map rather than inventing a 0.
          const message =
            options.missingMessage?.(entry.key) ??
            `the batch read returned no entry for "${entry.id}" (${entries.length} requested)`;
          const error = new BatchEntryMissingError(message, entry.id);
          for (const waiter of entry.waiters) waiter.reject(error);
          return;
        }
        if (ttlMs > 0) cache.set(entry.id, { value, at: now() });
        for (const waiter of entry.waiters) waiter.resolve(value);
      });
    } catch (error) {
      // The whole call failed — no reader, a revert, a timeout. Every key in it fails, which is
      // exactly what the per-item loop did when the transport was down. ⚠️ Nothing is cached: the
      // next `load` retries rather than remembering a failure.
      for (const entry of entries) {
        for (const waiter of entry.waiters) waiter.reject(error);
      }
    }
  }

  function flush(): void {
    scheduled = false;
    const batch = queue;
    queue = [];
    queued.clear();
    for (let i = 0; i < batch.length; i += maxBatch) {
      void run(batch.slice(i, i + maxBatch));
    }
  }

  return {
    load(key: K): Promise<V> {
      const id = keyOf(key);

      if (ttlMs > 0) {
        const hit = cache.get(id);
        if (hit) {
          if (now() - hit.at < ttlMs) return Promise.resolve(hit.value);
          // Expired. Dropped rather than left to be overwritten, so a failed refresh cannot serve a
          // value the TTL already said was too old.
          cache.delete(id);
        }
      }

      let entry = queued.get(id);
      if (!entry) {
        entry = { id, key, waiters: [] };
        queued.set(id, entry);
        queue.push(entry);
      }
      const pending = entry;
      const promise = new Promise<V>((resolve, reject) => {
        pending.waiters.push({ resolve, reject });
      });

      if (!scheduled) {
        scheduled = true;
        schedule(flush);
      }
      return promise;
    },

    invalidate(key?: K): void {
      if (key === undefined) cache.clear();
      else cache.delete(keyOf(key));
    },

    prime(key: K, value: V): void {
      if (ttlMs > 0) cache.set(keyOf(key), { value, at: now() });
    },
  };
}

/**
 * Line a decoded batch return up against the keys that were asked for.
 *
 * ⭐ THE RULE IT ENCODES: **a short or gappy result must lose only its own entries.** All four batch
 * getters are documented to return one slot per input, in order (`PostRegistry.headsOf`: "Writers
 * with no head come back with `movedAt == 0` rather than being skipped, so the result lines up
 * index-for-index with the input"). If one ever does not, the tail becomes `undefined` — absent —
 * and the loader fails those keys alone rather than throwing the page away.
 *
 * ⚠️ A NON-ARRAY RETURN THROWS, and that is deliberate. It is not "one missing profile", it is the
 * decoding having changed shape underneath us — the same class of silent bug `normaliseCallResult`
 * exists to prevent, where `refs` quietly became `undefined` and a full board read as empty. Loud
 * beats plausible.
 */
export function alignBatch<T>(value: unknown, count: number, method: string): Array<T | undefined> {
  if (!Array.isArray(value)) {
    throw new Error(
      `${method} did not decode to an array (got ${value === null ? "null" : typeof value}). ` +
        "The ABI says it returns one entry per input; a different shape means the decoding changed.",
    );
  }
  const slots: Array<T | undefined> = [];
  for (let i = 0; i < count; i++) {
    slots.push(i < value.length ? (value[i] as T) : undefined);
  }
  return slots;
}

/* ══════════════════════════════════════════ decoders for the batch getters ══
 *
 * Pure, so the shape each deployed getter actually returns is pinned by `npm run test:lib` rather
 * than discovered on a phone. ⚠️ TYPE-ONLY IMPORTS from `types/contracts` — a value import without a
 * file extension cannot be resolved by bare Node ESM, which is what runs these tests.
 *
 * Signatures verified against `frontend/src/contracts/*.json` AND the Solidity, 2026-07-31:
 *   UserRegistry.getProfiles(address[] owners)              -> Profile[]   result
 *   Voting.getTallies(bytes32[] entityIds)                  -> VoteTally[] result
 *   Voting.getUserVotes(bytes32[] entityIds, address user)  -> uint8[]     result
 *   PostRegistry.headsOf(bytes32 registry, address[])       -> HeadRef[]   refs      (no caller yet)
 */

/** True for something viem decoded a `tuple` into. A slot that is not one is treated as absent. */
function isStruct(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `UserRegistry.getProfiles` → one `Profile` per requested owner.
 *
 * ⚠️ `exists: false` IS A VALUE. The contract returns a zeroed struct for an address that never made
 * a profile — the same thing single `getProfile` returned — and that is a legitimate answer, cached
 * and rendered as "no name". Only a slot the call did not return is `undefined`, i.e. absent.
 */
export function decodeProfiles(value: unknown, count: number): Array<Profile | undefined> {
  return alignBatch<unknown>(value, count, "getProfiles").map((entry) =>
    isStruct(entry)
      ? {
          owner: String(entry.owner ?? ""),
          displayName: String(entry.displayName ?? ""),
          bio: String(entry.bio ?? ""),
          exists: entry.exists === true,
        }
      : undefined,
  );
}

/**
 * `Voting.getTallies` → one `VoteTally` per entity id.
 *
 * ⭐ `score` IS COMPUTED, NOT READ. `Voting.getScore` is exactly
 * `int256(tally.upvotes) - int256(tally.downvotes)` (`contracts/Voting.sol:180`), so reading it was
 * a second round trip to subtract two numbers already in hand. `uint256` arrives as `bigint`, hence
 * the `Number()`.
 */
export function decodeTallies(value: unknown, count: number): Array<VoteTally | undefined> {
  return alignBatch<unknown>(value, count, "getTallies").map((entry) => {
    if (!isStruct(entry)) return undefined;
    const upvotes = Number(entry.upvotes ?? 0);
    const downvotes = Number(entry.downvotes ?? 0);
    if (!Number.isFinite(upvotes) || !Number.isFinite(downvotes)) return undefined;
    return { upvotes, downvotes, score: upvotes - downvotes };
  });
}

/**
 * `Voting.getUserVotes` → one `VoteType` per entity id, for the ONE account the call named.
 *
 * ⚠️ `VoteType.None` is `0`, a real answer and not the absent sentinel — "this person has not voted"
 * must not be confused with "we did not get an answer for this entity".
 */
export function decodeUserVotes(value: unknown, count: number): Array<VoteType | undefined> {
  return alignBatch<unknown>(value, count, "getUserVotes").map((entry) => {
    if (entry === undefined || entry === null) return undefined;
    const vote = Number(entry);
    if (!Number.isFinite(vote)) return undefined;
    return vote as VoteType;
  });
}
