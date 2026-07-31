import { useState } from 'react';
import type { Profile } from '../types/contracts';
import { useReplies } from '../hooks/useReplies';
import { useVoting } from '../hooks/useVoting';
import { ReplyItem } from './ReplyItem';
import { entityIdOfCid } from '../lib/entity';
import { reportError } from '../lib/reportError';
import type { Provider, Signer } from '../utils/contracts';
import toast from 'react-hot-toast';

/**
 * The replies under one post or thread.
 *
 * ⛔ **FLAT, ON PURPOSE.** There is no reply-to-a-reply control here any more, because there is no
 * parent pointer in the wire format to carry one (`hooks/useReplies.ts` explains it in full). A
 * button that can only produce an error is worse than no button, so the nesting affordances were
 * removed rather than disabled.
 *
 * Every reply now carries a `cid`, so its vote id is `entityIdOfCid(reply.cid)` — computed during
 * render, synchronously, cannot fail. The old async `getReplyEntityId` stub that deliberately
 * returned `''` (and therefore rendered no vote control at all) is gone with the contract it was
 * apologising for.
 */
interface ReplyThreadProps {
  /** The PostRegistry address. Named for the deleted contract so callers need no change. */
  repliesAddress: string | null;
  votingAddress: string | null;
  /** The CID of the thread announcement or post being replied to. */
  parentCid: string | null;
  /** The board or feed this conversation hangs off, used as `HeadSet.group`. */
  group?: string;
  provider: Provider | null;
  signer?: Signer | null;
  currentAddress: string | null;
  getDisplayName?: (address: string) => Promise<string>;
  onSelectUser?: (address: string) => void;
  disabled?: boolean;
  // Tooltip props
  getProfile?: (address: string) => Promise<Profile>;
  onFollow?: (address: string) => Promise<void>;
  onUnfollow?: (address: string) => Promise<void>;
  isFollowing?: (address: string) => boolean;
  onTip?: (address: string) => void;
  canTip?: boolean;
}

export function ReplyThread({
  repliesAddress,
  votingAddress,
  parentCid,
  group,
  provider,
  signer,
  currentAddress,
  getDisplayName,
  onSelectUser,
  disabled = false,
  // Tooltip props
  getProfile,
  onFollow,
  onUnfollow,
  isFollowing,
  onTip,
  canTip = false,
}: ReplyThreadProps) {
  const [isComposing, setIsComposing] = useState(false);
  const [replyContent, setReplyContent] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    replies,
    replyCount,
    isLoading,
    canReply,
    addReply,
    editReply,
    deleteReply,
    refresh,
  } = useReplies({
    repliesAddress,
    parentCid,
    group,
    provider,
    getDisplayName,
    enabled: !disabled,
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
    enabled: !disabled,
  });

  const handleSubmitReply = async () => {
    if (!replyContent.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await addReply(replyContent);
      setReplyContent('');
      setIsComposing(false);
      toast.success('Reply posted');
    } catch (error) {
      // `reportError`, not `toast.error('Failed…')`. The useful part of a failure here is a
      // WireError naming the field, or an ethers cause chain naming a selector — and neither
      // survives being flattened into one generic line. See `lib/errors.ts`.
      reportError('post your reply', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading && replies.length === 0) {
    return (
      <div className="py-4 font-mono text-xs text-primary-600">
        Loading replies...
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-3">
      {/* Composer. ⚠️ Gated on `canReply` (i.e. on the PUBLISHER), never on `signer`: `signer` is the
          delegate arm and is null on a perfectly writable session. */}
      {canReply && (
        <div className="mb-4">
          {!isComposing ? (
            /* A real button, styled like the other composer-openers. It was text-only, which made
               the app's second-most-used write affordance look like a caption next to the bordered
               REFRESH / + NEW THREAD / COPY LINK controls it sits under. Classes copied verbatim
               from + NEW THREAD in `ForumView` — every one of them is known to build, which is not
               a given here: a colour must be declared in the `@theme static` block in `index.css`
               or Tailwind generates no variant for it and the class silently does nothing. */
            <button
              type="button"
              onClick={() => setIsComposing(true)}
              className="px-3 py-1 text-xs font-mono text-primary-400 border border-primary-500 hover:bg-primary-900 transition-colors"
            >
              + ADD REPLY ({replyCount})
            </button>
          ) : (
            <div className="border border-primary-700 p-3">
              <div className="text-xs font-mono text-primary-600 mb-2">REPLYING TO POST</div>
              <textarea
                value={replyContent}
                onChange={(e) => setReplyContent(e.target.value)}
                placeholder="Write your reply..."
                className="w-full min-h-[60px] px-3 py-2 bg-black border border-primary-600 text-primary-400 font-mono text-sm focus:outline-none focus:border-primary-400 resize-y"
                maxLength={2000}
                disabled={isSubmitting}
              />
              <div className="mt-2 flex gap-2">
                <button
                  onClick={handleSubmitReply}
                  disabled={isSubmitting || !replyContent.trim()}
                  className="px-4 py-1.5 text-xs font-mono text-primary-400 border border-primary-500 hover:bg-primary-900 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSubmitting ? 'POSTING...' : 'POST REPLY'}
                </button>
                <button
                  onClick={() => {
                    setIsComposing(false);
                    setReplyContent('');
                  }}
                  disabled={isSubmitting}
                  className="px-4 py-1.5 text-xs font-mono text-primary-600 border border-primary-700 hover:border-primary-500"
                >
                  CANCEL
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Replies, oldest first — a conversation, not a feed. */}
      {replies.length > 0 ? (
        <div className="space-y-2">
          {replies.map((reply) => (
            <ReplyItem
              key={reply.cid}
              reply={reply}
              // Pure keccak of the CID — no round trip, no failure mode, right on the first paint.
              entityId={entityIdOfCid(reply.cid) ?? ''}
              currentAddress={currentAddress}
              getVoteTally={getVoteTally}
              getUserVote={getUserVote}
              vote={vote}
              removeVote={removeVote}
              isVoting={isVoting}
              onEdit={editReply}
              onDelete={deleteReply}
              onSelectUser={onSelectUser}
              disabled={disabled}
              getProfile={getProfile}
              provider={provider}
              onFollow={onFollow}
              onUnfollow={onUnfollow}
              isFollowing={isFollowing}
              onTip={onTip}
              canTip={canTip}
            />
          ))}
        </div>
      ) : (
        <div className="text-xs font-mono text-primary-700 py-2">
          No replies yet
        </div>
      )}

      {/* Refresh button */}
      {replies.length > 0 && (
        <button
          onClick={refresh}
          className="text-xs font-mono text-primary-700 hover:text-primary-500 mt-2"
        >
          [REFRESH]
        </button>
      )}
    </div>
  );
}
