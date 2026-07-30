import { useState, useCallback, useEffect, useRef } from "react";
import type { UserPost } from "../types/contracts";
import UserPostsABI from "../contracts/UserPosts.json";
import { createReadContract, type Provider } from "../utils/contracts";

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
  isLoading: boolean;
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
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const pollIntervalRef = useRef<number | null>(null);

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

  const loadFeed = useCallback(async () => {
    const contract = getReadContract();
    if (!contract || following.length === 0) {
      setPosts([]);
      setHasMore(false);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

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

      setPosts(allPosts);
      // For now, hasMore is false since we're not doing true pagination
      setHasMore(false);
    } catch (err) {
      console.error("Failed to load feed:", err);
      setError(err instanceof Error ? err.message : "Failed to load feed");
    } finally {
      setIsLoading(false);
    }
  }, [getReadContract, following, postsPerUser, formatPost]);

  const loadMore = useCallback(async () => {
    // TODO: Implement proper pagination if needed
    // For now, this is a no-op since we load all at once
  }, []);

  // Load feed when following list changes
  useEffect(() => {
    if (enabled && userPostsAddress && provider && following.length > 0) {
      loadFeed();
    } else {
      setPosts([]);
      setHasMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, userPostsAddress, provider, following.length]);

  // Poll for new posts every 30 seconds
  useEffect(() => {
    if (!enabled || !userPostsAddress || !provider || following.length === 0) {
      return;
    }

    pollIntervalRef.current = window.setInterval(() => {
      loadFeed();
    }, 30000);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, userPostsAddress, provider, following.length]);

  return {
    posts,
    isLoading,
    error,
    refresh: loadFeed,
    hasMore,
    loadMore,
  };
}
