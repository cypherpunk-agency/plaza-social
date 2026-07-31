import { useMemo } from 'react';
import { useUserPosts } from '../hooks/useUserPosts';
import { usePublisher } from '../hooks/usePublisher';
import { useVoting } from '../hooks/useVoting';
import { NewPostForm } from './NewPostForm';
import { PostCard } from './PostCard';
import { PostDetailView } from './PostDetailView';
import { CollectionStatus } from './CollectionStatus';
import { useCollectionState } from './collectionState';
import type { Provider, Signer } from '../utils/contracts';
import type { Profile } from '../types/contracts';

interface UserPostsFeedProps {
  userPostsAddress: string | null;
  repliesAddress: string | null;
  votingAddress: string | null;
  profileOwner: string | null;
  provider: Provider | null;
  signer?: Signer | null;
  currentAddress: string | null;
  getDisplayName?: (address: string) => Promise<string>;
  onSelectUser?: (address: string) => void;
  isOwnProfile?: boolean;
  // Post selection
  selectedPostIndex?: number | null;
  onPostChange?: (postIndex: number | null) => void;
  // Tooltip props
  getProfile?: (address: string) => Promise<Profile>;
  onFollow?: (address: string) => Promise<void>;
  onUnfollow?: (address: string) => Promise<void>;
  isFollowing?: (address: string) => boolean;
  onTip?: (address: string) => void;
  canTip?: boolean;
}

export function UserPostsFeed({
  userPostsAddress,
  repliesAddress,
  votingAddress,
  profileOwner,
  provider,
  signer,
  currentAddress,
  getDisplayName,
  onSelectUser,
  isOwnProfile = false,
  // Post selection
  selectedPostIndex,
  onPostChange,
  // Tooltip props
  getProfile,
  onFollow,
  onUnfollow,
  isFollowing,
  onTip,
  canTip = false,
}: UserPostsFeedProps) {
  const {
    posts,
    isLoading,
    error,
    createPost,
    editPost,
    deletePost,
    refresh,
    postCount,
  } = useUserPosts({
    userPostsAddress,
    userAddress: profileOwner,
    provider,
    signer,
    getDisplayName,
    enabled: !!profileOwner,
  });

  const {
    vote,
    removeVote,
    getVoteTally,
    getUserVote,
    isVoting,
  } = useVoting({
    votingAddress,
    provider,
    signer,
    userAddress: currentAddress,
    enabled: !!currentAddress,
  });

  /**
   * ⚠️ NOT `!!signer`. `signer` is the DELEGATE arm, which is null on a perfectly writable session —
   * posting goes through the host-signed path until a delegate is authorised, so gating on the
   * delegate hid the composer from everyone who can actually post. The publisher is the one thing
   * that is non-null exactly when a write can happen.
   */
  const publisher = usePublisher();
  const canPost = isOwnProfile && !!publisher;

  /**
   * ⭐ THE THREE-WAY RULE — see `collectionState.ts`. `[NO POSTS YET]` used to hang off
   * `!isLoading && posts.length === 0`, and `isLoading` is the COLD flag which `useUserPosts` never
   * raises while `createReadContract` returns null. So during host startup this told a visitor that
   * somebody's feed was empty, and told the owner to "create your first post" over posts they had
   * already written.
   *
   * `ready` mirrors the hook's cold effect exactly: `userPostsAddress && provider && userAddress`.
   */
  const feedState = useCollectionState({
    ready: !!provider && !!userPostsAddress && !!profileOwner,
    isLoading,
    count: posts.length,
    error,
    subject: profileOwner,
  });
  /** A count is a claim too: `Posts (0)` over a feed nobody has read yet is the same lie. */
  const countIsKnown = feedState === 'ready' || feedState === 'empty';

  // Find selected post for detail view
  const selectedPost = useMemo(() => {
    if (selectedPostIndex == null) return null;
    return posts.find(p => p.index === selectedPostIndex) ?? null;
  }, [posts, selectedPostIndex]);

  const handleSelectPost = (postIndex: number) => {
    onPostChange?.(postIndex);
  };

  const handleBackToList = () => {
    onPostChange?.(null);
  };

  if (!profileOwner) {
    return null;
  }

  // Show detail view if a post is selected
  if (selectedPost) {
    return (
      <PostDetailView
        post={selectedPost}
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
        onEdit={editPost}
        onDelete={deletePost}
        onSelectUser={onSelectUser}
        onBack={handleBackToList}
        getDisplayName={getDisplayName}
        disabled={!signer}
        getProfile={getProfile}
        onFollow={onFollow}
        onUnfollow={onUnfollow}
        isFollowing={isFollowing}
        onTip={onTip}
        canTip={canTip}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="font-mono text-sm text-primary-500 uppercase tracking-wider">
          {countIsKnown ? `Posts (${postCount})` : 'Posts'}
        </h3>
        {posts.length > 0 && (
          <button
            onClick={refresh}
            className="text-xs font-mono text-primary-700 hover:text-primary-500"
          >
            [REFRESH]
          </button>
        )}
      </div>

      {/* New Post Form - only on own profile */}
      {canPost && (
        <NewPostForm
          onSubmit={createPost}
          disabled={!canPost}
          placeholder="What's on your mind?"
        />
      )}

      {/* Error State */}
      {error && (
        <div className="py-4 text-center font-mono text-red-500 text-sm">
          Error: {error}
        </div>
      )}

      {/* Connecting / loading / empty — one control, one decision. ⛔ `[NO POSTS YET]` is now
          reachable ONLY after a read completed; `isRefreshing` is not consulted at all. */}
      {!error && (
        <CollectionStatus
          state={feedState}
          noun="POSTS"
          empty={
            <>
              <div className="text-sm mb-1">[NO POSTS YET]</div>
              {isOwnProfile && (
                <div className="text-primary-700 text-xs">Create your first post above</div>
              )}
            </>
          }
        />
      )}

      {/* Posts List */}
      {posts.length > 0 && (
        <div className="space-y-4">
          {posts.map((post) => (
            /* ⚠️ KEYED ON THE CID, NOT `index`. `index` is a POSITION in the loaded page (see
               `types/contracts.ts`), so a new post arriving shifts every row onto a different key
               and React remounts the whole list — visible as a flicker on the 30s background poll.
               The CID is the post's identity and does not move. */
            <PostCard
              key={post.cid}
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
              onEdit={editPost}
              onDelete={deletePost}
              onSelectUser={onSelectUser}
              onSelectPost={handleSelectPost}
              getDisplayName={getDisplayName}
              disabled={!signer}
              getProfile={getProfile}
              onFollow={onFollow}
              onUnfollow={onUnfollow}
              isFollowing={isFollowing}
              onTip={onTip}
              canTip={canTip}
            />
          ))}
        </div>
      )}
    </div>
  );
}
