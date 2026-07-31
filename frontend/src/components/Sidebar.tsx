import { useState, useEffect, useRef } from 'react';
import { truncateAddress } from '../utils/formatters';

/**
 * The id the header's toggle points `aria-controls` at. Exported so the button and the panel can
 * never drift apart — a dangling `aria-controls` is invisible in review and silently useless.
 */
export const SIDEBAR_DRAWER_ID = 'plaza-primary-nav';

interface FollowingUser {
  address: string;
  displayName: string;
}

/**
 * ⛔ `'channels'` IS GONE FROM THIS UNION ON PURPOSE, and removing it is what makes the removal
 * safe: every remaining reference to the chat view is now a compile error rather than a blank
 * screen. A persisted `viewMode: 'channels'` in localStorage, or a stale `?channel=0x…` link, must
 * resolve to `'forum'` — see the initialiser in `App.tsx`.
 *
 * Chat is parked, not deleted. `useChannel`, `useChannelRegistry`, `ChatFeed`, `MessageInput`,
 * `ChannelHeader`, `ChannelModerationModal`, `UserListPanel` and `CreateChannelModal` are still on
 * disk, unreferenced, as the starting point for the migration onto `PostRegistry`. The UI does not
 * offer them because they call contracts that were deleted, and an affordance that can only fail is
 * worse than an absence.
 */
export type ViewMode = 'profile' | 'settings' | 'forum';

export type SidebarSection = 'following';

interface SidebarExpanded {
  following: boolean;
}

interface SidebarProps {
  isConnected: boolean;
  // View mode
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  getDisplayName?: (address: string) => Promise<string>;
  // Following props
  following?: string[];
  selectedProfile?: string | null;
  onSelectProfile?: (address: string) => void;
  followRegistryAvailable?: boolean;
  // Sidebar expansion state
  sidebarExpanded?: SidebarExpanded;
  onToggleSection?: (section: SidebarSection) => void;
  // Current user for My Profile
  currentUserAddress?: string | null;
  currentUserDisplayName?: string | null;
  // Forum availability
  forumAvailable?: boolean;
  /**
   * ⚠️ DRAWER VISIBILITY BELOW `xl`. This is NOT `sidebarExpanded`, and conflating the two is the
   * obvious mistake here: `sidebarExpanded` says which SECTIONS inside the nav are unfolded and is
   * persisted to localStorage; this says whether the whole panel is on screen at all, and is
   * deliberately transient. At `xl` and above it is ignored — the panel is always rendered.
   */
  isDrawerOpen?: boolean;
  /** Close the drawer. The caller also restores focus to the toggle; see `App.tsx`. */
  onCloseDrawer?: () => void;
}

