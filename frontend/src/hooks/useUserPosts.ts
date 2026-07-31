import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { UserPost } from "../types/contracts";
import PostRegistryABI from "../contracts/PostRegistry.json";
import { createReadContract, type Provider, type Signer } from "../utils/contracts";
import { createBlobCache, browserPersistence } from "../lib/blob-cache";
import { walkChain } from "../lib/walk";
import { encodePost, validatePostDraft } from "../lib/wire";
import { FEED_REGISTRY } from "../lib/registry";
import { POLL_INTERVAL_MS, createRefreshGate, refresh, startPolling, type RefreshMode } from "../lib/poll";
import { NO_WRITE_SESSION } from "../lib/publish";
import { usePublisher } from "./usePublisher";
import { gatewayFetcher } from "../lib/gateways";

/**
 * A user's own post feed, on the migrated content model.
 *
 * ⚠️ `UserPosts.sol` IS DELETED. This hook used to call `getUserPostCount(address)` and
 * `getLatestUserPosts(address, n)` on a per-user contract. Aliased onto `PostRegistry` during the
 * migration those calls hit a contract with no such functions, and surfaced on the profile screen as:
 *
 *   execution reverted (no data present; likely require(false) occurred …
 *   data="0x00a09832…18773c30d65de35027ac8cd19e98c0ddb9c44ef9"   ← getUserPostCount(address)
 *
 * A selector that decodes to a function the target does not have is the signature of an un-migrated
 * hook, not of a broken contract.
 *
 * The model now: a profile feed is a `bytes32` registry id inside the one `PostRegistry`, and a user's
 * posts are the chain hanging off THEIR head in that registry. So it is one `headOf` read plus a walk,
 * and the cost does not grow with the number of authors or posts.
 */

/**
 * Well-known open registry id for profile feeds. Open ids are `keccak256(name)`.
 *
 * Defined in `lib/registry.ts` and re-exported here so existing importers need no change.
 */
export { FEED_REGISTRY } from "../lib/registry";

/** Matches PostRegistry's `HeadRef` tuple. */
interface OnChainHead {
  cid: string;
  prev: string;
  storeBlock: bigint;
  movedAt: bigint;
  by: string;
  allowed: boolean;
}

interface UseUserPostsProps {
  /** The PostRegistry address. Named for the old contract so callers need no change. */
  userPostsAddress: string | null;
  userAddress: string | null; // Profile owner whose posts to load
  provider: Provider | null;
  signer?: Signer | null;
  getDisplayName?: (address: string) => Promise<string>;
  enabled?: boolean;
}

interface UseUserPostsReturn {
  posts: UserPost[];
  /** True only for a COLD load — nothing on screen yet. Safe to render a skeleton. */
  isLoading: boolean;
  /**
   * True while a BACKGROUND poll is in flight, with the previous feed still on screen.
   *
   * ⚠️ NEVER unmount the feed on this — see `lib/poll.ts`. It is here so a UI *can* show a subtle
   * "updating" hint; nothing is obliged to consume it.
   */
  isRefreshing: boolean;
  error: string | null;

  createPost: (content: string) => Promise<number>;
  editPost: (postIndex: number, newContent: string) => Promise<void>;
  deletePost: (postIndex: number) => Promise<void>;
  refresh: () => Promise<void>;

  postCount: number;
}

