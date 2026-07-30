import { useState } from 'react';
import type { Reply, VoteType, VoteTally, Profile } from '../types/contracts';
import { VotingWidget } from './VotingWidget';
import { UserLink } from './UserAddress';
import { formatTimestamp } from '../utils/formatters';
import { reportError } from '../lib/reportError';
import type { Provider } from '../utils/contracts';
import toast from 'react-hot-toast';

/**
 * One reply.
 *
 * ⛔ **NO `onReply`, NO `children`, NO `renderChild`.** Replies are flat: the wire format has no
 * parent pointer, so a reply-to-a-reply cannot be written or read back. The control was removed
 * rather than left to throw. See `hooks/useReplies.ts`.
 */
interface ReplyItemProps {
  reply: Reply;
  entityId: string;
  currentAddress: string | null;
  // Voting
  getVoteTally: (entityId: string) => Promise<VoteTally>;
  getUserVote: (entityId: string) => Promise<VoteType>;
  vote: (entityId: string, voteType: VoteType) => Promise<void>;
  removeVote: (entityId: string) => Promise<void>;
  isVoting: boolean;
  // Actions
  onEdit?: (replyIndex: number, newContent: string) => Promise<void>;
  onDelete?: (replyIndex: number) => Promise<void>;
  onSelectUser?: (address: string) => void;
  disabled?: boolean;
  // Tooltip props
  getProfile?: (address: string) => Promise<Profile>;
  provider?: Provider | null;
  onFollow?: (address: string) => Promise<void>;
  onUnfollow?: (address: string) => Promise<void>;
  isFollowing?: (address: string) => boolean;
  onTip?: (address: string) => void;
  canTip?: boolean;
}

export function ReplyItem({
  reply,
  entityId,
  currentAddress,
  getVoteTally,
  getUserVote,
  vote,
  removeVote,
  isVoting,
  onEdit,
  onDelete,
  onSelectUser,
  disabled = false,
  // Tooltip props
  getProfile,
  provider,
  onFollow,
  onUnfollow,
  isFollowing,
  onTip,
  canTip = false,
}: ReplyItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(reply.content);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const isOwner = currentAddress?.toLowerCase() === reply.author.toLowerCase();

  const handleSaveEdit = async () => {
    if (!editContent.trim() || isSaving) return;

    setIsSaving(true);
    try {
      await onEdit?.(reply.index, editContent);
      setIsEditing(false);
      toast.success('Reply updated');
    } catch (error) {
      // Editing currently REFUSES with an explanation (a Bulletin object cannot change), and that
      // explanation is the whole value of the failure — do not flatten it into "Failed to update".
      reportError('edit your reply', error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (isDeleting) return;

    setIsDeleting(true);
    try {
      await onDelete?.(reply.index);
      toast.success('Reply deleted');
    } catch (error) {
      reportError('delete your reply', error);
      setIsDeleting(false);
    }
  };

  if (reply.isDeleted) {
    return (
      <div className="font-mono text-xs text-primary-700 italic py-2 pl-4 border-l-2 border-primary-800">
        [REPLY DELETED]
      </div>
    );
  }

  return (
    <div className="py-2 pl-4 border-l-2 border-primary-700 hover:border-primary-500 transition-colors">
      {/* Header */}
      <div className="flex items-center gap-2 font-mono text-xs">
        {onSelectUser && (
          <UserLink
            address={reply.author}
            displayName={reply.displayName}
            onSelectUser={onSelectUser}
            size="xs"
            getProfile={getProfile}
            provider={provider}
            onFollow={onFollow}
            onUnfollow={onUnfollow}
            isFollowing={isFollowing?.(reply.author)}
            onTip={onTip}
            canTip={canTip}
          />
        )}
        <span className="text-primary-600">
          {/* ⚠️ NO `* 1000`. `Reply.timestamp` is epoch MILLISECONDS now, like every other migrated
              surface, and `formatTimestamp` takes ms. Multiplying again rendered the year 58548. */}
          {formatTimestamp(reply.timestamp)}
        </span>
        {reply.editedAt && (
          <span className="text-primary-700 italic">(edited)</span>
        )}
      </div>

      {/* Content or Edit Form */}
      {isEditing ? (
        <div className="mt-2">
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            className="w-full min-h-[60px] px-3 py-2 bg-black border border-primary-600 text-primary-400 font-mono text-sm focus:outline-none focus:border-primary-400 resize-y"
            maxLength={2000}
            disabled={isSaving}
          />
          <div className="mt-2 flex gap-2">
            <button
              onClick={handleSaveEdit}
              disabled={isSaving || !editContent.trim()}
              className="px-3 py-1 text-xs font-mono text-primary-400 border border-primary-500 hover:bg-primary-900 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSaving ? 'SAVING...' : 'SAVE'}
            </button>
            <button
              onClick={() => {
                setIsEditing(false);
                setEditContent(reply.content);
              }}
              disabled={isSaving}
              className="px-3 py-1 text-xs font-mono text-primary-600 border border-primary-700 hover:border-primary-500"
            >
              CANCEL
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-1 text-sm text-primary-300 font-mono whitespace-pre-wrap">
          {reply.content}
        </div>
      )}

      {/* Actions */}
      {!isEditing && (
        <div className="mt-2 flex items-center gap-4">
          <VotingWidget
            entityId={entityId}
            getVoteTally={getVoteTally}
            getUserVote={getUserVote}
            vote={vote}
            removeVote={removeVote}
            isVoting={isVoting}
            disabled={disabled}
            compact
          />

          {/* ⛔ NO "REPLY" BUTTON. A reply to a reply has nowhere to record its parent, so this
              control could only ever produce an error. Removed, not disabled. */}

          {isOwner && onEdit && !disabled && (
            <button
              onClick={() => setIsEditing(true)}
              className="text-xs font-mono text-primary-600 hover:text-primary-400"
            >
              EDIT
            </button>
          )}

          {isOwner && onDelete && !disabled && (
            <button
              onClick={handleDelete}
              disabled={isDeleting}
              className="text-xs font-mono text-red-600 hover:text-red-400 disabled:opacity-50"
            >
              {isDeleting ? 'DELETING...' : 'DELETE'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
