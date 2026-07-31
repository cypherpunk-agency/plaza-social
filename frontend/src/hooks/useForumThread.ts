import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import type { ForumThread } from "../types/contracts";
import PostRegistryABI from "../contracts/PostRegistry.json";
import { createReadContract, type Provider, type Signer } from "../utils/contracts";
import { createBlobCache, browserPersistence } from "../lib/blob-cache";
import { walkChain } from "../lib/walk";
import {
  encodePost,
  encodeThread,
  excerptOf,
  validateThreadDraft,
  type DecodedObject,
} from "../lib/wire";
import { FORUM_REGISTRY, threadRegistryId } from "../lib/registry";
import { POLL_INTERVAL_MS, createRefreshGate, deepEqual, refresh, startPolling, type RefreshMode } from "../lib/poll";
import { NO_WRITE_SESSION } from "../lib/publish";
import { usePublisher } from "./usePublisher";
import { bulletinFetcher } from "../lib/bulletin";

/**
 * The forum, on the migrated content model.
 *
 * ⚠️ WHAT CHANGED, because the shape of this hook no longer matches its name.
 *
 * `ForumThread.sol` is gone. There is no per-forum contract and no `threads[]` array to index into.
 * A forum is a `bytes32` registry id inside the single `PostRegistry`, which stores exactly ONE head
 * pointer per (registry, writer). Thread bodies are immutable Bulletin objects chained backwards by
 * `prev`, so reading the forum is: read the heads on chain, then walk the chains off chain.
 *
 * That is why this file now composes two existing, separately-tested layers rather than calling a
 * contract getter per thread:
 *   PostRegistry.getHeadsPaged(registry)  ->  heads (cid + prev + storeBlock + author)
 *   walkChain({ heads, cache })           ->  decoded objects, oldest-safe, hole-tolerant
 *
 * WRITING A THREAD IS THREE STEPS, AND THE MIDDLE ONE IS EASY TO GET WRONG.
 *
 *   1. store the OPENING POST — a `post` object with the body, standalone, its own chain root
 *   2. store the ANNOUNCEMENT — a `thread` object carrying title/tags/excerpt and `opCid`, linked
 *      into this author's forum chain
 *   3. move the head — `PostRegistry.setHead(FORUM_REGISTRY, …, announcementCid, prev, 0)`
 *
 * ⚠️ A THREAD IS NOT A POST WITH A TITLE. The announcement has no body; it points at the opening
 * post's CID. That indirection is what makes cross-posting possible — N announcements, one body —
 * and it is why the excerpt rides on the announcement: a board then renders from ONE chain walk, and
 * a thread whose body has expired still shows what it was. See `lib/wire.ts` §2.
 *
 * The two signatures live in `lib/publish.ts`: body to Bulletin signed by the host, pointer to the
 * contract. Nothing here knows which signer does which.
 */

/**
 * Well-known open registry id. Open ids are `keccak256(name)` and can never be claimed.
 *
 * Defined in `lib/registry.ts` and re-exported here so existing importers need no change — a
 * registry id computed in two places is one that will eventually disagree with itself, and the
 * failure is silent: writes land in a chain nobody reads.
 */
export { FORUM_REGISTRY } from "../lib/registry";

/** Matches PostRegistry's `HeadRef` tuple. */
interface OnChainHead {
  cid: string;
  prev: string;
  storeBlock: bigint;
  movedAt: bigint;
  by: string;
  allowed: boolean;
}

interface UseForumThreadProps {
  /** The PostRegistry address. Named for the old contract so callers need no change. */
  forumThreadAddress: string | null;
  provider: Provider | null;
  signer?: Signer | null;
  getDisplayName?: (address: string) => Promise<string>;
  userRegistryAddress?: string | null;
  enabled?: boolean;
  /**
   * Walk every loaded thread's reply registry to produce {@link UseForumThreadReturn.replyCounts}.
   *
   * ⚠️ OPT-IN, AND DEFAULTS TO OFF, because it is the most expensive read this hook can do — see
   * `loadReplyCounts` and {@link REPLY_COUNT_THREADS}. It stays off until a caller actually renders
   * the number. The forum list dropped its `[+] REPLIES (n)` expander when the detail pane took over
   * replies, and an unread count is 25 chain walks plus their bodies, on a phone, for nothing.
   */
  countReplies?: boolean;
}

