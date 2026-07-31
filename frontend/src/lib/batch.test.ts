// Run: node --experimental-strip-types --test src/lib/batch.test.ts
//
// Two things are pinned here, and the second one is the one that would hurt:
//
//  1. THE COALESCING. Asks made in one tick become ONE call, duplicates are read once, and a queue
//     longer than `maxBatch` splits into several calls with every key still answered. This is the
//     entire read-count saving; if it silently stops working the app still renders and simply costs
//     what it used to.
//  2. ⭐ THE DEGRADATION RULE: **one missing entry must not sink the page.** The loop this replaced
//     failed one row at a time — a profile that could not be read cost that row its name and nothing
//     else. A batch that threw the whole page away on one bad slot would be a worse app wearing a
//     performance win, so the rule is tested from both sides: a short result, and a gap in the
//     middle of one.
//
// ⚠️ NO FROZEN CLOCKS. The TTL tests hand-advance a counter; a `() => 0` clock hung a test in this
// repo indefinitely. Nothing here waits on a real timer either — the scheduler is injected, so a
// flush happens exactly when the test says it does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  alignBatch,
  createBatchLoader,
  decodeProfiles,
  decodeTallies,
  decodeUserVotes,
  isBatchEntryMissing,
} from "./batch.ts";

/** A scheduler the test drives by hand, so "one tick" is a thing that can be asserted about. */
function manualScheduler() {
  const pending: Array<() => void> = [];
  return {
    schedule: (flush: () => void) => void pending.push(flush),
    /** Run every flush queued so far. Returns how many ran. */
    tick() {
      const due = pending.splice(0, pending.length);
      for (const flush of due) flush();
      return due.length;
    },
  };
}

