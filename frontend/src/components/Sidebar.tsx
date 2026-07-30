import { useState, useEffect } from 'react';
import { truncateAddress } from '../utils/formatters';

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
}: SidebarProps) {
  const [followingWithNames, setFollowingWithNames] = useState<FollowingUser[]>([]);
  const [loadingFollowingNames, setLoadingFollowingNames] = useState(false);

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

  const handleToggle = (section: SidebarSection) => {
    onToggleSection?.(section);
  };

  const handleProfileClick = (address: string) => {
    onSelectProfile?.(address);
    onViewModeChange('profile');
  };

  const handleMyProfileClick = () => {
    if (currentUserAddress) {
      onSelectProfile?.(currentUserAddress);
      onViewModeChange('profile');
    }
  };

  const handleSettingsClick = () => {
    onViewModeChange('settings');
  };

  const handleForumClick = () => {
    onViewModeChange('forum');
  };

  return (
    <div className="w-64 border-r-2 border-primary-500 bg-black flex flex-col">
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
              <span className="text-primary-700 text-xs ml-auto">{followingWithNames.length}</span>
            </button>

            {sidebarExpanded.following && (
              <div className="pl-4">
                {loadingFollowingNames ? (
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
    </div>
  );
}
