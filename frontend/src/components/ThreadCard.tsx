import { useState, useMemo } from 'react';
import type { ForumThread, VoteType, VoteTally, Profile } from '../types/contracts';
import { VotingWidget } from './VotingWidget';
import { ReplyThread } from './ReplyThread';
import { UserLink } from './UserAddress';
import { formatTimestamp } from '../utils/formatters';
import type { Provider, Signer } from '../utils/contracts';
import { entityIdOfCid } from '../lib/entity';
import { FORUM_REGISTRY } from '../lib/registry';
import toast from 'react-hot-toast';

interface ThreadCardProps {
  thread: ForumThread;
  repliesAddress: string | null;
  votingAddress: string | null;
  provider: Provider | null;
  signer?: Signer | null;
  currentAddress: string | null;
  // Voting functions
  getVoteTally: (entityId: string) => Promise<VoteTally>;
  getUserVote: (entityId: string) => Promise<VoteType>;
  vote: (entityId: string, voteType: VoteType) => Promise<void>;
  removeVote: (entityId: string) => Promise<void>;
  isVoting: boolean;
  // Actions
  onEdit?: (threadIndex: number, newContent: string) => Promise<void>;
  onDelete?: (threadIndex: number) => Promise<void>;
  onSelectUser?: (address: string) => void;
  /**
   * ⚠️ TAKES THE CID, NOT THE INDEX. `index` is a position in the loaded page and changes whenever
   * anybody else posts; the announcement CID is the thread's identity and is what `?cid=` carries.
   */
  onSelectThread?: (threadCid: string) => void;
  getDisplayName?: (address: string) => Promise<string>;
  disabled?: boolean;
  expanded?: boolean;
  /** Highlighted because it is the thread open in the detail pane. Two-pane layouts only. */
  isSelected?: boolean;
  /**
   * Replies under this thread. `undefined` means NOT COUNTED — render nothing, never "0".
   * See `useForumThread`'s `replyCounts`.
   */
  replyCount?: number;
  // Tooltip props
  getProfile?: (address: string) => Promise<Profile>;
  onFollow?: (address: string) => Promise<void>;
  onUnfollow?: (address: string) => Promise<void>;
  isFollowing?: (address: string) => boolean;
  onTip?: (address: string) => void;
  canTip?: boolean;
}

