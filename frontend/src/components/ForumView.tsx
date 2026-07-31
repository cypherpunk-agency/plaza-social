import { useState, useMemo, useEffect } from 'react';
import { useForumThread } from '../hooks/useForumThread';
import { usePublisher } from '../hooks/usePublisher';
import { useVoting } from '../hooks/useVoting';
import { ThreadCard } from './ThreadCard';
import { ThreadComposer } from './ThreadComposer';
import { ThreadDetailView } from './ThreadDetailView';
import { PANE_HEADER } from './paneChrome';
import { CollectionStatus } from './CollectionStatus';
import { useCollectionState } from './collectionState';
import type { Provider, Signer } from '../utils/contracts';
import type { Profile } from '../types/contracts';
import toast from 'react-hot-toast';

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
  /**
   * Is the composer open? The DRAFT is not here — it lives inside `ThreadComposer` and dies with it.
   *
   * ⚠️ This flag is a PANE STATE, not a strip toggle. It feeds `paneOpen` below, which is what makes
   * the list column narrow at `xl` and disappear on a phone. See `ThreadComposer` for the rule about
   * what happens to an open thread while the composer has the pane.
   */
  const [showComposer, setShowComposer] = useState(false);

  /**
   * ⚠️ SEPARATE FROM `disabled`. `disabled` covers the read-only session and also gates the per-card
   * controls; this is specifically "can a new thread be published right now". They come apart on a
   * session that is signed in but whose host-signed write path never came up — offering + NEW THREAD
   * there is a control that can only fail.
   */
  const canCreateThread = !!usePublisher();

  /**
   * ⚠️ `replyCounts` IS NOT READ HERE ANY MORE, AND THAT IS WHY `countReplies` IS NOT PASSED.
   *
   * The list card used to carry a `[+] REPLIES (n)` expander; replies are the detail pane's job now,
   * so the count has no consumer. The count is not a cheap read — `getHeadsPaged` on a thread's reply
   * registry returns one head per REPLIER, so an accurate number means walking 25 chains and fetching
   * their bodies. Leaving that switched on would be 25 chain walks per board load feeding nothing.
   * If a count ever comes back to the list, pass `countReplies: true` and read `replyCounts`.
   */
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

  /**
   * ⭐ SESSION-NOT-READY IS A THIRD STATE. See `collectionState.ts` for the whole story; the short
   * version is that `isLoading` is the COLD flag and `useForumThread`'s loader returns before
   * raising it while there is no chain reader — so the old `threads.length === 0 && !isLoading`
   * empty branch fired during startup and told the reader their forum was empty. Reported from a
   * phone, where the startup window is seconds long.
   *
   * `ready` mirrors the hook's own guard exactly: `createReadContract` returns null without BOTH an
   * address and a reader, and the cold effect keys on `forumThreadAddress && provider`.
   */
  const sessionReady = !!provider && !!forumThreadAddress;

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

  const listState = useCollectionState({
    ready: sessionReady,
    isLoading,
    count: threads.length,
    error,
    subject: forumThreadAddress,
  });

  /**
   * The CID we just published, held only until it shows up on the board.
   *
   * ⚠️ THIS IS NOT AN IDENTITY MECHANISM — `createThread` returns the CID and we select it
   * directly. This exists for ONE thing: `selectionMissing` below renders "THREAD NOT IN THIS PAGE"
   * for a `?cid=` the loaded page does not contain, and a thread published a moment ago is exactly
   * that until the board read lands. Telling an author their own brand-new thread is missing is the
   * worst possible moment to be pessimistic, so while this matches the selection we render the
   * LOADING branch instead. Cleared the instant the row appears — see the effect below.
   */
  const [justPublishedCid, setJustPublishedCid] = useState<string | null>(null);

  /**
   * Publish, then hand the pane over to the new thread — BY ITS CID, which `createThread` returns.
   *
   * ⚠️ MUST REJECT on failure — `ThreadComposer` keeps the draft on screen and calls `reportError`
   * off the rejection. Swallowing the error here would close the composer over a thread that was
   * never written. Note that an unconfirmed publish rejects too, so reaching the lines below means
   * the head move is on chain and visible to the read RPC.
   */
  const handleCreateThread = async (title: string, content: string, tags: string[]) => {
    const cid = await createThread(title, content, tags);
    // Order matters only in that all of this happens after the await: closing first would unmount
    // the composer while its submit handler is still running.
    setJustPublishedCid(cid);
    onThreadChange?.(cid);
    setShowComposer(false);
    toast.success('Thread created');
  };

  const handleCancelComposer = () => {
    setShowComposer(false);
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
   * Retire the just-published marker as soon as it has served its purpose.
   *
   * Two ways out, and both must be here or the marker outlives the publish: the row lands on the
   * board (the normal case — `createThread` refreshes before it resolves, so this is usually true on
   * the very first render after the selection), or the reader navigates somewhere else, in which
   * case a stale marker would suppress a genuine "not in this page" for an unrelated link.
   */
  useEffect(() => {
    if (!justPublishedCid) return;
    if (selectedThreadCid !== justPublishedCid || selectedThread) setJustPublishedCid(null);
  }, [justPublishedCid, selectedThreadCid, selectedThread]);

  /**
   * A `?cid=` that is not in the loaded page. Real and expected: the page is capped at 50 chains,
   * and a body that has not resolved yet has no CID to match. Saying "not in this page" beats
   * silently dropping the selection, which would make a correct shared link look broken.
   *
   * ⚠️ EXCEPT FOR THE THREAD THAT WAS JUST PUBLISHED. `isLoading` is the COLD flag and stays false
   * through a background refresh, so between selecting a new thread and the board committing the
   * row, this predicate is otherwise true — and it would tell the author that what they just wrote
   * is not here. The publish is already confirmed on chain at that point, so "loading" is the
   * accurate word and the 30-second poll settles it.
   */
  const selectionMissing =
    !!selectedThreadCid &&
    !selectedThread &&
    !isLoading &&
    threads.length > 0 &&
    selectedThreadCid !== justPublishedCid;

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
   *
   * ⚠️ `paneOpen` IS NOT "A THREAD IS SELECTED" ANY MORE. It is "the right-hand pane has something in
   * it", and the COMPOSER counts. It drives BOTH columns' visibility, so leaving the composer out of
   * it would mean the list column never narrows at `xl` and — much worse — stays full-width on a
   * phone, covering the composer the user just opened. `threadPaneOpen` is the narrower question,
   * and only the "LOADING THREAD..." branch below still wants it.
   */
  const threadPaneOpen = !!selectedThreadCid;
  const paneOpen = threadPaneOpen || showComposer;

  const detailPane = showComposer ? (
    // The composer WINS the pane. It does not clear `selectedThreadCid`, so cancelling drops
    // straight back onto the thread below. See the header comment in `ThreadComposer`.
    <ThreadComposer onCreate={handleCreateThread} onCancel={handleCancelComposer} />
  ) : selectedThread ? (
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
  ) : threadPaneOpen ? (
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
      {/* Header. Height comes from `PANE_HEADER`, not from content — its border and the detail
          pane's are one continuous rule and must not drift. See `paneChrome.ts`. */}
      <div className={PANE_HEADER}>
        <div className="flex items-center justify-between w-full">
          <div className="font-mono">
            <span className="text-primary-500 text-lg">[FORUM]</span>
          </div>
          <div className="flex gap-2">
            {/* Disabled while the session is still coming up too: without a chain reader `refresh`
                returns without reading anything, so an enabled button would be a control that
                silently does nothing. */}
            <button
              onClick={refresh}
              disabled={isLoading || !sessionReady}
              className="px-3 py-1 text-xs font-mono text-primary-500 border border-primary-600 hover:border-primary-400 disabled:opacity-50"
            >
              {isLoading ? 'LOADING...' : 'REFRESH'}
            </button>
            {!disabled && canCreateThread && !showComposer && (
              <button
                type="button"
                onClick={() => setShowComposer(true)}
                className="px-3 py-1 text-xs font-mono text-primary-400 border border-primary-500 hover:bg-primary-900"
              >
                + NEW THREAD
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ⚠️ THE CREATE FORM IS NOT HERE ANY MORE. It is `ThreadComposer`, rendered into the DETAIL
          pane below — inline here it pushed the board down on a phone and left the 70ch pane empty
          at `xl`. Do not re-add a composer to this column. */}

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

      {/* Threads List.
          ⛔ THE EMPTY MESSAGE IS NOT REACHABLE FROM `threads.length === 0` ANY MORE, and that is the
          whole point of this change. `CollectionStatus` renders CONNECTING while there is no chain
          reader, LOADING THREADS while a cold read is in flight, and only says "no threads yet"
          once a read has actually completed and come back with nothing. See `collectionState.ts`.
          ⛔ Nothing here consults `isRefreshing`: the 30s poll must never replace the rows. */}
      {!error && (
        <div className="flex-1 overflow-y-auto p-4 min-w-0">
          <CollectionStatus
            state={listState}
            noun="THREADS"
            empty="No threads yet. Be the first to start a discussion!"
          />
          {listState === 'ready' && (
            <div className="space-y-4 min-w-0">
              {threads.map((thread) => (
                <ThreadCard
                  // ⚠️ Keyed on the CID, not the index. `index` is a slot in the loaded page, so
                  // keying on it makes React reuse thread A's card state — expanded replies, a
                  // half-typed edit — for thread B the moment somebody else posts.
                  key={thread.cid || `idx-${thread.index}`}
                  thread={thread}
                  isSelected={!!thread.cid && thread.cid === selectedThreadCid}
                  provider={provider}
                  getVoteTally={getVoteTally}
                  getUserVote={getUserVote}
                  vote={vote}
                  removeVote={removeVote}
                  isVoting={isVoting}
                  onSelectUser={onSelectUser}
                  onSelectThread={handleSelectThread}
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
