import { useState } from 'react';
import type { Profile } from '../types/contracts';
import { useReplies } from '../hooks/useReplies';
import { useVoting } from '../hooks/useVoting';
import { ReplyItem } from './ReplyItem';
import { CollectionStatus } from './CollectionStatus';
import { useCollectionState } from './collectionState';
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
    error,
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

  /**
   * ⭐ THE THREE-WAY RULE — see `collectionState.ts`. "No replies yet" used to be the `else` of
   * `replies.length > 0`, so it rendered during host startup (no chain reader, `isLoading` never
   * raised), on a post whose CID has not resolved (no reply registry to read), and after a failed
   * read. All three are "we do not know", not "there are none".
   *
   * `ready` mirrors `useReplies`' cold effect: `repliesAddress && provider && registryId`, and
   * `registryId` is `threadRegistryId(parentCid)`, which is null without a CID.
   *
   * ⛔ `disabled` is deliberately NOT part of this. It gates REPLYING, not reading — the hook loads
   * regardless — so folding it in here would report a read-only session as a broken one.
   */
  const listState = useCollectionState({
    ready: !!provider && !!repliesAddress && !!parentCid,
    isLoading,
    count: replies.length,
    error,
    subject: parentCid,
  });
  /** `(0)` on the ADD REPLY button is a claim as much as the empty line is. */
  const countIsKnown = listState === 'ready' || listState === 'empty';

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

  /*
   * ⚠️ THERE IS NO LONGER AN EARLY RETURN FOR LOADING. It used to replace the whole section,
   * composer included, so the reply box vanished and came back on every cold load. The status line
   * now sits where the list goes and the composer stays mounted.
   */
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
              {countIsKnown ? `+ ADD REPLY (${replyCount})` : '+ ADD REPLY'}
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

      {/* ⛔ A FAILED READ IS NOT AN EMPTY CONVERSATION. `useReplies` has always exposed `error` and
          this component has never rendered it, so a failed walk read as "No replies yet". */}
      {error && (
        <div className="text-xs font-mono text-red-500 py-2">
          Replies could not be loaded: {error}{' '}
          <button
            type="button"
            onClick={() => void refresh()}
            className="text-primary-600 hover:text-primary-400 transition-colors"
          >
            [RETRY]
          </button>
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
        <CollectionStatus
          state={listState}
          noun="REPLIES"
          empty="No replies yet"
          layout="inline"
          connecting="Connecting..."
        />
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
