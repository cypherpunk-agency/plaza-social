import type { Profile } from '../../types/contracts';
import type { Provider } from '../../utils/contracts';

export type AddressSize = 'xs' | 'sm';

export interface UserLinkProps {
  /** Wallet address to display */
  address: string;
  /** Optional display name (shown instead of truncated address) */
  displayName?: string | null;
  /** Callback when user clicks to navigate to profile */
  onSelectUser: (address: string) => void;
  /** Highlight with accent color if true */
  isCurrentUser?: boolean;
  /** Text size: 'xs' (12px) or 'sm' (14px), defaults to 'sm' */
  size?: AddressSize;
  /** Additional CSS classes */
  className?: string;

  // Tooltip props (optional - tooltip only shows if getProfile is provided)
  /** Fetch profile data for tooltip */
  getProfile?: (address: string) => Promise<Profile>;
  /** Provider for fetching balance */
  provider?: Provider | null;
  /** Callback to follow this user */
  onFollow?: (address: string) => Promise<void>;
  /** Callback to unfollow this user */
  onUnfollow?: (address: string) => Promise<void>;
  /** Is current user following this user */
  isFollowing?: boolean;
  /** Callback to open tip modal for this user */
  onTip?: (address: string) => void;
  /** Can the current user send tips */
  canTip?: boolean;
}

export interface AddressDisplayProps {
  /** Wallet address to display */
  address: string;
  /** Optional display name */
  displayName?: string | null;
  /** If true, shows both display name and address (name on top, address below) */
  showBoth?: boolean;
  /** Text size: 'xs' (12px) or 'sm' (14px), defaults to 'sm' */
  size?: AddressSize;
  /** Additional CSS classes */
  className?: string;
}
