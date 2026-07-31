import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { UserPost } from "../types/contracts";
import UserPostsABI from "../contracts/UserPosts.json";
import { createReadContract, type Provider } from "../utils/contracts";
import { POLL_INTERVAL_MS, createRefreshGate, refresh, startPolling, type RefreshMode } from "../lib/poll";

interface UseFeedProps {
  userPostsAddress: string | null;
  following: string[]; // List of addresses the user follows
  provider: Provider | null;
  getDisplayName?: (address: string) => Promise<string>;
  enabled?: boolean;
  postsPerUser?: number; // How many posts to fetch per followed user
}

interface UseFeedReturn {
  posts: UserPost[];
  /** True only for a COLD load — nothing on screen yet. Safe to render a skeleton. */
  isLoading: boolean;
  /**
   * True while a BACKGROUND poll is in flight, with the previous feed still on screen.
   *
   * ⚠️ NEVER unmount the feed on this — see `lib/poll.ts`. Nothing is obliged to consume it.
   */
  isRefreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  hasMore: boolean;
  loadMore: () => Promise<void>;
}

// Raw post from contract
interface RawPost {
  profileOwner: string;
  sender: string;
  content: string;
  timestamp: bigint;
  editedAt: bigint;
  isDeleted: boolean;
}

export function useFeed({
  userPostsAddress,
  following,
  provider,
  getDisplayName,
  enabled = true,
  postsPerUser = 10,
}: UseFeedProps): UseFeedReturn {
  const [posts, setPosts] = useState<UserPost[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  /**
   * The last committed feed, mirrored into a ref.
   *
   * ⚠️ THE EQUALITY SKIP MUST READ THIS, NOT `posts` — a `useCallback` closes over the `posts` of the
   * render that created it. Everything that writes `posts` goes through `commitPosts`.
   */
  const postsRef = useRef<UserPost[]>([]);
  const commitPosts = useCallback((next: UserPost[]) => {
    postsRef.current = next;
    setPosts(next);
    // No true pagination here yet; the flag is a constant, kept beside the commit so it cannot drift.
    setHasMore(false);
  }, []);

  /**
   * Orders concurrent refreshes so a slow one cannot overwrite a newer one. Without it a slow poll
   * that started before a write can resolve after it and roll the feed back to its PRE-WRITE
   * snapshot, silently. See `lib/poll.ts` § RefreshGate.
   */
  const gate = useMemo(() => createRefreshGate(), []);

  const getReadContract = useCallback(() => {
    return createReadContract(userPostsAddress, UserPostsABI.abi, provider);
  }, [userPostsAddress, provider]);

  const formatPost = useCallback(
    async (raw: RawPost, index: number): Promise<UserPost> => {
      let displayName: string | undefined;
      if (getDisplayName) {
        try {
          displayName = await getDisplayName(raw.profileOwner);
        } catch {
          displayName = undefined;
        }
      }

      return {
        index,
        // ⛔ EMPTY, because this hook still reads the DELETED `UserPosts` contract — there is no
        // Bulletin CID in that shape and no post can come back from it anyway. An empty cid means
        // no vote control renders, which is correct for content that cannot exist. This becomes
        // `entry.cid` when the feed migrates onto `PostRegistry.headsOf(FEED, following)`.
        cid: "",
        profileOwner: raw.profileOwner,
        sender: raw.sender,
        content: raw.content,
        // `* 1000`: a Solidity seconds timestamp; `UserPost.timestamp` is epoch ms.
        timestamp: Number(raw.timestamp) * 1000,
        editedAt: raw.editedAt > 0n ? Number(raw.editedAt) : null,
        isDeleted: raw.isDeleted,
        displayName,
      };
    },
    [getDisplayName]
  );

  /**
   * The FETCH half: reads and returns a list. It touches no state and announces nothing.
   *
   * Keeping it pure is what lets `lib/poll.ts` decide whether this load may blank the screen. The
   * old shape — one function that set `isLoading` and `[]` before fetching, re-entered by a
   * 30-second interval — is the reported flicker.
   */
  const fetchFeed = useCallback(async (): Promise<UserPost[]> => {
    const contract = getReadContract();
    if (!contract || following.length === 0) return [];

    // Fetch posts from each followed user in parallel
    const postsPromises = following.map(async (userAddress) => {
      try {
        const [rawPosts, indices] = await contract.getLatestUserPosts(
          userAddress,
          postsPerUser
        );

        // Format posts with display names
        const formatted = await Promise.all(
          rawPosts.map((raw: RawPost, i: number) =>
            formatPost(raw, Number(indices[i]))
          )
        );

        return formatted;
      } catch (err) {
        console.warn(`Failed to load posts for ${userAddress}:`, err);
        return [];
      }
    });

    const allPostsArrays = await Promise.all(postsPromises);

    // Flatten and filter out deleted posts
    const allPosts = allPostsArrays
      .flat()
      .filter((post) => !post.isDeleted);

    // Sort by timestamp (newest first)
    allPosts.sort((a, b) => b.timestamp - a.timestamp);

    return allPosts;
  }, [getReadContract, following, postsPerUser, formatPost]);

  /**
   * The ANNOUNCE half. `mode` decides whether this load may blank the screen.
   *
   * - `"cold"` — nothing on screen yet, or the following set changed.
   * - `"background"` — the 30-second poll. Keeps the current feed up, raises `isRefreshing`, commits
   *   only on a real change, and on failure keeps the last good feed.
   *
   * ⛔ Never infer the mode from `posts.length === 0`; see `lib/poll.ts`.
   */
  const loadFeed = useCallback(
    async (mode: RefreshMode = "cold"): Promise<void> => {
      if (!getReadContract() || following.length === 0) {
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
        load: fetchFeed,
        previous: () => postsRef.current,
        message: (err) => (err instanceof Error ? err.message : "Failed to load feed"),
        onError: (err) => console.error("Failed to load feed:", err),
      });
    },
    [getReadContract, following.length, fetchFeed, commitPosts]
  );

  const loadMore = useCallback(async () => {
    // TODO: Implement proper pagination if needed
    // For now, this is a no-op since we load all at once
  }, []);

  // Load feed when following list changes
  useEffect(() => {
    if (enabled && userPostsAddress && provider && following.length > 0) {
      // COLD, and the only cold entry point: the follow set or the chain just changed, so what is on
      // screen describes a different question and must not be preserved.
      void loadFeed("cold");
    } else {
      commitPosts([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, userPostsAddress, provider, following.length]);

  /** Always call the LATEST loader through a ref, so the poll cannot be starved by a re-render. */
  const loadFeedRef = useRef(loadFeed);
  useEffect(() => {
    loadFeedRef.current = loadFeed;
  }, [loadFeed]);

  // Poll for new posts every 30 seconds.
  //
  // ⛔ THE TICK IS ALWAYS `"background"`. A cold tick empties the feed and raises the spinner twice a
  // minute for data that is almost always identical — the reported flicker.
  useEffect(() => {
    if (!enabled || !userPostsAddress || !provider || following.length === 0) {
      return;
    }
    return startPolling(() => void loadFeedRef.current("background"), {
      intervalMs: POLL_INTERVAL_MS,
    });
  }, [enabled, userPostsAddress, provider, following.length]);

  return {
    posts,
    isLoading,
    isRefreshing,
    error,
    refresh: loadFeed,
    hasMore,
    loadMore,
  };
}
