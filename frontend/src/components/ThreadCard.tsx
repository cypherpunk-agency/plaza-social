import { useMemo } from 'react';
import type { ForumThread, VoteType, VoteTally, Profile } from '../types/contracts';
import { VotingWidget } from './VotingWidget';
import { UserLink } from './UserAddress';
import { formatTimestamp } from '../utils/formatters';
import type { Provider } from '../utils/contracts';
import { entityIdOfCid } from '../lib/entity';

/**
 * A row in the forum LIST. It is a summary and a link, nothing else.
 *
 * ⚠️ WHAT THIS COMPONENT DELIBERATELY NO LONGER HAS, so it does not get added back:
 * EDIT, DELETE, OPEN and the `[+] REPLIES (n)` expander all lived here before the detail pane
 * existed. `ThreadDetailView` now owns every one of them, and a list row that duplicates the
 * detail pane is a row full of controls competing with the only thing it is for — opening the
 * thread. The CID went too: it identified nothing to a reader, and it sat in the byline as a
 * 10-character run of dead text that people tried to tap.
 *
 * The one interactive thing that stays is the vote widget, because voting from the list is a real
 * shortcut rather than a duplicate of the detail view.
 */

interface ThreadCardProps {
  thread: ForumThread;
  provider: Provider | null;
  // Voting functions
  getVoteTally: (entityId: string) => Promise<VoteTally>;
  getUserVote: (entityId: string) => Promise<VoteType>;
  vote: (entityId: string, voteType: VoteType) => Promise<void>;
  removeVote: (entityId: string) => Promise<void>;
  isVoting: boolean;
  // Actions
  onSelectUser?: (address: string) => void;
  /**
   * ⚠️ TAKES THE CID, NOT THE INDEX. `index` is a position in the loaded page and changes whenever
   * anybody else posts; the announcement CID is the thread's identity and is what `?cid=` carries.
   */
  onSelectThread?: (threadCid: string) => void;
  disabled?: boolean;
  /** Highlighted because it is the thread open in the detail pane. Two-pane layouts only. */
  isSelected?: boolean;
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
  provider,
  getVoteTally,
  getUserVote,
  vote,
  removeVote,
  isVoting,
  onSelectUser,
  onSelectThread,
  disabled = false,
  isSelected = false,
  // Tooltip props
  getProfile,
  onFollow,
  onUnfollow,
  isFollowing,
  onTip,
  canTip = false,
}: ThreadCardProps) {
  // A vote is cast on the BYTES, so the tally is keyed on the CID. Pure keccak — no round trip, no
  // failure mode, and the count is right on the first paint. See `lib/entity.ts`.
  const entityId = useMemo(() => entityIdOfCid(thread.cid) ?? '', [thread.cid]);

  if (thread.isDeleted) {
    return (
      <div className="border border-primary-800 bg-black p-4 font-mono">
        <span className="text-primary-700 italic">[THREAD DELETED]</span>
      </div>
    );
  }

  const canOpen = !!onSelectThread && !!thread.cid;

  return (
    /**
     * ⚠️ `relative` IS LOAD-BEARING — it is what the title button's stretched `::after` measures
     * itself against. See the button below.
     */
    <article
      className={`relative border bg-black p-4 transition-colors min-w-0 ${
        isSelected
          ? 'border-primary-400 bg-primary-950'
          : 'border-primary-700 hover:border-primary-500'
      }`}
    >
      {/* Title. ⚠️ `break-words` is not cosmetic: a title can be a bare CID, and an unbreakable
          64-character token in a 375px column pushes the whole page into horizontal scroll. */}
      <h3 className="text-lg font-mono text-primary-300 mb-2 break-words">
        {canOpen ? (
          /**
           * ⚠️ THE WHOLE CARD IS THIS ONE BUTTON. Do not go back to hanging `onClick` on the `h3`
           * and the excerpt `div`.
           *
           * That is what was here before, and it is why clicking the card "did nothing" on a real
           * device: only two of the card's six blocks carried a handler. The byline, the timestamp,
           * the `(edited)` marker, the CID, the tags, the actions row and the card's own padding
           * were all dead space — a tap that landed on any of them was swallowed by an element with
           * no handler and no ancestor that had one. Nothing was calling `stopPropagation`; there
           * was simply no card-wide click target to propagate TO.
           *
           * `after:absolute after:inset-0` stretches this button's hit area over the entire card, so
           * every non-interactive pixel opens the thread. Because it is a real `<button>` it is also
           * in the tab order, fires on Enter and Space for free, and is announced as a button whose
           * accessible name is the thread title — none of which an `<h3 onClick>` ever was. It picks
           * up the global cyan `:focus-visible` ring in `index.css` with no extra classes, and the
           * ring hugs the title text rather than the card, because the outline follows the button's
           * own box and not its out-of-flow pseudo-element.
           *
           * The overlay paints above the card's static content (absolutely positioned, z-index auto)
           * and BELOW anything given `relative z-10`. That is the whole mechanism by which the vote
           * widget and the author link stay clickable in their own right: they are raised above the
           * overlay, and they are SIBLINGS of this button rather than descendants, so a click on
           * them cannot bubble into thread navigation either.
           */
          <button
            type="button"
            onClick={() => onSelectThread!(thread.cid)}
            className="text-left cursor-pointer transition-colors hover:text-primary-200 after:absolute after:inset-0 after:content-['']"
          >
            {thread.title}
          </button>
        ) : (
          thread.title
        )}
      </h3>

      {/* Byline.
          ⚠️ THE CID USED TO SIT HERE, `ml-auto`, as `bafk2bza…`. It is the thread's identity and it
          is still what `?cid=` and the vote key are built from — but it told a reader nothing, and
          on a phone it read as a tappable token that was not one. Identity belongs in the link you
          copy (COPY LINK in the detail pane), not in the list. */}
      <div className="flex items-center flex-wrap gap-2 font-mono text-xs mb-3">
        {onSelectUser && (
          <UserLink
            address={thread.author}
            displayName={thread.displayName}
            onSelectUser={onSelectUser}
            size="xs"
            // Raised above the title button's stretched overlay so the author link and its tooltip
            // still receive their own clicks. Without this the overlay would eat them.
            className="relative z-10"
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

      {/* Excerpt.
          ⚠️ `max-w-[70ch]` IS THE POINT OF THIS COMPONENT'S EXISTENCE AT DESKTOP WIDTH. Before
          it, a card spanned the viewport — measured ~1750px, three or four times a comfortable
          reading measure. A cap in `ch` tracks the font, so it stays right if the type scale in
          `index.css` moves.
          No `onClick` here on purpose: the title button's overlay already covers it. */}
      <div className="text-sm text-primary-300 font-mono whitespace-pre-wrap break-words mb-3 max-w-[70ch]">
        {thread.content.length > 300
          ? thread.content.slice(0, 300) + '...'
          : thread.content}
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

      {/* Votes — the only control left in the list row.
          `relative z-10` raises it above the title button's overlay, which is what keeps a vote a
          vote instead of a navigation. `compact` is required: `VotingWidget` defaults to `flex-col`
          and reads as a broken control in a horizontal row. */}
      {entityId && (
        <div className="flex items-center pt-3 border-t border-primary-800">
          <div className="relative z-10">
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
          </div>
        </div>
      )}
    </article>
  );
}
