import { useState, useMemo, useRef, useEffect } from 'react';
import type { ForumThread, VoteType, VoteTally, Profile } from '../types/contracts';
import { VotingWidget } from './VotingWidget';
import { ReplyThread } from './ReplyThread';
import { UserLink } from './UserAddress';
import { PANE_HEADER } from './paneChrome';
import { formatTimestamp } from '../utils/formatters';
import type { Provider, Signer } from '../utils/contracts';
import { entityIdOfCid } from '../lib/entity';
import { FORUM_REGISTRY } from '../lib/registry';
import { threadShareUrl } from '../lib/threadLink';
import { copyTextVerified, type CopyOutcome } from '../lib/clipboard';
import { reportError } from '../lib/reportError';
import toast from 'react-hot-toast';

interface ThreadDetailViewProps {
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
  onBack: () => void;
  getDisplayName?: (address: string) => Promise<string>;
  disabled?: boolean;
  // Tooltip props
  getProfile?: (address: string) => Promise<Profile>;
  onFollow?: (address: string) => Promise<void>;
  onUnfollow?: (address: string) => Promise<void>;
  isFollowing?: (address: string) => boolean;
  onTip?: (address: string) => void;
  canTip?: boolean;
}

export function ThreadDetailView({
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
  onBack,
  getDisplayName,
  disabled = false,
  // Tooltip props
  getProfile,
  onFollow,
  onUnfollow,
  isFollowing,
  onTip,
  canTip = false,
}: ThreadDetailViewProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(thread.content);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  /**
   * What the last COPY LINK press did. `null` is the resting state.
   *
   * ⚠️ THE SUCCESS PATH IS SILENT APART FROM THE BUTTON. It used to open a panel on EVERY outcome,
   * on the theory that the host hides the address bar so the user needs to see the link. That was
   * wrong about which problem it was solving: a user who just copied a link does not need to read
   * it, and `unverified` is the *normal* outcome (reading the clipboard back would prompt them), so
   * the panel fired on essentially every press. It now reads as feedback, not as a dialog — the
   * button confirms in place and resets itself.
   *
   * ⛔ `failed` STILL OPENS THE PANEL, AND MUST. `Clipboard` is a host device permission and a
   * missing one fails silently; inside the container the address bar belongs to the dot.li shell,
   * so with no clipboard and no URL bar the panel is the ONLY way to get the link out. Deleting it
   * would turn a denied permission into a button that does nothing at all.
   */
  const [copyState, setCopyState] = useState<CopyOutcome | null>(null);
  const shareInputRef = useRef<HTMLInputElement | null>(null);

  const isOwner = currentAddress?.toLowerCase() === thread.author.toLowerCase();

  const shareUrl = useMemo(() => threadShareUrl(thread.cid), [thread.cid]);

  // Reset when the pane switches to a different thread — a stale "COPIED", or worse a stale link
  // under a new title, is worse than nothing.
  useEffect(() => {
    setCopyState(null);
  }, [thread.cid]);

  // The in-place confirmation is transient. The failure panel is NOT — it is the fallback path and
  // stays until dismissed or until the thread changes.
  useEffect(() => {
    if (copyState !== 'copied' && copyState !== 'unverified') return;
    const timer = setTimeout(() => setCopyState(null), 2000);
    return () => clearTimeout(timer);
  }, [copyState]);

  // Pre-select the text so the manual path is one gesture, not three.
  useEffect(() => {
    if (copyState === 'failed' && shareInputRef.current) {
      shareInputRef.current.focus();
      shareInputRef.current.select();
    }
  }, [copyState]);

  const handleCopyLink = async () => {
    if (!shareUrl) return;
    const outcome = await copyTextVerified(shareUrl);
    setCopyState(outcome);
    if (outcome === 'failed') {
      // A real failure, reported the way every other failure in this app is: short toast,
      // tap-to-copy detail, durable entry under Settings → RECENT ERRORS.
      reportError(
        'copy thread link',
        new Error(
          'The clipboard rejected the write, or accepted it and kept something else. Inside the ' +
            'Polkadot host container this usually means the Clipboard device permission was not ' +
            'granted. The link is shown below and can be selected manually.',
        ),
      );
    }
  };

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
      onBack();
    } catch (error) {
      console.error('Failed to delete thread:', error);
      toast.error('Failed to delete thread');
      setIsDeleting(false);
    }
  };

  if (thread.isDeleted) {
    return (
      <div className="flex flex-col h-full">
        {/* Same shared height as the live header — a deleted thread must not shift the rule. */}
        <div className={PANE_HEADER}>
          <button
            onClick={onBack}
            className="text-sm font-mono text-primary-500 hover:text-primary-400"
          >
            &larr; BACK TO FORUM
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <span className="text-primary-700 font-mono italic">[THREAD DELETED]</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-w-0">
      {/* Header: back, share, identity. Height comes from `PANE_HEADER`, not from content — its
          border and the list column's are one continuous rule. See `paneChrome.ts`. */}
      <div className={`${PANE_HEADER} flex-wrap gap-3`}>
        <button
          onClick={onBack}
          className="text-sm font-mono text-primary-500 hover:text-primary-400 whitespace-nowrap"
        >
          {/* On a phone this button IS the navigation — the detail replaced the list. In the
              two-pane layout it just clears the pane, which is why the wording differs. */}
          <span className="xl:hidden">&larr; BACK TO FORUM</span>
          <span className="hidden xl:inline">&larr; CLOSE</span>
        </button>

        {shareUrl && (
          <button
            type="button"
            onClick={handleCopyLink}
            className="text-sm font-mono text-primary-500 border border-primary-700 hover:border-primary-500 px-2 py-0.5 whitespace-nowrap transition-colors"
            title={
              copyState === 'unverified'
                ? 'Copied. Confirming it would have meant reading your clipboard back, which prompts you, so this is not verified.'
                : 'Copy a link that opens this thread inside Plaza'
            }
          >
            {/* The whole success path lives here. `aria-live` so the change is announced rather
                than only seen — the label is the only confirmation there is now. */}
            <span aria-live="polite">
              {copyState === 'copied' || copyState === 'unverified' ? 'COPIED' : 'COPY LINK'}
            </span>
          </button>
        )}

        {thread.cid && (
          <span className="text-primary-700 font-mono text-xs ml-auto" title={thread.cid}>
            {thread.cid.slice(0, 10)}…
          </span>
        )}
      </div>

      {/* ⛔ FAILURE FALLBACK — the ONLY thing that opens this panel. Do not widen it back out to the
          other two outcomes; that is the noise the panel was reported for. Do not remove it either:
          with no clipboard and no visible address bar there is otherwise no way to get the link. */}
      {shareUrl && copyState === 'failed' && (
        <div className="px-4 py-3 border-b border-primary-800 bg-primary-950 font-mono text-xs min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <input
              ref={shareInputRef}
              readOnly
              value={shareUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 min-w-0 px-2 py-1 bg-black border border-primary-700 text-primary-300 font-mono text-xs focus:outline-none focus:border-primary-400"
            />
            <button
              type="button"
              onClick={() => setCopyState(null)}
              className="text-primary-600 hover:text-primary-400 px-1 transition-colors"
              title="Hide"
            >
              ×
            </button>
          </div>
          <p className="mt-2 max-w-[70ch] text-red-400">
            NOT copied. The clipboard refused, or accepted and kept something else — inside the
            Polkadot host that usually means the Clipboard permission was not granted. Select the
            link above and copy it manually.
          </p>
          <p className="mt-1 text-primary-700 max-w-[70ch]">
            A <code>.dot</code> link opens the thread inside Plaza; the <code>.dev-dot.li</code>{' '}
            address would open a browser next to it.
          </p>
        </div>
      )}

      {/* Thread content */}
      <div className="flex-1 overflow-y-auto min-w-0">
        {/* `p-4` on a phone, `p-6` once there is room. 24px of padding on each side of a 210px
            column is 23% of the readable width. */}
        <div className="p-4 xl:p-6 max-w-[80ch] min-w-0">
          {/* Title */}
          <h1 className="text-2xl font-mono text-primary-300 mb-4 break-words max-w-[70ch]">
            {thread.title}
          </h1>

          {/* Meta info */}
          <div className="flex items-center flex-wrap gap-3 font-mono text-sm mb-6 pb-4 border-b border-primary-800">
            {onSelectUser && (
              <UserLink
                address={thread.author}
                displayName={thread.displayName}
                onSelectUser={onSelectUser}
                size="sm"
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
          </div>

          {/* Tags */}
          {thread.tags && thread.tags.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-6">
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

          {/* Content or Edit Form */}
          {isEditing ? (
            <div className="mb-6">
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="w-full min-h-[200px] px-3 py-2 bg-black border border-primary-600 text-primary-400 font-mono text-sm focus:outline-none focus:border-primary-400 resize-y"
                maxLength={40000}
                disabled={isSaving}
              />
              <div className="flex justify-between items-center mt-2">
                <span className="text-xs font-mono text-primary-600">
                  {editContent.length.toLocaleString()} / 40,000
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={handleSaveEdit}
                    disabled={isSaving || !editContent.trim()}
                    className="px-4 py-2 text-sm font-mono text-primary-400 border border-primary-500 hover:bg-primary-900 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isSaving ? 'SAVING...' : 'SAVE'}
                  </button>
                  <button
                    onClick={() => {
                      setIsEditing(false);
                      setEditContent(thread.content);
                    }}
                    disabled={isSaving}
                    className="px-4 py-2 text-sm font-mono text-primary-600 border border-primary-700 hover:border-primary-500"
                  >
                    CANCEL
                  </button>
                </div>
              </div>
            </div>
          ) : (
            /* ⚠️ THE CAP APPLIES HERE TOO. A wide detail pane is not licence for a 200-character
               line; 60–80 characters is the comfortable measure regardless of how much room there
               is. `ch` units track the font size set in `index.css`. */
            <div className="text-sm text-primary-300 font-mono whitespace-pre-wrap break-words mb-6 leading-relaxed max-w-[70ch]">
              {thread.content}
            </div>
          )}

          {/* Actions Row */}
          {!isEditing && (
            <div className="flex items-center flex-wrap gap-4 py-4 border-t border-primary-800 border-b border-primary-800 mb-6">
              {/* Voting.
                  ⚠️ `compact` — WITHOUT IT THIS RENDERS STACKED. `VotingWidget`'s default is
                  `flex-col`, i.e. the tall Reddit-style gutter arrangement, which only reads as
                  deliberate when it sits in a gutter. Dropped into a horizontal actions row it
                  looks like a broken control. `ThreadCard` has always passed `compact`; this was
                  the one call site that did not. */}
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

              {/* Edit/Delete for owner */}
              {isOwner && !disabled && (
                <div className="flex gap-3 ml-auto">
                  <button
                    onClick={() => setIsEditing(true)}
                    className="text-sm font-mono text-primary-600 hover:text-primary-400"
                  >
                    EDIT
                  </button>
                  <button
                    onClick={handleDelete}
                    disabled={isDeleting}
                    className="text-sm font-mono text-red-600 hover:text-red-400 disabled:opacity-50"
                  >
                    {isDeleting ? 'DELETING...' : 'DELETE'}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Replies Section. Keyed on the announcement's CID, grouped under the board. */}
          <div>
              <h2 className="text-sm font-mono text-primary-500 mb-4">REPLIES</h2>
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
          </div>
        </div>
      </div>
    </div>
  );
}
