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
import { FORUM_REGISTRY } from "../lib/registry";
import { NO_WRITE_SESSION } from "../lib/publish";
import { usePublisher } from "./usePublisher";
import { gatewayFetcher } from "../lib/gateways";

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
}

interface UseForumThreadReturn {
  threads: ForumThread[];
  isLoading: boolean;
  error: string | null;
  threadCount: number;

  createThread: (title: string, content: string, tags: string[]) => Promise<number>;
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
}: UseForumThreadProps): UseForumThreadReturn {
  // `null` when this session cannot write. Not an error — see `usePublisher`.
  const publisher = usePublisher();
  const [threads, setThreads] = useState<ForumThread[]>([]);
  const [threadCount, setThreadCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pollIntervalRef = useRef<number | null>(null);
  const hasAttemptedDisplayNameFetch = useRef(false);

  // One cache per hook instance, persisted in the browser. Bodies are immutable and content-addressed,
  // so a cache hit can never be stale — only absent.
  const cache = useMemo(
    () => createBlobCache({ fetcher: gatewayFetcher(), persist: browserPersistence() }),
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

  const loadThreads = useCallback(async () => {
    const contract = getReadContract();
    if (!contract) {
      setThreads([]);
      setThreadCount(0);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      // Sorted newest-first. Cost grows with the writer set, not the post count — one head per writer.
      const [refs, total] = await contract.getHeadsPaged(FORUM_REGISTRY, 0, 50);
      setThreadCount(Number(total));

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

      if (heads.length === 0) {
        setThreads([]);
        return;
      }

      const page = await walkChain({ heads, cache, limit: 50 });

      // `walkChain` decodes for us — `entry.object` is already a DecodedObject or null for a hole.
      const formatted = await Promise.all(
        page.entries.map((entry, i) =>
          toForumThread(entry.object, entry.author ?? "", entry.at ?? null, i, entry.cid)
        )
      );

      setThreads(formatted);
    } catch (err) {
      console.error("Failed to load threads:", err);
      setError(err instanceof Error ? err.message : "Failed to load threads");
    } finally {
      setIsLoading(false);
    }
  }, [getReadContract, toForumThread, cache]);

  /**
   * ⚠️ Selection is by POSITION in the loaded page, not by a stable on-chain index — there is no
   * index any more, only CIDs. A thread's position can therefore change when someone else posts.
   * Deep links should move to `?cid=` when the detail view is migrated.
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
    async (title: string, content: string, tags: string[]): Promise<number> => {
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
      const { confirmed } = await publisher.publish({
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

      await loadThreads();
      if (!confirmed) {
        // The write went through — the head move returned a transaction hash — but the read RPC had
        // not caught up. Saying so beats a silent list that has not changed yet.
        throw new Error(
          "Your thread was submitted, but it has not shown up in a read yet. It should appear " +
            "within a minute; the list refreshes on its own."
        );
      }
      return 0;
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
      loadThreads();
    } else {
      setThreads([]);
      setThreadCount(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forumThreadAddress, provider]);

  useEffect(() => {
    hasAttemptedDisplayNameFetch.current = false;
  }, [userRegistryAddress]);

  useEffect(() => {
    if (!forumThreadAddress || !provider || !getDisplayName) return;
    if (threads.length === 0) return;
    if (hasAttemptedDisplayNameFetch.current) return;
    if (threads.some((t) => !t.displayName) && userRegistryAddress) {
      hasAttemptedDisplayNameFetch.current = true;
      loadThreads();
    }
  }, [forumThreadAddress, provider, getDisplayName, userRegistryAddress, threads, loadThreads]);

  // Polling, NOT log subscriptions. `eth_getLogs` cannot see events from host-submitted contract
  // calls — the host submits native `Revive` extrinsics, which emit `Revive.ContractEmitted` in
  // `System.Events` and nothing in the ETH log index. Do not "modernise" this.
  useEffect(() => {
    if (!forumThreadAddress || !provider) return;
    pollIntervalRef.current = window.setInterval(() => void loadThreads(), 30000);
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [forumThreadAddress, provider, loadThreads]);

  return {
    threads,
    isLoading,
    error,
    threadCount,
    createThread,
    editThread,
    deleteThread,
    refresh: loadThreads,
    getThread,
    loadByAuthor,
  };
}
