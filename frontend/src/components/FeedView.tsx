import { useFeed } from '../hooks/useFeed';
import { PostCard } from './PostCard';
import { useVoting } from '../hooks/useVoting';
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

  if (isLoading && posts.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-primary-500 font-mono">LOADING FEED...</div>
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
        {posts.length === 0 ? (
          <div className="text-center text-primary-600 font-mono py-8">
            No posts from users you follow yet.
          </div>
        ) : (
          <div className="space-y-4">
            {posts.map((post) => (
              <PostCard
                key={`${post.profileOwner}-${post.index}`}
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