export function useUserPosts({
  userPostsAddress,
  userAddress,
  provider,
  getDisplayName,
}: UseUserPostsProps): UseUserPostsReturn {
  // `null` when this session cannot write. Not an error — see `usePublisher`.
  const publisher = usePublisher();
  const [posts, setPosts] = useState<UserPost[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The last committed feed, mirrored into a ref.
   *
   * ⚠️ THE EQUALITY SKIP MUST READ THIS, NOT `posts`. A `useCallback` closes over the `posts` of the
   * render that created it. Everything that writes `posts` goes through `commitPosts`.
   */
  const postsRef = useRef<UserPost[]>([]);
  const commitPosts = useCallback((next: UserPost[]) => {
    postsRef.current = next;
    setPosts(next);
  }, []);

  /**
   * Orders concurrent refreshes so a slow one cannot overwrite a newer one. Without it: the 30s poll
   * starts fetching, the user publishes, the post-write reload commits the new post — and then the
   * poll's PRE-WRITE snapshot resolves and rolls the list back, silently, for up to 30 seconds.
   * See `lib/poll.ts` § RefreshGate.
   */
  const gate = useMemo(() => createRefreshGate(), []);

  // Bodies are immutable and content-addressed, so a cache hit can never be stale — only absent.
  const cache = useMemo(
    () => createBlobCache({ fetcher: gatewayFetcher(), persist: browserPersistence() }),
    []
  );

  const getReadContract = useCallback(
    () => createReadContract(userPostsAddress, PostRegistryABI.abi, provider),
    [userPostsAddress, provider]
  );

  /**
   * The FETCH half: reads the chain and returns a list. It touches no state and announces nothing.
   *
   * Keeping it pure is what lets `lib/poll.ts` decide whether this load is allowed to blank the
   * screen. The old shape — one function that set `isLoading` and `[]` before fetching, re-entered
   * by a 30-second interval — is the reported flicker.
   */
  const fetchPosts = useCallback(async (): Promise<UserPost[]> => {
    const contract = getReadContract();
    if (!contract || !userAddress) return [];

    // ONE read: this user's head in the feed registry. There is exactly one head per
    // (registry, writer), so this is O(1) no matter how much they have posted.
    const head = (await contract.headOf(FEED_REGISTRY, userAddress)) as OnChainHead;

    // A feed with no head is a RESULT, not a failure — returned and diffed like any other, so a
    // poll that keeps finding nothing commits nothing and re-renders nothing.
    if (!head?.cid) return [];

    const page = await walkChain({
      heads: [
        {
          cid: head.cid,
          prev: head.prev || null,
          at: head.movedAt > 0n ? Number(head.movedAt) * 1000 : null,
          by: head.by,
          block: head.storeBlock > 0n ? Number(head.storeBlock) : null,
          index: null,
        },
      ],
      cache,
      limit: 50,
    });

    let displayName: string | undefined;
    if (getDisplayName) {
      try {
        displayName = await getDisplayName(userAddress);
      } catch {
        displayName = undefined;
      }
    }

    return page.entries.map((entry, index) => {
      const decoded = entry.object;
      // A hole: the body expired from Bulletin, or no gateway would serve it. The pointer is still
      // on chain, so the post is real — it is the CONTENT that is gone, and calling that "deleted"
      // would be wrong. Retention expiry is the only deletion mechanism this design has.
      const content = !decoded
        ? "(this post's body has expired from Bulletin storage)"
        : decoded.kind === "post" || decoded.kind === "msg"
          ? decoded.body
          : decoded.kind === "thread"
            ? decoded.excerpt
            : "";

      return {
        index,
        cid: entry.cid,
        profileOwner: userAddress,
        sender: decoded?.author || entry.author || userAddress,
        content,
        timestamp: decoded?.at ?? entry.at ?? 0,
        editedAt: null,
        isDeleted: false,
        displayName,
      } as UserPost;
    });
  }, [getReadContract, userAddress, cache, getDisplayName]);

  /**
   * The ANNOUNCE half. `mode` decides whether this load may blank the screen.
   *
   * - `"cold"` — nothing on screen yet, or we just switched to a different profile.
   * - `"background"` — the 30-second poll. Keeps the current feed up, raises `isRefreshing`, commits
   *   only on a real change, and on failure keeps the last good feed.
   *
   * ⛔ Never infer the mode from `posts.length === 0`; see `lib/poll.ts`.
   */
  const loadPosts = useCallback(
    async (mode: RefreshMode = "cold"): Promise<void> => {
      if (!getReadContract() || !userAddress) {
        // A cold entry shows the empty state; a background tick does nothing rather than blanking a
        // feed that is still perfectly good.
        if (mode === "cold") commitPosts([]);
        return;
      }
      await refresh<UserPost[]>({
        mode,
        gate,
        sinks: {
          setData: commitPosts,
          setLoading: setIsLoading,
          setRefreshing: setIsRefreshing,
          setError,
        },
        load: fetchPosts,
        previous: () => postsRef.current,
        message: (err) => (err instanceof Error ? err.message : "Failed to load posts"),
        onError: (err) => console.error("Failed to load user posts:", err),
      });
    },
    [getReadContract, userAddress, fetchPosts, commitPosts]
  );

  const createPost = useCallback(
    async (content: string): Promise<number> => {
      if (!publisher) throw new Error(NO_WRITE_SESSION);

      /**
       * ⚠️ A FEED WRITE ALWAYS LANDS IN THE SIGNER'S OWN ROW. `setHead` writes `_heads[FEED][sender]`,
       * so publishing while looking at somebody else's profile would silently file the post under
       * OUR feed and then not show it here — a post that vanishes. Refuse instead.
       */
      if (userAddress && publisher.author.toLowerCase() !== userAddress.toLowerCase()) {
        throw new Error("You can only post to your own feed.");
      }

      // Validated before anything is stored, so an over-long post is refused at the field that can
      // fix it rather than after a Bulletin write.
      const draft = validatePostDraft({ body: content });

      const { confirmed } = await publisher.publish({
        registry: FEED_REGISTRY,
        cache,
        label: "post",
        build: (link) =>
          encodePost({
            ...link,
            author: publisher.author,
            body: draft.body,
            attachments: draft.attachments,
            // `i` lets a reply count be read from the head object alone, without walking the chain.
            index: posts.length,
            registry: FEED_REGISTRY,
          }),
      });

      // BACKGROUND: the feed is already on screen behind the composer and this read adds one row to
      // it. A cold load here would empty the feed the author just posted into.
      await loadPosts("background");
      if (!confirmed) {
        throw new Error(
          "Your post was submitted, but it has not shown up in a read yet. It should appear within " +
            "a minute; the feed refreshes on its own."
        );
      }
      return 0;
    },
    [publisher, userAddress, cache, posts.length, loadPosts]
  );

  const editPost = useCallback(async (): Promise<void> => {
    // Bodies are immutable Bulletin objects. An "edit" is a NEW object with a new CID — and therefore
    // a new, empty vote tally, deliberately: a tally belongs to the bytes people actually voted on.
    throw new Error(
      "Editing is not wired up yet. A Bulletin object cannot be changed, so an edit publishes a " +
        "replacement — and what that should do to existing replies and votes is not decided."
    );
  }, []);

  const deletePost = useCallback(async (): Promise<void> => {
    throw new Error(
      "Deleting is not available, and will not work the way it used to: freeing storage refunds " +
        "whoever freed it, so a moderated delete would hand an admin the author's deposit. Content " +
        "goes away by stopping renewal instead."
    );
  }, []);

  useEffect(() => {
    if (userPostsAddress && provider && userAddress) {
      // COLD, and the only cold entry point: the address, the provider or the PROFILE OWNER just
      // changed, so whatever is on screen belongs to somebody else and must not be preserved.
      void loadPosts("cold");
    } else {
      commitPosts([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userPostsAddress, provider, userAddress]);

  /**
   * Always call the LATEST loader through a ref — `loadPosts` changes identity whenever
   * `getDisplayName` does, and an interval effect depending on it restarts on every such render,
   * which on an unstable `getDisplayName` means the 30 seconds never elapse and the poll never fires.
   */
  const loadPostsRef = useRef(loadPosts);
  useEffect(() => {
    loadPostsRef.current = loadPosts;
  }, [loadPosts]);

  // Polling, NOT log subscriptions: `eth_getLogs` cannot see events from host-submitted contract
  // calls (architecture §8). Do not "modernise" this.
  //
  // ⛔ THE TICK IS ALWAYS `"background"`. A cold tick empties the feed and raises the spinner twice a
  // minute for data that is almost always identical — the reported flicker.
  useEffect(() => {
    if (!userPostsAddress || !provider || !userAddress) return;
    return startPolling(() => void loadPostsRef.current("background"), {
      intervalMs: POLL_INTERVAL_MS,
    });
  }, [userPostsAddress, provider, userAddress]);

  return {
    posts,
    isLoading,
    isRefreshing,
    error,
    createPost,
    editPost,
    deletePost,
    refresh: loadPosts,
    postCount: posts.length,
  };
}
