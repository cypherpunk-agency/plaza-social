import { useFeed } from '../hooks/useFeed';
import { PostCard } from './PostCard';
import { useVoting } from '../hooks/useVoting';
import { CollectionStatus } from './CollectionStatus';
import { useCollectionState } from './collectionState';
import type { Provider, Signer } from '../utils/contracts';

interface FeedViewProps {
  userPostsAddress: string | null;
  repliesAddress: string | null;
  votingAddress: string | null;
  following: string[];
  provider: Provider | null;
  signer?: Signer | null;
  currentAddress: string | null;
  getDisplayName?: (address: string) => Promise<string>;
  onSelectUser?: (address: string) => void;
  disabled?: boolean;
}

export function FeedView({
  userPostsAddress,
  repliesAddress,
  votingAddress,
  following,
  provider,
  signer,
  currentAddress,
  getDisplayName,
  onSelectUser,
  disabled = false,
}: FeedViewProps) {
  const { posts, isLoading, error, refresh } = useFeed({
    userPostsAddress,
    following,
    provider,
    getDisplayName,
    enabled: true,
  });

  const {
    getVoteTally,
    getUserVote,
    vote,
    removeVote,
    isVoting,
  } = useVoting({
    votingAddress,
    provider,
    signer,
    userAddress: currentAddress,
  });

  /**
   * ⭐ THE THREE-WAY RULE — see `collectionState.ts`. TWO claims on this screen were made before
   * anything had been read:
   *
   *  1. `following.length === 0` → "YOUR FEED IS EMPTY. Follow some users…". The follow graph is
   *     read through the same session; until there is a chain reader it is `[]` for everybody, so
   *     this told people with a full feed to go and find someone to follow.
   *  2. `posts.length === 0` → "No posts from users you follow yet."
   *
   * `sessionReady` is the shared precondition; the posts decision additionally needs a non-empty
   * follow set, because `useFeed`'s cold effect refuses to run without one and therefore never
   * raises `isLoading`.
   */
  const sessionReady = !!provider && !!userPostsAddress;
  const postsState = useCollectionState({
    ready: sessionReady && following.length > 0,
    isLoading,
    count: posts.length,
    error,
    subject: userPostsAddress,
  });

  if (!sessionReady) {
    return (
      <div className="flex flex-col h-full">
        <CollectionStatus state="connecting" layout="fill" />
      </div>
    );
  }

  if (following.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8">
        <div className="text-primary-500 text-4xl mb-4">[FEED]</div>
        <div className="text-primary-400 font-mono mb-2">
          YOUR FEED IS EMPTY
        </div>
        <div className="text-primary-600 font-mono text-sm max-w-md">
          Follow some users to see their posts here. Click on a user in any
          channel to view their profile and follow them.
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8">
        <div className="text-red-500 font-mono mb-4">ERROR: {error}</div>
        <button
          onClick={refresh}
          className="px-4 py-2 text-sm font-mono text-primary-400 border border-primary-500 hover:bg-primary-900"
        >
          RETRY
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-primary-700">
        <div className="font-mono">
          <span className="text-primary-500 text-lg">[FEED]</span>
          <span className="text-primary-600 text-sm ml-2">
            from {following.length} user{following.length !== 1 ? 's' : ''}
          </span>
        </div>
        <button
          onClick={refresh}
          disabled={isLoading}
          className="px-3 py-1 text-xs font-mono text-primary-500 border border-primary-600 hover:border-primary-400 disabled:opacity-50"
        >
          {isLoading ? 'LOADING...' : 'REFRESH'}
        </button>
      </div>

      {/* Posts */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* ⛔ The empty line is reachable only after a completed read; `isRefreshing` is not read. */}
        <CollectionStatus
          state={postsState}
          noun="FEED"
          empty="No posts from users you follow yet."
        />
        {postsState === 'ready' && (
          <div className="space-y-4">
            {posts.map((post) => (
              /* ⚠️ CID, NOT `index` — see `types/contracts.ts`: `index` is a position in the loaded
                 page, so a new post shifts every row onto a different key and React remounts the
                 list on each background poll. The owner stays in the key only to keep it obviously
                 unique across the aggregated feed. */
              <PostCard
                key={`${post.profileOwner}-${post.cid}`}
                post={post}
                repliesAddress={repliesAddress}
                votingAddress={votingAddress}
                provider={provider}
                signer={signer}
                currentAddress={currentAddress}
                getVoteTally={getVoteTally}
                getUserVote={getUserVote}
                vote={vote}
                removeVote={removeVote}
                isVoting={isVoting}
                onSelectUser={onSelectUser}
                getDisplayName={getDisplayName}
                disabled={disabled}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
