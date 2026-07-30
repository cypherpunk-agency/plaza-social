import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { truncateAddress, formatBalance } from '../../utils/formatters';
import type { Profile } from '../../types/contracts';
import type { Provider } from '../../utils/contracts';

export interface ProfileTooltipProps {
  address: string;
  triggerRect: DOMRect;
  getProfile: (address: string) => Promise<Profile>;
  onFollow?: (address: string) => Promise<void>;
  onUnfollow?: (address: string) => Promise<void>;
  onTip?: (address: string) => void;
  /**
   * Navigate to this user's profile. Same callback App.tsx threads everywhere else as
   * `onSelectUser` (`openProfile`). The tooltip must be dismissed by the owner of the
   * tooltip state before this fires — see `UserLink.handleSelectUser`.
   */
  onSelectUser: (address: string) => void;
  isFollowing?: boolean;
  canTip?: boolean;
  isOwnProfile?: boolean;
  provider?: Provider | null;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

export function ProfileTooltip({
  address,
  triggerRect,
  getProfile,
  onFollow,
  onUnfollow,
  onTip,
  onSelectUser,
  isFollowing = false,
  canTip = false,
  isOwnProfile = false,
  provider,
  onMouseEnter,
  onMouseLeave,
}: ProfileTooltipProps) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [balance, setBalance] = useState<bigint>(0n);
  const [isLoading, setIsLoading] = useState(true);
  const [followLoading, setFollowLoading] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0, showAbove: true });

  // Load profile data
  useEffect(() => {
    setIsLoading(true);
    getProfile(address)
      .then(setProfile)
      .catch(() => setProfile(null))
      .finally(() => setIsLoading(false));
  }, [address, getProfile]);

  // Load balance
  useEffect(() => {
    if (provider) {
      provider.getBalance(address)
        .then(setBalance)
        .catch(() => setBalance(0n));
    }
  }, [address, provider]);

  // Calculate position after render
  useEffect(() => {
    if (tooltipRef.current) {
      const tooltip = tooltipRef.current;
      const tooltipHeight = tooltip.offsetHeight;
      const tooltipWidth = tooltip.offsetWidth;
      const gap = 8;

      // Check if there's room above
      const showAbove = triggerRect.top > tooltipHeight + gap;

      // Calculate vertical position
      const top = showAbove
        ? triggerRect.top - tooltipHeight - gap
        : triggerRect.bottom + gap;

      // Calculate horizontal position (centered, clamped to viewport)
      let left = triggerRect.left + (triggerRect.width / 2) - (tooltipWidth / 2);
      left = Math.max(8, Math.min(left, window.innerWidth - tooltipWidth - 8));

      setPosition({ top, left, showAbove });
    }
  }, [triggerRect, profile]);

  const handleFollow = async () => {
    if (!onFollow) return;
    setFollowLoading(true);
    try {
      await onFollow(address);
    } finally {
      setFollowLoading(false);
    }
  };

  const handleUnfollow = async () => {
    if (!onUnfollow) return;
    setFollowLoading(true);
    try {
      await onUnfollow(address);
    } finally {
      setFollowLoading(false);
    }
  };

  /**
   * Open the profile.
   *
   * `stopPropagation` matters because a portal does NOT isolate events: React events bubble along
   * the REACT tree, not the DOM tree, so a click in here reaches whatever contains the `UserLink`.
   * No current consumer puts an onClick on an ancestor of `UserLink` (verified 2026-07-30:
   * ThreadCard/PostCard hang theirs on the title element, a sibling) — so today this is defensive,
   * matching what the TIP and FOLLOW buttons below already do. It becomes load-bearing the moment
   * someone makes a whole card clickable.
   */
  const handleOpenProfile = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onSelectUser(address);
  };

  const displayName = profile?.displayName || truncateAddress(address);
  const bioSnippet = profile?.bio
    ? profile.bio.length > 60
      ? profile.bio.slice(0, 60) + '...'
      : profile.bio
    : null;

  const tooltipContent = (
    <div
      ref={tooltipRef}
      className="fixed z-50"
      style={{
        top: position.top,
        left: position.left,
        opacity: position.top === 0 ? 0 : 1,
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* Invisible bridge area to make it easier to reach the tooltip */}
      {!position.showAbove && (
        <div className="h-3 w-full" />
      )}
      <div className="bg-black border-2 border-primary-500 shadow-lg shadow-primary-500/20 max-w-xs">
      {isLoading ? (
        <div className="p-3">
          <div className="text-primary-500 font-mono text-xs animate-pulse">
            Loading...
          </div>
        </div>
      ) : (
        <div className="p-3 space-y-2">
          {/* Header: Avatar + Name + Balance */}
          <div className="flex items-start gap-2">
            <button
              type="button"
              onClick={handleOpenProfile}
              title={`View ${displayName}'s profile`}
              aria-label={`View ${displayName}'s profile`}
              className="w-8 h-8 border border-primary-500 bg-primary-950 flex items-center justify-center text-primary-500 text-sm font-mono flex-shrink-0 cursor-pointer transition-colors hover:bg-primary-900 hover:border-primary-400 hover:text-primary-300 focus:outline-none focus-visible:border-primary-400 focus-visible:text-primary-300"
            >
              {displayName.charAt(0).toUpperCase()}
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5">
                <button
                  type="button"
                  onClick={handleOpenProfile}
                  title={`View ${displayName}'s profile`}
                  className="text-primary-400 font-mono text-sm font-semibold truncate text-left min-w-0 cursor-pointer transition-colors hover:text-primary-300 hover:underline focus:outline-none focus-visible:text-primary-300 focus-visible:underline"
                >
                  {displayName}
                </button>
                <span className="text-primary-600 font-mono text-xs whitespace-nowrap">
                  {formatBalance(balance)} PAS
                </span>
              </div>
              <div className="text-primary-700 font-mono text-xs">
                {truncateAddress(address)}
              </div>
            </div>
          </div>

          {/* Bio snippet */}
          {bioSnippet && (
            <p className="text-primary-500 font-mono text-xs leading-relaxed">
              {bioSnippet}
            </p>
          )}

          {/* Action buttons */}
          {!isOwnProfile && (onTip || onFollow) && (
            <div className="flex gap-1.5 pt-1">
              {onTip && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onTip(address);
                  }}
                  disabled={!canTip}
                  className={`px-2 py-1 text-xs font-mono border transition-colors ${
                    canTip
                      ? 'bg-yellow-950 border-yellow-600 text-yellow-400 hover:bg-yellow-900'
                      : 'bg-gray-900 border-gray-700 text-gray-600 cursor-not-allowed'
                  }`}
                >
                  TIP
                </button>
              )}
              {onFollow && onUnfollow && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    isFollowing ? handleUnfollow() : handleFollow();
                  }}
                  disabled={followLoading}
                  className={`px-2 py-1 text-xs font-mono border transition-colors ${
                    followLoading
                      ? 'opacity-50'
                      : isFollowing
                        ? 'bg-gray-900 border-gray-600 text-gray-400 hover:bg-gray-800'
                        : 'bg-primary-950 border-primary-600 text-primary-400 hover:bg-primary-900'
                  }`}
                >
                  {followLoading ? '...' : isFollowing ? 'UNFOLLOW' : 'FOLLOW'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      </div>
      {/* Invisible bridge area below tooltip (when showing above trigger) */}
      {position.showAbove && (
        <div className="h-3 w-full" />
      )}
    </div>
  );

  return createPortal(tooltipContent, document.body);
}