/** An advancing clock. ⚠️ Never frozen — `advance` is the only way it moves, and it only moves up. */
function clock(start = 1_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

/* ────────────────────────────────────────────────────────────── coalescing ── */

test("asks made in one tick become one call", async () => {
  const scheduler = manualScheduler();
  const calls: string[][] = [];
  const loader = createBatchLoader<string, string>({
    schedule: scheduler.schedule,
    fetch: async (keys) => {
      calls.push([...keys]);
      return keys.map((k) => `${k}!`);
    },
  });

  const promises = [loader.load("a"), loader.load("b"), loader.load("c")];
  assert.deepEqual(calls, [], "nothing may be read before the flush");
  scheduler.tick();

  assert.deepEqual(await Promise.all(promises), ["a!", "b!", "c!"]);
  assert.equal(calls.length, 1, "three asks, one call — this IS the saving");
  assert.deepEqual(calls[0], ["a", "b", "c"]);
});

test("the same key asked for twice in one tick is read once and shared", async () => {
  const scheduler = manualScheduler();
  const calls: string[][] = [];
  const loader = createBatchLoader<string, string>({
    keyOf: (address) => address.toLowerCase(),
    schedule: scheduler.schedule,
    fetch: async (keys) => {
      calls.push([...keys]);
      return keys.map((k) => `name(${k})`);
    },
  });

  // ⭐ The realistic case: one author wrote three of the fifty rows, and the chain spells their
  // address differently in the head row and in the object they signed.
  const promises = [loader.load("0xAB"), loader.load("0xab"), loader.load("0xCD")];
  scheduler.tick();
  const [first, second, third] = await Promise.all(promises);

  assert.deepEqual(calls[0], ["0xAB", "0xCD"], "the second spelling must not become a second slot");
  assert.equal(first, second);
  assert.equal(third, "name(0xCD)");
});

test("a queue longer than maxBatch splits, and every key is still answered", async () => {
  const scheduler = manualScheduler();
  const calls: number[][] = [];
  const loader = createBatchLoader<number, number>({
    maxBatch: 2,
    schedule: scheduler.schedule,
    fetch: async (keys) => {
      calls.push([...keys]);
      return keys.map((k) => k * 10);
    },
  });

  const promises = [1, 2, 3, 4, 5].map((n) => loader.load(n));
  scheduler.tick();

  assert.deepEqual(await Promise.all(promises), [10, 20, 30, 40, 50]);
  assert.deepEqual(calls, [[1, 2], [3, 4], [5]]);
});

test("a later tick is a new batch, not an addition to the last one", async () => {
  const scheduler = manualScheduler();
  const calls: string[][] = [];
  const loader = createBatchLoader<string, string>({
    schedule: scheduler.schedule,
    fetch: async (keys) => {
      calls.push([...keys]);
      return keys.map((k) => k);
    },
  });

  const first = loader.load("a");
  scheduler.tick();
  await first;
  const second = loader.load("b");
  scheduler.tick();
  await second;

  assert.deepEqual(calls, [["a"], ["b"]]);
});

/* ─────────────────────────────────────── one bad entry does not sink a page ── */

test("a missing entry fails ONLY its own key — the rest of the page still resolves", async () => {
  const scheduler = manualScheduler();
  const loader = createBatchLoader<string, string>({
    schedule: scheduler.schedule,
    // The middle slot came back absent. Everything either side is perfectly good data.
    fetch: async (keys) => keys.map((k) => (k === "broken" ? undefined : `ok:${k}`)),
  });

  const good = loader.load("a");
  const bad = loader.load("broken");
  const alsoGood = loader.load("b");
  scheduler.tick();

  assert.equal(await good, "ok:a");
  assert.equal(await alsoGood, "ok:b");
  await assert.rejects(() => bad, /no entry for "broken"/);
});

test("a SHORT result loses only its missing tail", async () => {
  const scheduler = manualScheduler();
  const loader = createBatchLoader<string, string>({
    schedule: scheduler.schedule,
    // Two answers for three questions — the third is absent, not zero and not the second's value.
    fetch: async () => ["one", "two"],
  });

  const a = loader.load("a");
  const b = loader.load("b");
  const c = loader.load("c");
  scheduler.tick();

  assert.equal(await a, "one");
  assert.equal(await b, "two");
  await assert.rejects(() => c, /no entry for "c"/);
});

test("absent and broken are DIFFERENT errors, so a caller can be quiet about one", async () => {
  // ⭐ Why this matters: `?backend=fake` answers every `tuple[]` with `[]` on purpose, so on the
  // fake EVERY key is absent. If that were indistinguishable from a real failure, `useVoting` would
  // log fifty console errors per paint in the scenario the fake exists to test.
  const scheduler = manualScheduler();
  const absent = createBatchLoader<string, string>({
    schedule: scheduler.schedule,
    fetch: async () => [], // exactly what the fake reader returns for a `tuple[]`
  });
  const broken = createBatchLoader<string, string>({
    schedule: scheduler.schedule,
    fetch: async () => {
      throw new Error("the host refused");
    },
  });

  const missing = absent.load("a");
  const failed = broken.load("a");
  scheduler.tick();

  await missing.then(
    () => assert.fail("an absent slot must not resolve"),
    (err) => assert.ok(isBatchEntryMissing(err), "an absent slot must be tagged as absent"),
  );
  await failed.then(
    () => assert.fail("a broken call must not resolve"),
    (err) => assert.ok(!isBatchEntryMissing(err), "a broken call must NOT read as merely absent"),
  );
});

test("a whole failed call fails every key in it, and caches nothing", async () => {
  const scheduler = manualScheduler();
  const time = clock();
  let attempt = 0;
  const loader = createBatchLoader<string, string>({
    schedule: scheduler.schedule,
    ttlMs: 60_000,
    now: time.now,
    fetch: async (keys) => {
      attempt += 1;
      if (attempt === 1) throw new Error("the host refused");
      return keys.map((k) => `ok:${k}`);
    },
  });

  const first = [loader.load("a"), loader.load("b")];
  scheduler.tick();
  await assert.rejects(() => first[0], /the host refused/);
  await assert.rejects(() => first[1], /the host refused/);

  // ⛔ A failure must not be remembered. The next ask retries rather than serving the error forever.
  const retry = loader.load("a");
  scheduler.tick();
  assert.equal(await retry, "ok:a");
});

/* ─────────────────────────────────────────────────────── caching and its TTL ── */

test("inside the TTL a cached key costs no call at all", async () => {
  const scheduler = manualScheduler();
  const time = clock();
  let calls = 0;
  const loader = createBatchLoader<string, string>({
    schedule: scheduler.schedule,
    ttlMs: 60_000,
    now: time.now,
    fetch: async (keys) => {
      calls += 1;
      return keys.map((k) => `v1:${k}`);
    },
  });

  const first = loader.load("a");
  scheduler.tick();
  assert.equal(await first, "v1:a");

  time.advance(59_000);
  assert.equal(await loader.load("a"), "v1:a");
  assert.equal(scheduler.tick(), 0, "a cache hit must not even schedule a flush");
  assert.equal(calls, 1);
});

test("past the TTL it reads again, so a renamed user is not stuck forever", async () => {
  const scheduler = manualScheduler();
  const time = clock();
  let version = 1;
  const loader = createBatchLoader<string, string>({
    schedule: scheduler.schedule,
    ttlMs: 60_000,
    now: time.now,
    fetch: async (keys) => keys.map((k) => `v${version}:${k}`),
  });

  const first = loader.load("a");
  scheduler.tick();
  await first;

  version = 2;
  time.advance(60_001);
  const second = loader.load("a");
  scheduler.tick();
  assert.equal(await second, "v2:a");
});

test("invalidate forces the next ask back onto the chain", async () => {
  const scheduler = manualScheduler();
  const time = clock();
  let version = 1;
  const loader = createBatchLoader<string, string>({
    keyOf: (address) => address.toLowerCase(),
    schedule: scheduler.schedule,
    ttlMs: 60_000,
    now: time.now,
    fetch: async (keys) => keys.map((k) => `v${version}:${k}`),
  });

  const first = loader.load("0xAB");
  scheduler.tick();
  await first;

  version = 2;
  // ⭐ What a profile write does — and note the different casing, which must still hit the entry.
  loader.invalidate("0xab");
  const second = loader.load("0xAB");
  scheduler.tick();
  assert.equal(await second, "v2:0xAB", "an edit must be visible immediately, not in 60 seconds");
});

test("prime records a value read by another path, and load then costs nothing", async () => {
  const scheduler = manualScheduler();
  const time = clock();
  let calls = 0;
  const loader = createBatchLoader<string, string>({
    schedule: scheduler.schedule,
    ttlMs: 60_000,
    now: time.now,
    fetch: async (keys) => {
      calls += 1;
      return keys.map((k) => `fetched:${k}`);
    },
  });

  loader.prime("me", "own profile");
  assert.equal(await loader.load("me"), "own profile");
  assert.equal(calls, 0);
});

test("with no TTL there is batching but no memory — a tally is never stale", async () => {
  const scheduler = manualScheduler();
  let version = 1;
  const loader = createBatchLoader<string, string>({
    schedule: scheduler.schedule,
    fetch: async (keys) => keys.map((k) => `v${version}:${k}`),
  });

  const first = loader.load("a");
  scheduler.tick();
  await first;

  version = 2;
  const second = loader.load("a");
  scheduler.tick();
  assert.equal(await second, "v2:a", "a vote changes the tally; caching it would show the old one");
});

/* ────────────────────────────────────────────────────────────── alignBatch ── */

test("alignBatch pads a short array with absent slots rather than shifting", () => {
  assert.deepEqual(alignBatch<string>(["a"], 3, "getProfiles"), ["a", undefined, undefined]);
});

test("alignBatch ignores extra entries the contract had no business returning", () => {
  assert.deepEqual(alignBatch<string>(["a", "b", "c"], 2, "getProfiles"), ["a", "b"]);
});

test("alignBatch THROWS on a non-array — a shape change is loud, not a page of absences", () => {
  // ⚠️ The failure mode this guards is `normaliseCallResult`'s: a decoding change that turns a whole
  // result into `undefined` and reads as "nobody has a profile" rather than as a bug.
  assert.throws(() => alignBatch(null, 2, "getProfiles"), /did not decode to an array/);
  assert.throws(() => alignBatch({ result: [] }, 2, "getTallies"), /did not decode to an array/);
});

/* ──────────────────────────────────────────── decoding the four ABI shapes ── */

test("decodeProfiles keeps exists:false as a VALUE, not an absence", () => {
  // What `UserRegistry.getProfiles` returns for [someone, nobody]: a zeroed struct for the second.
  const decoded = decodeProfiles(
    [
      { owner: "0xaaa", displayName: "alice", bio: "hi", exists: true },
      { owner: "0x0000000000000000000000000000000000000000", displayName: "", bio: "", exists: false },
    ],
    2,
  );

  assert.deepEqual(decoded[0], { owner: "0xaaa", displayName: "alice", bio: "hi", exists: true });
  assert.ok(decoded[1] !== undefined, "a zeroed profile is an ANSWER — the same one getProfile gave");
  assert.equal(decoded[1]!.exists, false);
});

test("decodeProfiles marks a slot that is not a struct as absent, and keeps its neighbours", () => {
  const decoded = decodeProfiles(
    [{ owner: "0xaaa", displayName: "alice", bio: "", exists: true }, null, { owner: "0xccc", displayName: "carol", bio: "", exists: true }],
    3,
  );
  assert.equal(decoded[0]?.displayName, "alice");
  assert.equal(decoded[1], undefined);
  assert.equal(decoded[2]?.displayName, "carol");
});

test("decodeTallies derives score locally and survives bigint", () => {
  // ⭐ `getScore` is exactly `int256(up) - int256(down)` on the contract, so reading it was a second
  // round trip to subtract two numbers already in hand. This is that subtraction.
  const decoded = decodeTallies(
    [
      { upvotes: 7n, downvotes: 2n },
      { upvotes: 0n, downvotes: 5n },
      { upvotes: 0n, downvotes: 0n },
    ],
    3,
  );
  assert.deepEqual(decoded[0], { upvotes: 7, downvotes: 2, score: 5 });
  assert.deepEqual(decoded[1], { upvotes: 0, downvotes: 5, score: -5 });
  assert.deepEqual(decoded[2], { upvotes: 0, downvotes: 0, score: 0 });
});

test("decodeTallies loses only the bad slot when one entry is malformed", () => {
  const decoded = decodeTallies([{ upvotes: 1n, downvotes: 0n }, "nonsense", { upvotes: 3n, downvotes: 1n }], 3);
  assert.equal(decoded[0]?.score, 1);
  assert.equal(decoded[1], undefined);
  assert.equal(decoded[2]?.score, 2);
});

test("decodeUserVotes keeps 0 (None) as an answer, not as an absence", () => {
  // ⚠️ The whole "absent is not empty" rule in one assertion: `VoteType.None === 0`, and a person
  // who has not voted is a fact, while a slot we never got back is not.
  const decoded = decodeUserVotes([0, 1, 2], 4);
  assert.equal(decoded[0], 0);
  assert.equal(decoded[1], 1);
  assert.equal(decoded[2], 2);
  assert.equal(decoded[3], undefined, "the fourth was never answered");
});

test("decodeUserVotes accepts the bigint spelling a uint8[] may decode to", () => {
  assert.deepEqual(decodeUserVotes([0n, 1n], 2), [0, 1]);
});

/* ═════════════════════════════════════════════ the ABI actually has these ══
 *
 * ⭐ THE MOST EXPENSIVE BUG IN THIS REPO, GUARDED DIRECTLY. Five times now a hook has called a
 * function the deployed contract does not have — `getEntityId`, `getThreadCount`,
 * `getUserPostCount`, `Replies.addReply`, and `addLink` with the wrong arity. A selector that
 * decodes to a missing function reverts with `execution reverted (no data present)`, which reads
 * like a broken contract rather than a wrong call, and every one of those cost real time.
 *
 * The ABIs in `src/contracts/` are HAND-COPIED after a contract change (root CLAUDE.md), so the way
 * this comes back is somebody pasting an older file. These assertions are cheap and they fail at
 * `npm run test:lib` instead of on a phone.
 *
 * ⚠️ WHAT THEY DO NOT PROVE: that the bytecode at the deployed address has them. That needs a chain.
 * The Solidity was read too (`contracts/UserRegistry.sol:435`, `Voting.sol:193`, `Voting.sol:214`,
 * `PostRegistry.sol:550`), which is the strongest evidence available without a device — so the
 * claim "these four batch getters are callable" is **[I]**, not **[V]**.
 */

const here = dirname(fileURLToPath(import.meta.url));

interface AbiFunction {
  type?: string;
  name?: string;
  inputs?: Array<{ type?: string }>;
  outputs?: Array<{ type?: string }>;
  stateMutability?: string;
}

function abiOf(contract: string): AbiFunction[] {
  const parsed = JSON.parse(readFileSync(join(here, "..", "contracts", `${contract}.json`), "utf8"));
  return (Array.isArray(parsed) ? parsed : parsed.abi) as AbiFunction[];
}

function fn(contract: string, name: string): AbiFunction {
  const entry = abiOf(contract).find((e) => e.type === "function" && e.name === name);
  assert.ok(
    entry,
    `${contract}.json has no ${name}. Calling it would revert as "execution reverted (no data ` +
      `present)", which reads like a broken contract rather than a wrong call — see ` +
      "frontend/CLAUDE.md's table of four.",
  );
  return entry!;
}

test("UserRegistry.getProfiles(address[]) -> tuple[] is in the shipped ABI", () => {
  const entry = fn("UserRegistry", "getProfiles");
  assert.deepEqual(entry.inputs?.map((i) => i.type), ["address[]"]);
  assert.deepEqual(entry.outputs?.map((o) => o.type), ["tuple[]"]);
  assert.equal(entry.stateMutability, "view");
});

test("Voting.getTallies(bytes32[]) -> tuple[] is in the shipped ABI", () => {
  const entry = fn("Voting", "getTallies");
  assert.deepEqual(entry.inputs?.map((i) => i.type), ["bytes32[]"]);
  assert.deepEqual(entry.outputs?.map((o) => o.type), ["tuple[]"]);
  assert.equal(entry.stateMutability, "view");
});

test("Voting.getUserVotes(bytes32[],address) -> uint8[] is in the shipped ABI", () => {
  const entry = fn("Voting", "getUserVotes");
  // ⚠️ THE ARGUMENT ORDER IS ids-THEN-user, and the single `getUserVote` is the other way round
  // (`entityId, user` — same order, different arity). The `addLink` bug was exactly this: a
  // plausible call that cannot be encoded.
  assert.deepEqual(entry.inputs?.map((i) => i.type), ["bytes32[]", "address"]);
  assert.deepEqual(entry.outputs?.map((o) => o.type), ["uint8[]"]);
});

test("PostRegistry.headsOf(bytes32,address[]) -> tuple[] is in the shipped ABI", () => {
  // ⚠️ VERIFIED BUT NOT YET USED, and that is recorded on purpose. `headsOf` batches over WRITERS
  // inside ONE registry. The only remaining per-item head loop in the app is
  // `useForumThread.loadReplyCounts`, which reads a DIFFERENT registry per thread
  // (`keccak256("thread:" + cid)`) — so this getter cannot collapse it, and no contract getter can.
  // Wiring it in anyway would have been a call site invented to justify a function.
  const entry = fn("PostRegistry", "headsOf");
  assert.deepEqual(entry.inputs?.map((i) => i.type), ["bytes32", "address[]"]);
  assert.deepEqual(entry.outputs?.map((o) => o.type), ["tuple[]"]);
});

/* ══════════════════════════════════════════════ the hooks use them ══ */

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const src = (...parts: string[]) => readFileSync(join(here, "..", ...parts), "utf8");

test("the profile read is the BATCH one, and the per-item loop is gone", () => {
  const body = code(src("hooks", "useUserRegistry.ts"));
  assert.match(body, /contract\.getProfiles\(/, "useUserRegistry no longer calls getProfiles");
  // `getProfile` (singular) survives in exactly two places on purpose — `loadProfile` and
  // `waitForProfile`, both read-after-write for the user's OWN profile, both deliberately
  // uncached. Anything more than that is the N-per-poll loop coming back.
  const singles = body.match(/contract\.getProfile\(/g) ?? [];
  assert.ok(
    singles.length <= 2,
    `useUserRegistry calls the single getProfile ${singles.length} times. Only the two ` +
      "read-after-write paths may; everything else goes through the batch loader.",
  );
});

test("Voting reads tallies and user votes in batches, and no longer reads getScore at all", () => {
  const body = code(src("hooks", "useVoting.ts"));
  assert.match(body, /contract\.getTallies\(/);
  assert.match(body, /contract\.getUserVotes\(/);
  // ⭐ `getScore` was a whole extra round trip to compute `upvotes - downvotes`, per card.
  assert.ok(
    !/getScore/.test(body),
    "useVoting reads getScore again. It is exactly int256(up) - int256(down) on the contract " +
      "(Voting.sol:180) — a second read to subtract two numbers already in hand.",
  );
});

test("getDisplayName's identity is STABLE — an empty dependency array, still", () => {
  // ⛔ THE REGRESSION THIS EXISTS FOR IS INVISIBLE. An unstable `getDisplayName` changes
  // `loadThreads`'s identity, which used to tear down and restart the 30-second interval on every
  // render — so the 30 seconds never elapsed and the poll silently never fired. Nothing errors; the
  // list simply stops updating. See useForumThread's `loadThreadsRef`.
  const body = src("App.tsx");
  const declaration = body.match(
    /const getDisplayName = useCallback\([\s\S]*?\n\s*\},\s*(\[[^\]]*\])\);/,
  );
  assert.ok(declaration, "App.tsx no longer declares getDisplayName as a useCallback");
  assert.equal(
    declaration![1].replace(/\s/g, ""),
    "[]",
    `getDisplayName has dependencies ${declaration![1]}. It must never change identity — the poll ` +
      "effect's stability depends on it, and the failure is a poll that never fires, with no error.",
  );
});
