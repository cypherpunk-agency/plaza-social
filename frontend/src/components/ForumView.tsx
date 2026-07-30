import { useState, useMemo, useEffect } from 'react';
import { useForumThread } from '../hooks/useForumThread';
import { usePublisher } from '../hooks/usePublisher';
import { useVoting } from '../hooks/useVoting';
import { ThreadCard } from './ThreadCard';
import { ThreadDetailView } from './ThreadDetailView';
import type { Provider, Signer } from '../utils/contracts';
import type { Profile } from '../types/contracts';
import toast from 'react-hot-toast';
import { reportError } from '../lib/reportError';

interface ForumViewProps {
  forumThreadAddress: string | null;
  repliesAddress: string | null;
  votingAddress: string | null;
  userRegistryAddress?: string | null;
  provider: Provider | null;
  signer?: Signer | null;
  currentAddress: string | null;
  getDisplayName?: (address: string) => Promise<string>;
  onSelectUser?: (address: string) => void;
  disabled?: boolean;
  // URL param support
  /** The selected thread's announcement CID, projected to `?cid=`. The canonical selection. */
  selectedThreadCid?: string | null;
  /**
   * ⚠️ DEPRECATED, INBOUND ONLY. A position parsed out of an already-published `?thread=N` link.
   * This view is the only place that can resolve it, because it is the only place that has the
   * loaded page, so it maps position → CID and hands the CID back through `onThreadChange`. Nothing
   * ever mints a new one. See `lib/threadLink.ts`.
   */
  legacyThreadIndex?: number | null;
  onThreadChange?: (threadCid: string | null) => void;
  onThreadTitleChange?: (title: string | null) => void;
  // Tooltip props
  getProfile?: (address: string) => Promise<Profile>;
  onFollow?: (address: string) => Promise<void>;
  onUnfollow?: (address: string) => Promise<void>;
  isFollowing?: (address: string) => boolean;
  onTip?: (address: string) => void;
  canTip?: boolean;
}

