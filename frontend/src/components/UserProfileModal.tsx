import { useState, useEffect } from 'react';
import { AddressDisplay } from './UserAddress';
import { TipModal } from './TipModal';
import { formatBalance } from '../utils/formatters';
import type { Profile, Link } from '../types/contracts';
import type { Signer, Provider } from '../utils/contracts';

interface UserProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  userAddress: string | null;
  currentUserAddress?: string | null;
  getProfile: (address: string) => Promise<Profile>;
  // Follow functionality
  isFollowing?: boolean;
  onFollow?: (address: string) => Promise<void>;
  onUnfollow?: (address: string) => Promise<void>;
  followRegistryAvailable?: boolean;
  // Links
  getLinks?: (address: string) => Promise<Link[]>;
  // Tipping
  sessionWallet?: Signer | null;
  sessionWalletAddress?: string | null;
  sessionWalletBalance?: bigint;
  // Was `browserProvider` (MetaMask), used only to READ a balance — so it never needed a wallet
  // at all. Now the anonymous read provider. `browserWalletAddress` is gone with the MetaMask path.
  provider?: Provider | null;
}

export function UserProfileModal({
  isOpen,
  onClose,
  userAddress,
  currentUserAddress,
  getProfile,
  isFollowing = false,
  onFollow,
  onUnfollow,
  followRegistryAvailable = false,
  getLinks,
  sessionWallet,
  sessionWalletAddress,
  sessionWalletBalance,
  provider,
}: UserProfileModalProps) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [links, setLinks] = useState<Link[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followActionLoading, setFollowActionLoading] = useState(false);
  const [showTipModal, setShowTipModal] = useState(false);
  const [profileBalance, setProfileBalance] = useState<bigint>(0n);

  const isOwnProfile = userAddress?.toLowerCase() === currentUserAddress?.toLowerCase();

  const handleFollow = async () => {
    if (!userAddress || !onFollow) return;
    setFollowActionLoading(true);
    try {
      await onFollow(userAddress);
    } finally {
      setFollowActionLoading(false);
    }
  };

  const handleUnfollow = async () => {
    if (!userAddress || !onUnfollow) return;
    setFollowActionLoading(true);
    try {
      await onUnfollow(userAddress);
    } finally {
      setFollowActionLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && userAddress) {
      setIsLoading(true);
      setError(null);
      setProfile(null);
      setLinks([]);

      getProfile(userAddress)
        .then((p) => {
          setProfile(p);
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : 'Failed to load profile');
        })
        .finally(() => {
          setIsLoading(false);
        });
    }
  }, [isOpen, userAddress, getProfile]);

  // Load links
  useEffect(() => {
    if (isOpen && userAddress && getLinks) {
      getLinks(userAddress)
        .then(setLinks)
        .catch(() => setLinks([]));
    }
  }, [isOpen, userAddress, getLinks]);

  // Fetch profile balance
  useEffect(() => {
    if (isOpen && userAddress && provider) {
      provider.getBalance(userAddress)
        .then(setProfileBalance)
        .catch(() => setProfileBalance(0n));
    } else {
      setProfileBalance(0n);
    }
  }, [isOpen, userAddress, provider]);

  if (!isOpen || !userAddress) return null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b-2 border-primary-500 px-6 py-4 flex items-center justify-between bg-black flex-shrink-0">
        <h2 className="text-xl font-bold text-primary-500 text-shadow-neon font-mono">
          ▄▄▄ USER PROFILE ▄▄▄
        </h2>
        <button
          onClick={onClose}
          className="text-primary-500 hover:text-primary-400 text-2xl font-mono leading-none"
        >
          ×
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-md mx-auto space-y-4">
          {isLoading ? (
            <div className="text-center py-8">
              <div className="text-primary-500 font-mono text-sm animate-pulse">
                Loading profile...
              </div>
            </div>
          ) : error ? (
            <div className="text-center py-8">
              <div className="text-red-500 font-mono text-sm">{error}</div>
            </div>
          ) : profile && !profile.exists ? (
            <div className="text-center py-8">
              <div className="text-primary-600 font-mono text-sm">
                This user hasn't created a profile yet.
              </div>
              <div className="mt-4">
                <AddressDisplay address={userAddress} size="xs" />
              </div>
            </div>
          ) : profile ? (
            <>
              {/* Display Name */}
              <div>
                <label className="block text-primary-600 font-mono text-xs mb-1">
                  DISPLAY NAME
                </label>
                <div className="border border-primary-700 p-3 bg-primary-950">
                  <div className="flex items-baseline justify-between">
                    <span className="text-primary-300 font-mono text-sm">
                      {profile.displayName || '(unnamed)'}
                    </span>
                    <span className="text-primary-400 font-mono text-xs">
                      {formatBalance(profileBalance)} PAS
                    </span>
                  </div>
                </div>
              </div>

              {/* Bio */}
              {profile.bio && (
                <div>
                  <label className="block text-primary-600 font-mono text-xs mb-1">
                    BIO
                  </label>
                  <div className="border border-primary-700 p-3 bg-primary-950">
                    <span className="text-primary-300 font-mono text-sm whitespace-pre-wrap">
                      {profile.bio}
                    </span>
                  </div>
                </div>
              )}

              {/* Links */}
              {links.length > 0 && (
                <div>
                  <label className="block text-primary-600 font-mono text-xs mb-1">
                    LINKS
                  </label>
                  <div className="border border-primary-700 p-3 bg-primary-950 space-y-1">
                    {links.map((link, idx) => (
                      <a
                        key={idx}
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 text-sm font-mono hover:bg-primary-900 p-1 -mx-1 transition-colors"
                      >
                        <span className="text-primary-500">→</span>
                        <span className="text-accent-400 hover:text-accent-300">
                          {link.name}
                        </span>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {/* Wallet Address */}
              <div>
                <label className="block text-primary-600 font-mono text-xs mb-1">
                  WALLET ADDRESS
                </label>
                <div className="border border-primary-700 p-3 bg-primary-950">
                  <AddressDisplay address={userAddress} size="sm" />
                </div>
              </div>
            </>
          ) : null}

          {/* Action buttons */}
          <div className="space-y-2 mt-4">
            {!isOwnProfile && (
              <>
                {sessionWallet && userAddress && (
                  <button
                    onClick={() => setShowTipModal(true)}
                    className="w-full py-2 bg-yellow-950 hover:bg-yellow-900 border-2 border-yellow-500 text-yellow-400 font-mono text-sm hover:border-yellow-400 transition-all"
                  >
                    SEND TIP
                  </button>
                )}
                {followRegistryAvailable && onFollow && onUnfollow && userAddress && (
                  <button
                    onClick={isFollowing ? handleUnfollow : handleFollow}
                    disabled={followActionLoading}
                    className={`w-full py-2 border-2 font-mono text-sm transition-all ${
                      followActionLoading
                        ? 'opacity-50 cursor-not-allowed'
                        : ''
                    } ${
                      isFollowing
                        ? 'bg-gray-900 hover:bg-gray-800 border-gray-600 text-gray-400 hover:border-gray-500'
                        : 'bg-primary-950 hover:bg-primary-900 border-primary-500 text-primary-400 hover:border-primary-400'
                    }`}
                  >
                    {followActionLoading
                      ? '...'
                      : isFollowing
                      ? 'UNFOLLOW'
                      : 'FOLLOW'}
                  </button>
                )}
              </>
            )}
            <button
              onClick={onClose}
              className="w-full py-2 bg-gray-900 hover:bg-gray-800 border-2 border-gray-600 text-gray-400 font-mono text-sm hover:border-gray-500 transition-all"
            >
              CLOSE
            </button>
          </div>
        </div>
      </div>

      {/* Tip Modal */}
      {userAddress && (
        <TipModal
          isOpen={showTipModal}
          onClose={() => setShowTipModal(false)}
          recipientAddress={userAddress}
          recipientName={profile?.displayName}
          sessionWallet={sessionWallet}
          sessionWalletAddress={sessionWalletAddress}
          sessionWalletBalance={sessionWalletBalance}
        />
      )}
    </div>
  );
}