/**
 * How many threads get a reply count, and how deep each count walks.
 *
 * ⚠️ A reply count is NOT a cheap read. `getHeadsPaged` on the thread's reply registry gives one head
 * per REPLIER, not one per reply — the replies themselves hang off those heads in Bulletin chains, so
 * an accurate number means walking, which means fetching bodies. That is bounded here rather than
 * left open, because the primary surface is a phone: 50 threads × every reply body is not a load.
 */
const REPLY_COUNT_THREADS = 25;
const REPLY_COUNT_DEPTH = 50;

interface UseForumThreadReturn {
  threads: ForumThread[];
  /** True only for a COLD load — there is genuinely nothing to show yet. Safe to render a skeleton. */
  isLoading: boolean;
  /**
   * True while a BACKGROUND poll is in flight, with the previous list still on screen.
   *
   * ⚠️ NEVER unmount the list on this. It exists so a UI *can* show a subtle "updating" hint; the
   * whole point of the stale-while-revalidate rewrite (`lib/poll.ts`) is that the rows stay mounted.
   * Nothing is obliged to consume it.
   */
  isRefreshing: boolean;
  error: string | null;
  threadCount: number;
  /**
   * Replies per thread announcement CID, best effort.
   *
   * ⚠️ ABSENT MEANS "NOT COUNTED YET OR NOT COUNTABLE", NEVER "ZERO". It fills in after the list
   * paints, is capped to the first {@link REPLY_COUNT_THREADS} threads, and a failed read leaves the
   * key missing rather than inventing a 0. Render nothing for a missing key; a confident "0 replies"
   * over an unread registry is the same class of lie as an optimistic "Copied!".
   */
  replyCounts: Record<string, number>;

  /**
   * Publish a thread; resolves with the **announcement CID**, which is the thread's identity.
   *
   * ⚠️ IT USED TO RESOLVE WITH `0` — a leftover from `ForumThread.sol`, when a thread had an
   * on-chain index. There is no index any more (see the note on `ForumThread.index`: a position in
   * the loaded page, not an id), so the caller was left to identify what it had just written by
   * DIFFING the board before and after. `publisher.publish` has always returned the CID; it simply
   * was not propagated.
   *
   * A bare `string`, not `{ cid, confirmed }`, and that is deliberate: an unconfirmed publish
   * THROWS below rather than resolving, so `confirmed` on a resolved call could only ever be `true`.
   * Handing the caller a flag it cannot act on invites a branch that can never run.
   */
  createThread: (title: string, content: string, tags: string[]) => Promise<string>;
  editThread: (threadIndex: number, newContent: string) => Promise<void>;
  deleteThread: (threadIndex: number) => Promise<void>;
  refresh: () => Promise<void>;

  getThread: (threadIndex: number) => Promise<ForumThread | null>;
  loadByAuthor: (author: string, count?: number) => Promise<ForumThread[]>;
}