export function ForumView({
  forumThreadAddress,
  repliesAddress,
  votingAddress,
  userRegistryAddress,
  provider,
  signer,
  currentAddress,
  getDisplayName,
  onSelectUser,
  disabled = false,
  selectedThreadCid = null,
  legacyThreadIndex = null,
  onThreadChange,
  onThreadTitleChange,
  // Tooltip props
  getProfile,
  onFollow,
  onUnfollow,
  isFollowing,
  onTip,
  canTip = false,
}: ForumViewProps) {
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newTags, setNewTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  /**
   * ⚠️ SEPARATE FROM `disabled`. `disabled` covers the read-only session and also gates the per-card
   * controls; this is specifically "can a new thread be published right now". They come apart on a
   * session that is signed in but whose host-signed write path never came up — offering + NEW THREAD
   * there is a control that can only fail.
   */
  const canCreateThread = !!usePublisher();

  const {
    threads,
    isLoading,
    error,
    replyCounts,
    refresh,
    createThread,
    editThread,
    deleteThread,
  } = useForumThread({
    forumThreadAddress,
    provider,
    signer,
    getDisplayName,
    userRegistryAddress,
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

  const handleAddTag = () => {
    const tag = tagInput.trim().toLowerCase();
    if (tag && !newTags.includes(tag) && newTags.length < 5 && tag.length <= 32) {
      setNewTags([...newTags, tag]);
      setTagInput('');
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setNewTags(newTags.filter(t => t !== tagToRemove));
  };

  const handleCreateThread = async () => {
    if (!newTitle.trim() || !newContent.trim() || isCreating) return;

    setIsCreating(true);
    try {
      await createThread(newTitle, newContent, newTags);
      setNewTitle('');
      setNewContent('');
      setNewTags([]);
      setTagInput('');
      setShowCreateForm(false);
      toast.success('Thread created');
    } catch (error) {
      // ⚠️ NOT `toast.error('Failed to create thread')`. That sentence was the end of the trail: the
      // real cause lived only in a console nobody can open on a phone. `reportError` keeps the toast
      // short, makes it tap-to-copy, and files the detail in Settings → RECENT ERRORS.
      reportError('create thread', error);
    } finally {
      setIsCreating(false);
    }
  };

  const handleEditThread = async (threadIndex: number, newContent: string) => {
    await editThread(threadIndex, newContent);
  };

  const handleDeleteThread = async (threadIndex: number) => {
    await deleteThread(threadIndex);
  };

  // Find the selected thread — by CID, which is the thread's identity. Never by position.
  const selectedThread = useMemo(() => {
    if (!selectedThreadCid) return null;
    return threads.find(t => t.cid === selectedThreadCid) || null;
  }, [threads, selectedThreadCid]);

  /**
   * Resolve a deprecated `?thread=N` link to a CID, once and only once.
   *
   * This is the ONLY place a position can be turned into an identity, because it is the only place
   * that holds the loaded page. Handing the CID back through `onThreadChange` puts it into the same
   * state the URL effect projects, so the address bar swaps `?thread=N` for `?cid=…` by itself —
   * nothing here calls `pushState`, and nothing should.
   *
   * An index with no thread behind it resolves to `null` rather than being left pending forever.
   */
  useEffect(() => {
    if (selectedThreadCid || legacyThreadIndex === null) return;
    if (isLoading || threads.length === 0) return;
    const match = threads.find(t => t.index === legacyThreadIndex);
    onThreadChange?.(match?.cid ?? null);
  }, [selectedThreadCid, legacyThreadIndex, threads, isLoading, onThreadChange]);

  /**
   * A `?cid=` that is not in the loaded page. Real and expected: the page is capped at 50 chains,
   * and a body that has not resolved yet has no CID to match. Saying "not in this page" beats
   * silently dropping the selection, which would make a correct shared link look broken.
   */
  const selectionMissing =
    !!selectedThreadCid && !selectedThread && !isLoading && threads.length > 0;

  // Notify parent of thread title for page title
  useEffect(() => {
    if (selectedThread && onThreadTitleChange) {
      onThreadTitleChange(selectedThread.title);
    } else if (onThreadTitleChange) {
      onThreadTitleChange(null);
    }
  }, [selectedThread, onThreadTitleChange]);

  // Handle thread selection. Takes the CID; see `ThreadCard.onSelectThread`.
  const handleSelectThread = (threadCid: string) => {
    onThreadChange?.(threadCid);
  };

  // Handle going back to list
  const handleBackToList = () => {
    onThreadChange?.(null);
  };

  if (!forumThreadAddress) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8">
        <div className="text-primary-500 text-4xl mb-4">[FORUM]</div>
        <div className="text-primary-600 font-mono text-sm">
          Forum not available. Contract not deployed.
        </div>
      </div>
    );
  }

  /**
   * ⚠️ MOBILE FIRST, AND THAT IS A LAYOUT DECISION, NOT A STYLE ONE.
   *
   * Plaza's primary surface is the Polkadot host container, which is a phone app. So the BASE state
   * of this markup is the phone behaviour that already existed — one column; tapping a thread
   * replaces the list; BACK returns — and the two-pane split is layered on at `xl` (1280px), the
   * width at which a 24rem list plus a 70ch detail measure both fit next to the sidebar. Below that
   * the split is simply absent, not squeezed.
   *
   * `hidden` / `flex` do the switching so that the detail pane is MOUNTED ONCE and only once: the
   * alternative (a JS media query picking between two subtrees) remounts `ReplyThread` on every
   * resize across the breakpoint, throwing away its loaded replies.
   */
  const paneOpen = !!selectedThreadCid;

  const detailPane = selectedThread ? (
    <ThreadDetailView
      thread={selectedThread}
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
      onEdit={handleEditThread}
      onDelete={handleDeleteThread}
      onSelectUser={onSelectUser}
      onBack={handleBackToList}
      getDisplayName={getDisplayName}
      disabled={disabled}
      getProfile={getProfile}
      onFollow={onFollow}
      onUnfollow={onUnfollow}
      isFollowing={isFollowing}
      onTip={onTip}
      canTip={canTip}
    />
  ) : selectionMissing ? (
    <div className="flex flex-col items-center justify-center h-full text-center p-8 font-mono">
      <div className="text-primary-500 mb-2">THREAD NOT IN THIS PAGE</div>
      <p className="text-primary-600 text-xs max-w-[60ch]">
        The link points at a thread the forum has not loaded — the board reads the 50 most recent
        chains, and a body that has not resolved yet has no CID to match. Try REFRESH.
      </p>
      <button
        onClick={handleBackToList}
        className="mt-4 px-3 py-1 text-xs text-primary-500 border border-primary-600 hover:border-primary-400"
      >
        BACK TO FORUM
      </button>
    </div>
  ) : paneOpen ? (
    <div className="flex items-center justify-center h-full text-primary-600 font-mono text-sm">
      LOADING THREAD...
    </div>
  ) : (
    // Only ever visible in the two-pane layout: below `xl` an unselected pane is `hidden`.
    <div className="flex items-center justify-center h-full text-primary-700 font-mono text-sm p-8 text-center">
      Select a thread to read it here.
    </div>
  );

  return (
    <div className="flex h-full min-w-0 overflow-hidden">
      {/* ── LIST COLUMN ───────────────────────────────────────────────────────────────────────── */}
      <div
        className={`${paneOpen ? 'hidden xl:flex' : 'flex'} flex-col h-full min-w-0 flex-1 xl:flex-none xl:w-[24rem] 2xl:w-[28rem] xl:border-r xl:border-primary-800`}
      >
      {/* Header */}
      <div className="px-4 py-3 border-b border-primary-700">
        <div className="flex items-center justify-between">
          <div className="font-mono">
            <span className="text-primary-500 text-lg">[FORUM]</span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={refresh}
              disabled={isLoading}
              className="px-3 py-1 text-xs font-mono text-primary-500 border border-primary-600 hover:border-primary-400 disabled:opacity-50"
            >
              {isLoading ? 'LOADING...' : 'REFRESH'}
            </button>
            {!disabled && canCreateThread && !showCreateForm && (
              <button
                onClick={() => setShowCreateForm(true)}
                className="px-3 py-1 text-xs font-mono text-primary-400 border border-primary-500 hover:bg-primary-900"
              >
                + NEW THREAD
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Create Thread Form */}
      {showCreateForm && (
        <div className="border-b border-primary-700 p-4 bg-primary-950">
          <div className="font-mono text-sm text-primary-400 mb-3">CREATE NEW THREAD</div>

          <div className="mb-3">
            <label className="block text-xs font-mono text-primary-600 mb-1">TITLE (max 200 chars)</label>
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Thread title..."
              className="w-full px-3 py-2 bg-black border border-primary-600 text-primary-400 font-mono text-sm focus:outline-none focus:border-primary-400"
              maxLength={200}
              disabled={isCreating}
            />
          </div>

          <div className="mb-3">
            <label className="block text-xs font-mono text-primary-600 mb-1">CONTENT (max 40,000 chars)</label>
            <textarea
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder="Thread content..."
              className="w-full min-h-[120px] px-3 py-2 bg-black border border-primary-600 text-primary-400 font-mono text-sm focus:outline-none focus:border-primary-400 resize-y"
              maxLength={40000}
              disabled={isCreating}
            />
            <div className="text-xs font-mono text-primary-600 mt-1">
              {newContent.length.toLocaleString()} / 40,000
            </div>
          </div>

          <div className="mb-3">
            <label className="block text-xs font-mono text-primary-600 mb-1">
              TAGS (max 5, each max 32 chars)
            </label>
            <div className="flex gap-2 mb-2">
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddTag();
                  }
                }}
                placeholder="Add a tag..."
                className="flex-1 px-3 py-2 bg-black border border-primary-600 text-primary-400 font-mono text-sm focus:outline-none focus:border-primary-400"
                maxLength={32}
                disabled={isCreating || newTags.length >= 5}
              />
              <button
                type="button"
                onClick={handleAddTag}
                disabled={isCreating || newTags.length >= 5 || !tagInput.trim()}
                className="px-3 py-2 text-xs font-mono text-primary-500 border border-primary-600 hover:border-primary-400 disabled:opacity-50"
              >
                ADD
              </button>
            </div>
            {newTags.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {newTags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs font-mono bg-primary-900 text-primary-400 border border-primary-700"
                  >
                    {tag}
                    <button
                      type="button"
                      onClick={() => handleRemoveTag(tag)}
                      disabled={isCreating}
                      className="text-primary-600 hover:text-primary-400"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleCreateThread}
              disabled={isCreating || !newTitle.trim() || !newContent.trim()}
              className="px-4 py-2 text-xs font-mono text-primary-400 border border-primary-500 hover:bg-primary-900 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isCreating ? 'CREATING...' : 'CREATE THREAD'}
            </button>
            <button
              onClick={() => {
                setShowCreateForm(false);
                setNewTitle('');
                setNewContent('');
                setNewTags([]);
                setTagInput('');
              }}
              disabled={isCreating}
              className="px-4 py-2 text-xs font-mono text-primary-600 border border-primary-700 hover:border-primary-500"
            >
              CANCEL
            </button>
          </div>
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="p-4 text-center">
          <div className="text-red-500 font-mono text-sm mb-2">ERROR: {error}</div>
          <button
            onClick={refresh}
            className="px-4 py-2 text-xs font-mono text-primary-400 border border-primary-500 hover:bg-primary-900"
          >
            RETRY
          </button>
        </div>
      )}

      {/* Loading State */}
      {isLoading && threads.length === 0 && !error && (
        <div className="flex items-center justify-center h-full">
          <div className="text-primary-500 font-mono">LOADING THREADS...</div>
        </div>
      )}

      {/* Threads List */}
      {!error && (
        <div className="flex-1 overflow-y-auto p-4 min-w-0">
          {threads.length === 0 && !isLoading ? (
            <div className="text-center text-primary-600 font-mono py-8">
              No threads yet. Be the first to start a discussion!
            </div>
          ) : (
            <div className="space-y-4 min-w-0">
              {threads.map((thread) => (
                <ThreadCard
                  // ⚠️ Keyed on the CID, not the index. `index` is a slot in the loaded page, so
                  // keying on it makes React reuse thread A's card state — expanded replies, a
                  // half-typed edit — for thread B the moment somebody else posts.
                  key={thread.cid || `idx-${thread.index}`}
                  thread={thread}
                  isSelected={!!thread.cid && thread.cid === selectedThreadCid}
                  replyCount={thread.cid ? replyCounts[thread.cid] : undefined}
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
                  onEdit={handleEditThread}
                  onDelete={handleDeleteThread}
                  onSelectUser={onSelectUser}
                  onSelectThread={handleSelectThread}
                  getDisplayName={getDisplayName}
                  disabled={disabled}
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
      )}
      </div>

      {/* ── DETAIL PANE ───────────────────────────────────────────────────────────────────────── */}
      <div
        className={`${paneOpen ? 'flex' : 'hidden xl:flex'} flex-col h-full min-w-0 flex-1 bg-black`}
      >
        {detailPane}
      </div>
    </div>
  );
}