export function Sidebar({
  isConnected,
  viewMode,
  onViewModeChange,
  getDisplayName,
  following = [],
  selectedProfile,
  onSelectProfile,
  followRegistryAvailable = false,
  sidebarExpanded = { following: true },
  onToggleSection,
  currentUserAddress,
  currentUserDisplayName,
  forumAvailable = false,
  isDrawerOpen = false,
  onCloseDrawer,
}: SidebarProps) {
  const [followingWithNames, setFollowingWithNames] = useState<FollowingUser[]>([]);
  const [loadingFollowingNames, setLoadingFollowingNames] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  /**
   * Focus moves INTO the drawer when it opens, and Escape closes it.
   *
   * ⚠️ The close button is `xl:hidden`, so at desktop width `.focus()` is a no-op on a
   * `display: none` element — which is exactly right: at `xl` the panel is not a drawer, nothing
   * was "opened", and stealing focus would be wrong. Restoring focus to the toggle is the CALLER's
   * job (`App.tsx` holds the button ref), because the toggle lives in the header, not here.
   *
   * No focus TRAP: the same markup is a plain static column at `xl`, where trapping Tab inside the
   * nav would strand a keyboard user. Escape plus a real close button is the honest amount of modal
   * behaviour for something that is only sometimes modal.
   */
  useEffect(() => {
    if (!isDrawerOpen) return;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseDrawer?.();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isDrawerOpen, onCloseDrawer]);

  // Load following display names
  useEffect(() => {
    if (following.length === 0 || !getDisplayName) {
      setFollowingWithNames([]);
      return;
    }

    setLoadingFollowingNames(true);
    Promise.all(
      following.map(async (address) => {
        const displayName = await getDisplayName(address);
        return { address, displayName };
      })
    )
      .then(setFollowingWithNames)
      .finally(() => setLoadingFollowingNames(false));
  }, [following, getDisplayName]);

  /**
   * ⚠️ SECTION EXPANSION MUST NOT CLOSE THE DRAWER. Unfolding "Following" is how you get AT the
   * links; closing the panel underneath the finger that opened it would make the section unusable
   * on a phone. Only a NAVIGATION closes — every handler below that changes `viewMode` does.
   */
  const handleToggle = (section: SidebarSection) => {
    onToggleSection?.(section);
  };

  const handleProfileClick = (address: string) => {
    onSelectProfile?.(address);
    onViewModeChange('profile');
    onCloseDrawer?.();
  };

  const handleMyProfileClick = () => {
    if (currentUserAddress) {
      onSelectProfile?.(currentUserAddress);
      onViewModeChange('profile');
      onCloseDrawer?.();
    }
  };

  const handleSettingsClick = () => {
    onViewModeChange('settings');
    onCloseDrawer?.();
  };

  const handleForumClick = () => {
    onViewModeChange('forum');
    onCloseDrawer?.();
  };

  return (
    <>
      {/*
        Backdrop. `xl:hidden` because above the breakpoint the panel is part of the layout and there
        is nothing to dismiss. A `<div onClick>` overlay is the one accepted un-focusable click
        target in this codebase (see frontend/CLAUDE.md § Clickable non-buttons) and it earns that
        here: it duplicates the real CLOSE MENU button below, plus Escape.
      */}
      {isDrawerOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/70 xl:hidden"
          onClick={onCloseDrawer}
          aria-hidden="true"
        />
      )}

      {/*
        ⚠️ MOBILE FIRST, MATCHING THE FORUM'S `xl` BREAKPOINT ON PURPOSE. The base state is the
        phone: the panel is OFF-CANVAS (`hidden`), and opening it makes it a `fixed` overlay. At
        `xl` — the same 1280px at which `ForumView` splits into two panes — `xl:static xl:flex`
        restores exactly today's behaviour, a plain 16rem column in the flex row.

        Measured before this change at 375×812: the fixed `w-64` column ate 176px of 375 (47%),
        leaving thread titles ~196px and undoing the forum's `max-w-[70ch]` measure work.

        `hidden` rather than a `-translate-x-full` slide: an off-canvas element that is still
        `display: block` keeps every one of its ~10 buttons in the tab order, so a keyboard user on
        a phone tabs through an invisible menu before reaching the page. Losing the slide animation
        is a cheap price for that.
      */}
      <nav
        id={SIDEBAR_DRAWER_ID}
        aria-label="Primary"
        className={`${
          isDrawerOpen ? 'flex fixed inset-y-0 left-0 z-40' : 'hidden'
        } xl:static xl:z-auto xl:flex w-64 shrink-0 border-r-2 border-primary-500 bg-black flex-col`}
      >
      {/* The drawer's own close control. Only exists while the panel is a drawer. */}
      <div className="border-b-2 border-primary-500 xl:hidden">
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onCloseDrawer}
          className="w-full text-left px-4 py-3 text-sm font-mono text-primary-500 hover:text-primary-400 transition-colors"
        >
          &larr; CLOSE MENU
        </button>
      </div>

      {/* My Profile Section */}
      {isConnected && currentUserAddress && (
        <div className="border-b-2 border-primary-500">
          <button
            onClick={handleMyProfileClick}
            className={`w-full text-left px-4 py-3 flex items-center gap-2 text-sm transition-all ${
              viewMode === 'profile' && selectedProfile === currentUserAddress
                ? 'bg-primary-900 text-primary-300'
                : 'text-primary-500 hover:bg-primary-950'
            }`}
          >
            <span className="text-accent-400">@</span>
            <span className="font-bold truncate">
              {currentUserDisplayName || truncateAddress(currentUserAddress)}
            </span>
          </button>
        </div>
      )}

      {/* Forum Navigation */}
      {forumAvailable && (
        <div className="border-b border-primary-800">
          <button
            onClick={handleForumClick}
            className={`w-full text-left px-4 py-2.5 flex items-center gap-2 text-sm transition-all ${
              viewMode === 'forum'
                ? 'bg-primary-900 text-primary-300 border-l-2 border-primary-400'
                : 'text-primary-500 hover:bg-primary-950'
            }`}
          >
            <span className="text-primary-500">&#9776;</span>
            <span className="font-semibold">Forum</span>
          </button>
        </div>
      )}

      {/* Collapsible Sections.
          ⛔ THE CHANNELS SECTION WAS HERE, and its removal is deliberate. Every part of it — the
          list, the per-channel name lookup against `ChatChannel`, the "+ New Channel" button —
          spoke to contracts that no longer exist. Creating a room is not a deployment on this
          platform: an open room is `keccak256(name)` and costs no transaction, a moderated one is
          `PostRegistry.claimRegistry(salt, policy)`. There is nothing per-room to deploy, so the
          old control could only ever fail. Chat returns when the reading pattern from
          `useForumThread` is applied to `useChannel`. */}
      <div className="flex-1 overflow-y-auto">
        {/* Following Section */}
        {followRegistryAvailable && (
          <div className="border-b border-primary-800">
            <button
              onClick={() => handleToggle('following')}
              className="w-full text-left px-4 py-2 flex items-center gap-2 text-sm text-primary-600 hover:bg-primary-950"
            >
              <span className={`text-xs transition-transform ${sidebarExpanded.following ? 'rotate-90' : ''}`}>
                &#9654;
              </span>
              <span className="font-bold">Following</span>
              {/* ⛔ NO `0` WHILE THERE IS NO ACCOUNT. A count is a claim, and until the session
                  resolves a product account there is no follow graph to have counted. */}
              {isConnected && (
                <span className="text-primary-700 text-xs ml-auto">{followingWithNames.length}</span>
              )}
            </button>

            {sidebarExpanded.following && (
              <div className="pl-4">
                {/*
                  ⭐ THREE STATES, THE SAME RULE THE LISTS FOLLOW (`collectionState.ts`): never say
                  a collection is empty before it has been read.

                  ⚠️ THE SIGNAL HERE IS `isConnected`, NOT A CHAIN READER, and that is a deliberate
                  compromise. This component is not given `provider` and `App.tsx` belongs to
                  another change, so the closest honest fact available is `!!host.address` — and it
                  is the right shape anyway: `following` is *this account's* follow graph, so with
                  no account there is nothing that could be empty.

                  Rendering NOTHING rather than a placeholder is the point. "Not following anyone"
                  is false during startup, and an anonymous reader has no follow list to be told
                  about at all — so silence, rather than inventing sign-in copy for a surface that
                  deliberately has no connect control (see `SessionStatus.tsx`).

                  ⚠️ RESIDUAL, KNOWN: with an account present but the FollowRegistry read still in
                  flight, `following` is `[]` and this still says "Not following anyone". Closing
                  that needs a loading flag out of `useFollowRegistry` through `App.tsx`, neither of
                  which this change owns.
                */}
                {!isConnected ? null : loadingFollowingNames ? (
                  <div className="px-4 py-2 text-primary-600 font-mono text-sm">
                    Loading...
                  </div>
                ) : followingWithNames.length === 0 ? (
                  <div className="px-4 py-2 text-primary-700 font-mono text-sm">
                    Not following anyone
                  </div>
                ) : (
                  followingWithNames.map((user) => (
                    <button
                      key={user.address}
                      onClick={() => handleProfileClick(user.address)}
                      className={`w-full text-left px-4 py-1.5 flex items-center gap-2 text-sm transition-all ${
                        viewMode === 'profile' && selectedProfile === user.address
                          ? 'bg-accent-900 text-accent-300 border-l-2 border-accent-400'
                          : 'text-primary-500 hover:bg-primary-950'
                      }`}
                    >
                      <span className="text-primary-600">&#9679;</span>
                      <span className="truncate">
                        {user.displayName || truncateAddress(user.address)}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Settings Button */}
      <div className="border-t-2 border-primary-500">
        <button
          onClick={handleSettingsClick}
          className={`w-full text-left px-4 py-3 flex items-center gap-2 text-sm transition-all ${
            viewMode === 'settings'
              ? 'bg-primary-900 text-primary-300'
              : 'text-primary-600 hover:bg-primary-950 hover:text-primary-400'
          }`}
        >
          <span>&#9881;</span>
          <span>Settings</span>
        </button>
      </div>
      </nav>
    </>
  );
}
