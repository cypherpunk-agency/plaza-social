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
  selectedThreadFromUrl?: number | null;
  onThreadChange?: (threadIndex: number | null) => void;
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
  selectedThreadFromUrl,
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

  // Use URL param if provided, otherwise use internal state
  const selectedThreadIndex = selectedThreadFromUrl ?? null;

  const {
    threads,
    isLoading,
    error,
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

  // Find the selected thread
  const selectedThread = useMemo(() => {
    if (selectedThreadIndex === null) return null;
    return threads.find(t => t.index === selectedThreadIndex) || null;
  }, [threads, selectedThreadIndex]);

  // Notify parent of thread title for page title
  useEffect(() => {
    if (selectedThread && onThreadTitleChange) {
      onThreadTitleChange(selectedThread.title);
    } else if (onThreadTitleChange) {
      onThreadTitleChange(null);
    }
  }, [selectedThread, onThreadTitleChange]);

  // Handle thread selection
  const handleSelectThread = (threadIndex: number) => {
    onThreadChange?.(threadIndex);
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

  // Show thread detail view when a thread is selected
  if (selectedThread) {
    return (
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
    );
  }

  return (
    <div className="flex flex-col h-full">
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
        <div className="flex-1 overflow-y-auto p-4">
          {threads.length === 0 && !isLoading ? (
            <div className="text-center text-primary-600 font-mono py-8">
              No threads yet. Be the first to start a discussion!
            </div>
          ) : (
            <div className="space-y-4">
              {threads.map((thread) => (
                <ThreadCard
                  key={thread.index}
                  thread={thread}
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
  );
}