export function ThreadCard({
  thread,
  repliesAddress,
  votingAddress,
  provider,
  signer,
  currentAddress,
  getVoteTally,
  getUserVote,
  vote,
  removeVote,
  isVoting,
  onEdit,
  onDelete,
  onSelectUser,
  onSelectThread,
  getDisplayName,
  disabled = false,
  expanded = false,
  isSelected = false,
  replyCount,
  // Tooltip props
  getProfile,
  onFollow,
  onUnfollow,
  isFollowing,
  onTip,
  canTip = false,
}: ThreadCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(thread.content);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showReplies, setShowReplies] = useState(expanded);

  const isOwner = currentAddress?.toLowerCase() === thread.author.toLowerCase();

  // A vote is cast on the BYTES, so the tally is keyed on the CID. Pure keccak — no round trip, no
  // failure mode, and the count is right on the first paint. See `lib/entity.ts`.
  const entityId = useMemo(() => entityIdOfCid(thread.cid) ?? '', [thread.cid]);

  const handleSaveEdit = async () => {
    if (!editContent.trim() || isSaving) return;

    setIsSaving(true);
    try {
      await onEdit?.(thread.index, editContent);
      setIsEditing(false);
      toast.success('Thread updated');
    } catch (error) {
      console.error('Failed to edit thread:', error);
      toast.error('Failed to update thread');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (isDeleting) return;

    setIsDeleting(true);
    try {
      await onDelete?.(thread.index);
      toast.success('Thread deleted');
    } catch (error) {
      console.error('Failed to delete thread:', error);
      toast.error('Failed to delete thread');
      setIsDeleting(false);
    }
  };

  if (thread.isDeleted) {
    return (
      <div className="border border-primary-800 bg-black p-4 font-mono">
        <span className="text-primary-700 italic">[THREAD DELETED]</span>
      </div>
    );
  }

  const canOpen = !!onSelectThread && !!thread.cid;

  return (
    <div
      className={`border bg-black p-4 transition-colors min-w-0 ${
        isSelected
          ? 'border-primary-400 bg-primary-950'
          : 'border-primary-700 hover:border-primary-500'
      }`}
    >
      {/* Title. ⚠️ `break-words` is not cosmetic: a title can be a bare CID, and an unbreakable
          64-character token in a 375px column pushes the whole page into horizontal scroll. */}
      <h3
        className={`text-lg font-mono text-primary-300 mb-2 break-words ${canOpen ? 'cursor-pointer hover:text-primary-200' : ''}`}
        onClick={() => canOpen && onSelectThread!(thread.cid)}
      >
        {thread.title}
      </h3>

      {/* Header */}
      <div className="flex items-center flex-wrap gap-2 font-mono text-xs mb-3">
        {onSelectUser && (
          <UserLink
            address={thread.author}
            displayName={thread.displayName}
            onSelectUser={onSelectUser}
            size="xs"
            getProfile={getProfile}
            provider={provider}
            onFollow={onFollow}
            onUnfollow={onUnfollow}
            isFollowing={isFollowing?.(thread.author)}
            onTip={onTip}
            canTip={canTip}
          />
        )}
        <span className="text-primary-600">
          {formatTimestamp(thread.timestamp)}
        </span>
        {thread.editedAt && (
          <span className="text-primary-700 italic">(edited)</span>
        )}
        {/* ⚠️ WAS `#{thread.index}`. That number is a POSITION in the loaded page — it changes when
            anyone else posts — so showing it as an identifier taught the wrong thing about what
            identifies a thread. The CID is the identity, and it is what a shared link carries. */}
        {thread.cid && (
          <span className="text-primary-700 ml-auto" title={thread.cid}>
            {thread.cid.slice(0, 8)}…
          </span>
        )}
      </div>

      {/* Content or Edit Form */}
      {isEditing ? (
        <div>
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            className="w-full min-h-[120px] px-3 py-2 bg-black border border-primary-600 text-primary-400 font-mono text-sm focus:outline-none focus:border-primary-400 resize-y"
            maxLength={40000}
            disabled={isSaving}
          />
          <div className="text-xs font-mono text-primary-600 mt-1">
            {editContent.length.toLocaleString()} / 40,000
          </div>
          <div className="mt-2 flex gap-2">
            <button
              onClick={handleSaveEdit}
              disabled={isSaving || !editContent.trim()}
              className="px-4 py-1.5 text-xs font-mono text-primary-400 border border-primary-500 hover:bg-primary-900 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSaving ? 'SAVING...' : 'SAVE'}
            </button>
            <button
              onClick={() => {
                setIsEditing(false);
                setEditContent(thread.content);
              }}
              disabled={isSaving}
              className="px-4 py-1.5 text-xs font-mono text-primary-600 border border-primary-700 hover:border-primary-500"
            >
              CANCEL
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Excerpt.
              ⚠️ `max-w-[70ch]` IS THE POINT OF THIS COMPONENT'S EXISTENCE AT DESKTOP WIDTH. Before
              it, a card spanned the viewport — measured ~1750px, three or four times a comfortable
              reading measure. A cap in `ch` tracks the font, so it stays right if the type scale in
              `index.css` moves. */}
          <div
            className={`text-sm text-primary-300 font-mono whitespace-pre-wrap break-words mb-3 max-w-[70ch] ${
              canOpen ? 'cursor-pointer' : ''
            }`}
            onClick={() => canOpen && onSelectThread!(thread.cid)}
          >
            {expanded ? thread.content : (
              thread.content.length > 300
                ? thread.content.slice(0, 300) + '...'
                : thread.content
            )}
          </div>
          {/* Tags */}
          {thread.tags && thread.tags.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4">
              {thread.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-block px-2 py-0.5 text-xs font-mono bg-primary-900 text-primary-500 border border-primary-700"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </>
      )}

      {/* Actions Row */}
      {!isEditing && (
        <div className="flex items-center flex-wrap gap-3 pt-3 border-t border-primary-800">
          {/* Voting */}
          {entityId && (
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
          )}

          {/* Reply toggle. `replyCount === undefined` means NOT COUNTED, so no number is shown —
              a confident "0" over a registry we failed to read would be a lie with a number on it. */}
          <button
            onClick={() => setShowReplies(!showReplies)}
            className="text-xs font-mono text-primary-600 hover:text-primary-400 whitespace-nowrap"
          >
            {showReplies ? '[-] HIDE REPLIES' : '[+] REPLIES'}
            {replyCount !== undefined ? ` (${replyCount})` : ''}
          </button>

          {/* Read more / expand */}
          {!expanded && canOpen && (
            <button
              onClick={() => onSelectThread!(thread.cid)}
              className="text-xs font-mono text-primary-500 hover:text-primary-400 whitespace-nowrap"
            >
              OPEN
            </button>
          )}

          {/* Edit/Delete for owner */}
          {isOwner && !disabled && (
            <>
              <button
                onClick={() => setIsEditing(true)}
                className="text-xs font-mono text-primary-600 hover:text-primary-400 ml-auto"
              >
                EDIT
              </button>
              <button
                onClick={handleDelete}
                disabled={isDeleting}
                className="text-xs font-mono text-red-600 hover:text-red-400 disabled:opacity-50"
              >
                {isDeleting ? 'DELETING...' : 'DELETE'}
              </button>
            </>
          )}
        </div>
      )}

      {/* Reply Thread. Keyed on the announcement's CID — the same identity the vote tally uses —
          so the conversation survives everybody else posting. `group` is the board, which is what
          `HeadSet.group` is for: one board subscription hears the board AND every reply on it. */}
      {showReplies && (
        <ReplyThread
          repliesAddress={repliesAddress}
          votingAddress={votingAddress}
          parentCid={thread.cid}
          group={FORUM_REGISTRY}
          provider={provider}
          signer={signer}
          currentAddress={currentAddress}
          getDisplayName={getDisplayName}
          onSelectUser={onSelectUser}
          disabled={disabled}
          getProfile={getProfile}
          onFollow={onFollow}
          onUnfollow={onUnfollow}
          isFollowing={isFollowing}
          onTip={onTip}
          canTip={canTip}
        />
      )}
    </div>
  );
}