export function useForumThread({
  forumThreadAddress,
  provider,
  getDisplayName,
  userRegistryAddress,
  countReplies = false,
}: UseForumThreadProps): UseForumThreadReturn {
  // `null` when this session cannot write. Not an error — see `usePublisher`.
  const publisher = usePublisher();
  const [threads, setThreads] = useState<ForumThread[]>([]);
  const [threadCount, setThreadCount] = useState(0);
  const [replyCounts, setReplyCounts] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasAttemptedDisplayNameFetch = useRef(false);

  /**
   * The last committed list, mirrored into a ref.
   *
   * ⚠️ THE EQUALITY SKIP MUST READ THIS, NOT `threads`. A `useCallback` closes over the `threads` of
   * the render that created it, so comparing against the state value would compare against data from
   * an earlier poll and commit a "change" that is not one. Everything that writes `threads` goes
   * through `commitThreads` so the two can never drift.
   */
  const threadsRef = useRef<ForumThread[]>([]);
  const commitThreads = useCallback((next: ForumThread[]) => {
    threadsRef.current = next;
    setThreads(next);
    // `threads.length` is what we actually walked, and is the honest count — see `loadThreads`.
    setThreadCount(next.length);
  }, []);

  /**
   * Orders concurrent refreshes so a slow one cannot overwrite a newer one. Without it: the 30s poll
   * starts fetching, the user publishes a thread, the post-write reload commits it — and then the
   * poll's PRE-WRITE snapshot resolves and rolls the board back, silently, for up to 30 seconds.
   * See `lib/poll.ts` § RefreshGate.
   */
  const gate = useMemo(() => createRefreshGate(), []);

  // One cache per hook instance, persisted in the browser. Bodies are immutable and content-addressed,
  // so a cache hit can never be stale — only absent.
  //
  // ⚠️ `bulletinFetcher()` reads through the HOST, not over HTTP — see `lib/bulletin.ts`. It resolves
  // the installed source per call, which is why building it here (before the container handshake has
  // finished) is safe. Do not re-add a URL-based fetcher: that is what made the host prompt the user
  // for permission to reach a public IPFS gateway.
  const cache = useMemo(
    () => createBlobCache({ fetcher: bulletinFetcher(), persist: browserPersistence() }),
    []
  );

  const getReadContract = useCallback(
    () => createReadContract(forumThreadAddress, PostRegistryABI.abi, provider),
    [forumThreadAddress, provider]
  );

  /** Turn one decoded Bulletin object into the shape the forum UI already renders. */
  const toForumThread = useCallback(
    async (
      decoded: DecodedObject | null,
      author: string,
      at: number | null,
      index: number,
      cid: string
    ): Promise<ForumThread> => {
      let displayName: string | undefined;
      if (getDisplayName && author) {
        try {
          displayName = await getDisplayName(author);
        } catch {
          displayName = undefined;
        }
      }

      // A hole: the body has expired from Bulletin or no gateway would serve it. The pointer is still
      // on chain, so the thread is real — it is the CONTENT that is gone, and saying "deleted" would
      // be wrong. Retention expiry is the only deletion mechanism this design has (architecture §4a).
      if (!decoded) {
        return {
          index,
          cid,
          opCid: "",
          author,
          sender: author,
          title: "(content no longer available)",
          content:
            "This post's body has expired from Bulletin storage. The pointer to it is still on " +
            "chain. Renewing the object would restore it.",
          timestamp: at ?? 0,
          editedAt: null,
          isDeleted: false,
          tags: [],
          displayName,
        };
      }

      // ⚠️ The four payload kinds carry DIFFERENT fields, and that is the content model, not an
      // oversight (architecture §2: one envelope, discriminated payloads). A `thread` is the
      // title/metadata object and has NO body — its opening text lives in a separate `post` reached
      // via `opCid`, and `excerpt` is the precomputed preview a list like this actually wants. A chat
      // `msg` has a body and no title, because a chat comment has no title.
      const title =
        decoded.kind === "thread"
          ? decoded.title
          : decoded.kind === "dir"
            ? decoded.name
            : `${cid.slice(0, 12)}…`;

      const content =
        decoded.kind === "thread"
          ? decoded.excerpt
          : decoded.kind === "msg" || decoded.kind === "post"
            ? decoded.body
            : decoded.kind === "dir"
              ? decoded.topic
              : "";

      return {
        index,
        cid,
        // Only a `thread` announcement points at an opening post. A bare `post` or `msg` at the head
        // of a forum chain IS its own body, so it is its own op.
        opCid: decoded.kind === "thread" ? decoded.opCid : cid,
        // `decoded.author` is what the object itself claims; `author` is the chain's attribution from
        // the head row. Prefer the object, fall back to the index — but note the chain is the one that
        // is actually authenticated.
        author: decoded.author || author,
        sender: author,
        title: title || "(untitled)",
        content: content || "",
        timestamp: decoded.at ?? at ?? 0,
        editedAt: null,
        isDeleted: false,
        tags: decoded.kind === "thread" ? decoded.tags : [],
        displayName,
      };
    },
    [getDisplayName, userRegistryAddress]
  );

  /**
   * The FETCH half: reads the chain and returns a list. It touches no state and announces nothing.
   *
   * Keeping it pure is what lets `lib/poll.ts` decide whether this load is allowed to blank the
   * screen. The old shape — one function that set `isLoading` and `[]` before fetching, re-entered
   * by a 30-second interval — is exactly the reported flicker.
   */
  const fetchThreads = useCallback(async (): Promise<ForumThread[]> => {
    const contract = getReadContract();
    if (!contract) return [];

    // ⚠️ `total` IS THE WRITER COUNT, NOT THE THREAD COUNT, and it was being reported as the
    // latter. `getHeadsPaged` returns `(refs, total)` where `total = _writers[registry].length` —
    // one entry per person who has ever posted here, NOT one per thread. With a single author and
    // two threads it reads 1; with ten authors and one thread each it reads 10. It happens to be
    // invisible today because exactly one account has posted.
    //
    // There is no cheap on-chain thread count and there should not be: the model stores one head
    // per writer and the threads hang off it in a Bulletin chain, so counting them means walking.
    // `threads.length` is what we actually walked and is the honest number to show.
    const [refs] = await contract.getHeadsPaged(FORUM_REGISTRY, 0, 50);

    const heads = (refs as OnChainHead[])
      // A writer banned after the fact keeps their row; moderation is a write gate plus a hide
      // flag, never a delete, because freeing storage would refund the wrong person.
      .filter((ref) => ref.allowed && ref.cid)
      .map((ref) => ({
        cid: ref.cid,
        prev: ref.prev || null,
        at: ref.movedAt > 0n ? Number(ref.movedAt) * 1000 : null,
        by: ref.by,
        block: ref.storeBlock > 0n ? Number(ref.storeBlock) : null,
        index: null,
      }));

    // An empty board is a RESULT, not a failure — it is returned and diffed like any other, so a
    // poll that keeps finding nothing commits nothing and re-renders nothing.
    if (heads.length === 0) return [];

    const page = await walkChain({ heads, cache, limit: 50 });

    // `walkChain` decodes for us — `entry.object` is already a DecodedObject or null for a hole.
    return Promise.all(
      page.entries.map((entry, i) =>
        toForumThread(entry.object, entry.author ?? "", entry.at ?? null, i, entry.cid)
      )
    );
  }, [getReadContract, toForumThread, cache]);

  /**
   * The ANNOUNCE half. `mode` decides whether this load may blank the screen.
   *
   * - `"cold"` — nothing is on screen yet, so raise `isLoading` and let the empty state show.
   * - `"background"` — the 30-second poll. Keeps the current list up, raises `isRefreshing` instead,
   *   commits only if the data actually differs, and on failure keeps the last good list.
   *
   * ⛔ Never infer the mode from `threads.length === 0`; see `lib/poll.ts`.
   */
  const loadThreads = useCallback(
    async (mode: RefreshMode = "cold"): Promise<void> => {
      if (!getReadContract()) {
        // No address or provider yet. A cold entry shows the empty state; a background tick just
        // does nothing rather than blanking a list that is still perfectly good.
        if (mode === "cold") commitThreads([]);
        return;
      }
      await refresh<ForumThread[]>({
        mode,
        gate,
        sinks: {
          setData: commitThreads,
          setLoading: setIsLoading,
          setRefreshing: setIsRefreshing,
          setError,
        },
        load: fetchThreads,
        previous: () => threadsRef.current,
        message: (err) => (err instanceof Error ? err.message : "Failed to load threads"),
        onError: (err) => console.error("Failed to load threads:", err),
      });
    },
    [getReadContract, fetchThreads, commitThreads]
  );

  /**
   * Count the replies under each loaded thread, in the background, best effort.
   *
   * A thread's replies are their OWN open registry — `keccak256("thread:" + cid)`, derived only in
   * `lib/registry.ts` — so this is the same two-step every other read is: heads on chain, then walk
   * the chains off chain. It runs after the list has already painted, because a board that waits for
   * its reply counts is a board that shows nothing for several seconds on a phone.
   *
   * A thread whose count cannot be read is simply LEFT OUT of the map. See the return type.
   */
  const loadReplyCounts = useCallback(
    async (list: ForumThread[]): Promise<Record<string, number>> => {
      const contract = getReadContract();
      if (!contract) return {};

      const targets = list
        .filter((t) => !!t.cid && !t.isDeleted)
        .slice(0, REPLY_COUNT_THREADS);

      const results = await Promise.all(
        targets.map(async (thread): Promise<[string, number] | null> => {
          const registry = threadRegistryId(thread.cid);
          if (!registry) return null;
          try {
            const [refs] = await contract.getHeadsPaged(registry, 0, REPLY_COUNT_DEPTH);
            const heads = (refs as OnChainHead[])
              .filter((ref) => ref.allowed && ref.cid)
              .map((ref) => ({
                cid: ref.cid,
                prev: ref.prev || null,
                at: ref.movedAt > 0n ? Number(ref.movedAt) * 1000 : null,
                by: ref.by,
                block: ref.storeBlock > 0n ? Number(ref.storeBlock) : null,
                index: null,
              }));
            if (heads.length === 0) return [thread.cid, 0];
            const page = await walkChain({ heads, cache, limit: REPLY_COUNT_DEPTH });
            // Holes count: the pointer is on chain, so the reply exists — it is the BODY that is gone.
            return [thread.cid, page.entries.length];
          } catch {
            // Deliberately silent, and deliberately absent from the map rather than 0.
            return null;
          }
        })
      );

      return Object.fromEntries(results.filter((r): r is [string, number] => r !== null));
    },
    [getReadContract, cache]
  );

  /**
   * ⚠️ Selection is by POSITION in the loaded page, not by a stable on-chain index — there is no
   * index any more, only CIDs. A thread's position can therefore change when someone else posts.
   * Deep links use `?cid=`; see `lib/threadLink.ts`.
   */
  const getThread = useCallback(
    async (threadIndex: number): Promise<ForumThread | null> => threads[threadIndex] ?? null,
    [threads]
  );

  const loadByAuthor = useCallback(
    async (author: string): Promise<ForumThread[]> =>
      threads.filter((t) => t.author.toLowerCase() === author.toLowerCase()),
    [threads]
  );

  const createThread = useCallback(
    async (title: string, content: string, tags: string[]): Promise<string> => {
      if (!publisher) throw new Error(NO_WRITE_SESSION);

      // Validate BEFORE anything is stored. An over-budget title must be refused at the field that
      // can fix it, not after a Bulletin write has already been paid for.
      const draft = validateThreadDraft({ title, body: content, tags });
      const author = publisher.author;

      // 1 — the opening post. Its own chain root: it is the BODY, and the announcement below is what
      // joins the forum's chain. Storing it first means the announcement can point at a CID that
      // already exists.
      const opCid = await publisher.store(
        encodePost({ author, body: draft.body, registry: FORUM_REGISTRY }),
        cache
      );

      // 2 + 3 — the announcement, linked into this author's forum chain, then the head pointer.
      //
      // ⭐ `cid` IS THE THREAD. It is the announcement's CID: the row key the board renders, the
      // `?cid=` deep link, and the `keccak256(utf8(cid))` the vote tally is keyed on. Returning it
      // is what lets the caller select what was just written instead of inferring it.
      const { cid, confirmed } = await publisher.publish({
        registry: FORUM_REGISTRY,
        cache,
        label: "thread",
        build: (link) =>
          encodeThread({
            ...link,
            author,
            title: draft.title,
            tags: draft.tags,
            excerpt: excerptOf(draft.body),
            opCid,
            registry: FORUM_REGISTRY,
          }),
      });

      // BACKGROUND: the board is already on screen behind the composer, and the point of this read
      // is to add one row to it. A cold load here would empty the list the author just posted into.
      //
      // ⚠️ THIS RUNS BEFORE WE RESOLVE, so a caller reading `threads` after the `await` may ALREADY
      // see the new row. That ordering is why identifying the new thread by diffing the board was
      // fragile; selecting by the returned `cid` is immune to it, since the CID is the same whether
      // the row has landed yet or not.
      await loadThreads("background");
      if (!confirmed) {
        // The write went through — the head move returned a transaction hash — but the read did not
        // show it yet. Saying so beats a silent list that has not changed yet.
        //
        // ⚠️ CORRECTED 2026-07-31: this used to be blamed on "the read RPC" trailing the host,
        // which was a symptom of reads going through a separate public endpoint. They do not any
        // more — one chain client, `.query()` at `best`. The gap that remains is real but smaller:
        // a native extrinsic gives no receipt to await, so `publish()` can only re-read and see.
        throw new Error(
          "Your thread was submitted, but it has not shown up in a read yet. It should appear " +
            "within a minute; the list refreshes on its own."
        );
      }
      return cid;
    },
    [publisher, cache, loadThreads]
  );

  const editThread = useCallback(async (): Promise<void> => {
    // Bodies are immutable Bulletin objects. An "edit" is a NEW object with a new CID, which also
    // means a new, empty vote tally — deliberately, since a tally belongs to the bytes people voted
    // on. Publishing one is the same three steps `createThread` does; what is missing is the product
    // decision about what an edited thread should look like to someone who already replied to it.
    throw new Error(
      "Editing is not wired up yet. A Bulletin object cannot be changed, so an edit publishes a " +
        "replacement — and what that should do to existing replies and votes is not decided."
    );
  }, []);

  const deleteThread = useCallback(async (): Promise<void> => {
    throw new Error(
      "Deleting is not available, and will not work the way it used to: freeing storage refunds " +
        "whoever freed it, so a moderated delete would hand an admin the author's deposit. Content " +
        "goes away by stopping renewal instead."
    );
  }, []);

  useEffect(() => {
    if (forumThreadAddress && provider) {
      // COLD, and the only cold entry point: the address or the provider just changed, so whatever
      // is on screen belongs to a different chain and there is genuinely nothing to preserve.
      void loadThreads("cold");
    } else {
      commitThreads([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forumThreadAddress, provider]);

  useEffect(() => {
    hasAttemptedDisplayNameFetch.current = false;
  }, [userRegistryAddress]);

  /**
   * Reply counts, keyed on the SET of threads rather than on the array identity.
   *
   * The 30-second poll replaces `threads` with a fresh array every time, so depending on the array
   * would re-walk every reply chain twice a minute for no new information. The joined CID list only
   * changes when the board actually changes.
   */
  const threadCidKey = useMemo(() => threads.map((t) => t.cid).join(","), [threads]);
  useEffect(() => {
    // No consumer asked for counts — do not spend 25 chain walks producing a number nobody renders.
    if (!countReplies || !forumThreadAddress || !provider || threads.length === 0) {
      setReplyCounts({});
      return;
    }
    let cancelled = false;
    void loadReplyCounts(threads).then((counts) => {
      // Same rule as the list: an unchanged map is not handed to React. This loader was never on
      // the blanking path (it replaces on resolve and never clears first), but a fresh object with
      // identical contents still re-renders every consumer.
      if (!cancelled) setReplyCounts((prev) => (deepEqual(prev, counts) ? prev : counts));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forumThreadAddress, provider, threadCidKey, countReplies]);

  useEffect(() => {
    if (!forumThreadAddress || !provider || !getDisplayName) return;
    if (threads.length === 0) return;
    if (hasAttemptedDisplayNameFetch.current) return;
    if (threads.some((t) => !t.displayName) && userRegistryAddress) {
      hasAttemptedDisplayNameFetch.current = true;
      // BACKGROUND: the list is already painted and this pass only decorates it with names. A cold
      // re-entry here blanked the board a second time immediately after the first paint.
      void loadThreads("background");
    }
  }, [forumThreadAddress, provider, getDisplayName, userRegistryAddress, threads, loadThreads]);

  /**
   * Always call the LATEST loader through a ref.
   *
   * `loadThreads` changes identity whenever `getDisplayName` does, and an interval effect that
   * depends on it is torn down and restarted on every such render — which on an unstable
   * `getDisplayName` means the 30 seconds never elapse and the poll silently never fires. The ref
   * keeps the effect's dependencies down to the two things that should actually restart a poll.
   */
  const loadThreadsRef = useRef(loadThreads);
  useEffect(() => {
    loadThreadsRef.current = loadThreads;
  }, [loadThreads]);

  // Polling, NOT log subscriptions. `eth_getLogs` cannot see events from host-submitted contract
  // calls — the host submits native `Revive` extrinsics, which emit `Revive.ContractEmitted` in
  // `System.Events` and nothing in the ETH log index. Do not "modernise" this.
  //
  // ⛔ THE TICK IS ALWAYS `"background"`. Passing "cold" here — or, as this did until the flicker
  // was traced, calling a loader that only had the cold behaviour — empties the list and raises the
  // spinner twice a minute, for data that is almost always identical.
  useEffect(() => {
    if (!forumThreadAddress || !provider) return;
    return startPolling(() => void loadThreadsRef.current("background"), {
      intervalMs: POLL_INTERVAL_MS,
    });
  }, [forumThreadAddress, provider]);

  return {
    threads,
    isLoading,
    isRefreshing,
    error,
    threadCount,
    replyCounts,
    createThread,
    editThread,
    deleteThread,
    refresh: loadThreads,
    getThread,
    loadByAuthor,
  };
}
