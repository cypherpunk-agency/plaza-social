import { useState, useEffect } from 'react';
import { truncateAddress } from '../utils/formatters';
import { AddressDisplay, CashBalance, ownCashBalanceState } from './UserAddress';
import type { Profile, Link } from '../types/contracts';
import { UserPostsFeed } from './UserPostsFeed';
import { TipModal } from './TipModal';
import { CollectionStatus } from './CollectionStatus';
import { usePayments, useOwnCashBalance } from '../hooks/usePayments';
import type { Provider, Signer } from '../utils/contracts';
import toast from 'react-hot-toast';

interface ProfileViewProps {
  userAddress: string | null;
  currentUserAddress?: string | null;
  getProfile: (address: string) => Promise<Profile>;
  // Follow functionality
  isFollowing?: boolean;
  onFollow?: (address: string) => Promise<void>;
  onUnfollow?: (address: string) => Promise<void>;
  followLoading?: boolean;
  // Stats
  followerCount?: number;
  followingCount?: number;
  // Posts functionality
  userPostsAddress?: string | null;
  repliesAddress?: string | null;
  votingAddress?: string | null;
  provider?: Provider | null;
  signer?: Signer | null;
  getDisplayName?: (address: string) => Promise<string>;
  onSelectUser?: (address: string) => void;
  // Links
  links?: Link[];
  getLinks?: (address: string) => Promise<Link[]>;
  // Profile editing (for own profile)
  onUpdateDisplayName?: (name: string) => Promise<void>;
  onUpdateBio?: (bio: string) => Promise<void>;
  onAddLink?: (name: string, url: string) => Promise<void>;
  onRemoveLink?: (index: number) => Promise<void>;
  /**
   * @deprecated Unused. The delegate key is not a payer — it is never funded, which is why every
   * tip used to die on "Insufficient balance in selected wallet". Tips are debited from the USER by
   * the host; see `TipModal`. Kept so App.tsx still compiles while these props are retired.
   */
  sessionWallet?: Signer | null;
  /** @deprecated Unused. */
  sessionWalletAddress?: string | null;
  /** @deprecated Unused. */
  sessionWalletBalance?: bigint;
  // Tooltip props for nested UserLinks
  isFollowingUser?: (address: string) => boolean;
  onTip?: (address: string) => void;
  canTip?: boolean;
  // Connect wallet callback (when no wallet connected)
  onConnectWallet?: () => void;
  // Post selection
  selectedPostFromUrl?: number | null;
  onPostChange?: (postIndex: number | null) => void;
}

export function ProfileView({
  userAddress,
  currentUserAddress,
  getProfile,
  isFollowing = false,
  onFollow,
  onUnfollow,
  followLoading = false,
  followerCount: _followerCount = 0,
  followingCount: _followingCount = 0,
  userPostsAddress,
  repliesAddress,
  votingAddress,
  provider,
  signer,
  getDisplayName,
  onSelectUser,
  links: propLinks = [],
  getLinks,
  onUpdateDisplayName,
  onUpdateBio,
  onAddLink,
  onRemoveLink,
  // `sessionWallet*` are deliberately NOT destructured — see their @deprecated notes above.
  // Tooltip props for nested UserLinks
  isFollowingUser,
  onTip,
  canTip = false,
  // Connect wallet callback
  onConnectWallet,
  // Post selection
  selectedPostFromUrl,
  onPostChange,
}: ProfileViewProps) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [links, setLinks] = useState<Link[]>(propLinks);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followActionLoading, setFollowActionLoading] = useState(false);

  // Edit mode state
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editBio, setEditBio] = useState('');
  const [newLinkName, setNewLinkName] = useState('');
  const [newLinkUrl, setNewLinkUrl] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  /**
   * Tip modal state.
   *
   * ⚠️ THIS WAS DEAD FOR A WHILE — the state and the `<TipModal>` at the bottom both existed and
   * nothing ever set it to `true`, so a static pass proposed deleting the modal as unreachable. The
   * missing piece was never the modal; it was the SEND TIP button below, which the profile page had
   * simply never grown. The button is the fix, not the deletion.
   */
  const [showTipModal, setShowTipModal] = useState(false);

  const isOwnProfile = userAddress?.toLowerCase() === currentUserAddress?.toLowerCase();

  /**
   * The CASH seam, borrowed from the session rather than drilled in — see `hooks/usePayments`.
   * `canTip` (a prop) already says whether the session can pay at all; this is the same fact from
   * the same source, and it is what the modal needs to actually send.
   */
  const payments = usePayments();
  // ⛔ CASH, not PAS, and only ever our own. `provider.getBalance(userAddress)` used to render a
  // FAILED read as `0.0000 PAS`; there is no host API for anyone else's CASH at all. See
  // `UserAddress/CashBalance.tsx`.
  const ownBalance = useOwnCashBalance(isOwnProfile);
  const balanceState = isOwnProfile
    ? ownCashBalanceState(ownBalance)
    : ({ kind: 'private' } as const);

  const canEdit = isOwnProfile && onUpdateDisplayName && onUpdateBio;

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
    if (userAddress) {
      setIsLoading(true);
      setError(null);
      setProfile(null);

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
  }, [userAddress, getProfile]);

  // Load links
  useEffect(() => {
    if (userAddress && getLinks) {
      getLinks(userAddress)
        .then(setLinks)
        .catch(() => setLinks([]));
    } else {
      setLinks(propLinks);
    }
  }, [userAddress, getLinks, propLinks]);

  // Reset edit mode when switching profiles
  useEffect(() => {
    setIsEditing(false);
  }, [userAddress]);

  // A stale tip sheet must not follow you to the next person's page.
  useEffect(() => {
    setShowTipModal(false);
  }, [userAddress]);

  // Start editing
  const handleStartEdit = () => {
    setEditName(profile?.displayName || '');
    setEditBio(profile?.bio || '');
    setIsEditing(true);
  };

  // Cancel editing
  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditName('');
    setEditBio('');
    setNewLinkName('');
    setNewLinkUrl('');
  };

  // Save profile changes
  const handleSaveProfile = async () => {
    if (!onUpdateDisplayName || !onUpdateBio || !profile) return;

    setIsSaving(true);
    try {
      // Update display name if changed
      if (editName !== profile.displayName && editName.trim()) {
        await onUpdateDisplayName(editName.trim());
        toast.success('Display name updated!');
      }

      // Update bio if changed
      if (editBio !== profile.bio) {
        await onUpdateBio(editBio);
        toast.success('Bio updated!');
      }

      // Refresh profile
      if (userAddress) {
        const updatedProfile = await getProfile(userAddress);
        setProfile(updatedProfile);
      }

      setIsEditing(false);
    } catch (err) {
      toast.error('Failed to update profile');
      console.error(err);
    } finally {
      setIsSaving(false);
    }
  };

  // Add new link
  const handleAddLink = async () => {
    if (!onAddLink || !newLinkName.trim() || !newLinkUrl.trim()) return;

    setIsSaving(true);
    try {
      await onAddLink(newLinkName.trim(), newLinkUrl.trim());
      setNewLinkName('');
      setNewLinkUrl('');
      // Refresh links
      if (userAddress && getLinks) {
        const updatedLinks = await getLinks(userAddress);
        setLinks(updatedLinks);
      }
      toast.success('Link added!');
    } catch (err) {
      toast.error('Failed to add link');
      console.error(err);
    } finally {
      setIsSaving(false);
    }
  };

  // Remove link
  const handleRemoveLink = async (index: number) => {
    if (!onRemoveLink) return;

    setIsSaving(true);
    try {
      await onRemoveLink(index);
      // Refresh links
      if (userAddress && getLinks) {
        const updatedLinks = await getLinks(userAddress);
        setLinks(updatedLinks);
      }
      toast.success('Link removed!');
    } catch (err) {
      toast.error('Failed to remove link');
      console.error(err);
    } finally {
      setIsSaving(false);
    }
  };

  if (!userAddress) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-primary-600 font-mono text-sm">
          SELECT A USER TO VIEW THEIR PROFILE
        </p>
      </div>
    );
  }

  /**
   * ⭐ SESSION-NOT-READY, BEFORE BOTH `isLoading` AND `error` — the same third state the lists grew
   * (see `collectionState.ts`), in the one shape it takes on a single-object read.
   *
   * `getProfile` comes from `useUserRegistry`, whose `getReadContract()` returns null without a
   * chain reader; the callback then throws `"Contract not available"`, which landed in `error` and
   * rendered as a red failure over a session that was merely still starting. Worse, `profile` stays
   * null so the body's `!profile.exists` branch — "This user hasn't created a profile yet." — is one
   * successful-looking read away from being a confident lie about somebody's account.
   *
   * ⛔ This is `provider`, the chain reader, NOT `canWrite`/`signer`: reading a profile anonymously
   * is the intended experience and must not report itself as a deficiency.
   */
  if (!provider) {
    // Same wrapper as the two early returns around it, so the pane geometry does not shift.
    return (
      <div className="flex-1 flex items-center justify-center">
        <CollectionStatus state="connecting" />
      </div>
    );
  }

  if (isLoading || followLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-primary-500 font-mono text-sm animate-pulse">
          Loading profile...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-red-500 font-mono text-sm">{error}</div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b-2 border-primary-500 p-6">
        <div className="max-w-2xl mx-auto">
          {/* Display Name - inline editable */}
          {isEditing ? (
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              maxLength={32}
              className="text-xl font-bold text-primary-500 font-mono bg-transparent border-b-2 border-primary-500 focus:border-accent-400 focus:outline-none w-full"
              placeholder="Display name..."
            />
          ) : (
            <h1 className="text-xl font-bold text-primary-500 text-shadow-neon font-mono truncate">
              {profile?.displayName || truncateAddress(userAddress)}
            </h1>
          )}

          {/* Bio - inline editable, elegant styling */}
          {isEditing ? (
            <textarea
              value={editBio}
              onChange={(e) => setEditBio(e.target.value)}
              maxLength={256}
              rows={2}
              className="mt-3 w-full text-sm text-primary-400 font-mono bg-transparent border-b border-primary-700 focus:border-accent-400 focus:outline-none resize-none"
              placeholder="Tell us about yourself..."
            />
          ) : (profile?.bio || isOwnProfile) && (
            <p className="mt-3 text-sm text-primary-300 font-mono whitespace-pre-wrap">
              {profile?.bio || (isOwnProfile ? 'No bio yet' : '')}
            </p>
          )}

          {/* Address and Balance */}
          <div className="mt-3 flex items-center gap-3 text-xs font-mono text-primary-600">
            <AddressDisplay address={userAddress} size="xs" variant="muted" />
            <span className="text-primary-700">·</span>
            <CashBalance state={balanceState} />
          </div>

          {/* Action buttons */}
          <div className="mt-4 flex gap-2">
            {isOwnProfile && canEdit && !isEditing && (
              <button
                onClick={handleStartEdit}
                className="px-4 py-1.5 bg-primary-900 border-2 border-primary-500 text-primary-400 text-sm font-mono hover:bg-primary-800 transition-colors"
              >
                EDIT PROFILE
              </button>
            )}
            {isOwnProfile && isEditing && (
              <>
                <button
                  onClick={handleSaveProfile}
                  disabled={isSaving}
                  className="px-4 py-1.5 bg-accent-900 border-2 border-accent-500 text-accent-400 text-sm font-mono hover:bg-accent-800 transition-colors disabled:opacity-50"
                >
                  {isSaving ? 'SAVING...' : 'SAVE'}
                </button>
                <button
                  onClick={handleCancelEdit}
                  disabled={isSaving}
                  className="px-4 py-1.5 bg-gray-900 border-2 border-gray-600 text-gray-400 text-sm font-mono hover:bg-gray-800 transition-colors disabled:opacity-50"
                >
                  CANCEL
                </button>
              </>
            )}
            {/*
              ⭐ THE PROFILE PAGE'S TIP CONTROL. Same affordance the hover card has had all along —
              yellow, `SEND TIP`, opening the same `TipModal` — so that reaching someone's profile
              does not LOSE a control that hovering their name offers.

              Gated on `canTip`, which App derives from `!!host.backend?.payments`. ⛔ NOT on
              `sessionWallet` (the parked `UserProfileModal` still does that, and it is wrong: the
              delegate key is not the payer and is never funded) and ⛔ NOT on `canWrite`, which is
              posting ability and says nothing about money.

              Shown-but-disabled rather than hidden when the session cannot pay: a control that
              vanishes teaches nobody why, and the modal itself explains — which is why the hover
              card's TIP does the same thing.
            */}
            {!isOwnProfile && userAddress && (
              <button
                type="button"
                onClick={() => setShowTipModal(true)}
                disabled={!canTip}
                title={canTip ? undefined : 'Tipping pays in CASH from your Polkadot app balance.'}
                className={`px-4 py-1.5 border-2 text-sm font-mono transition-colors ${
                  canTip
                    ? 'bg-yellow-950 border-yellow-500 text-yellow-400 hover:bg-yellow-900 hover:border-yellow-400'
                    : 'bg-gray-900 border-gray-700 text-gray-600 cursor-not-allowed'
                }`}
              >
                SEND TIP
              </button>
            )}
            {!isOwnProfile && onFollow && onUnfollow && (
              <button
                onClick={isFollowing ? handleUnfollow : handleFollow}
                disabled={followActionLoading}
                className={`px-4 py-1.5 border-2 text-sm font-mono transition-colors ${
                  followActionLoading
                    ? 'opacity-50 cursor-not-allowed'
                    : ''
                } ${
                  isFollowing
                    ? 'bg-gray-900 border-gray-600 text-gray-400 hover:bg-gray-800'
                    : 'bg-primary-900 border-primary-500 text-primary-400 hover:bg-primary-800'
                }`}
              >
                {followActionLoading
                  ? '...'
                  : isFollowing
                  ? 'UNFOLLOW'
                  : 'FOLLOW'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-2xl mx-auto space-y-6">
          {profile && !profile.exists ? (
            <div className="text-center py-8">
              <div className="text-primary-600 font-mono text-sm">
                This user hasn't created a profile yet.
              </div>
            </div>
          ) : profile ? (
            <>
              {/* Edit Mode - Links Section */}
              {isEditing && (
                <div>
                  <h3 className="text-sm font-bold text-accent-400 mb-3 font-mono">
                    LINKS
                  </h3>

                  {/* Existing Links */}
                  {links.length > 0 && (
                    <div className="space-y-2 mb-3">
                      {links.map((link, idx) => (
                        <div
                          key={idx}
                          className="flex items-center gap-2 p-2 bg-primary-950 border border-primary-800"
                        >
                          <span className="text-primary-400 font-mono text-sm flex-shrink-0">
                            {link.name}
                          </span>
                          <span className="text-primary-600 font-mono text-xs truncate flex-1">
                            {link.url}
                          </span>
                          {onRemoveLink && (
                            <button
                              onClick={() => handleRemoveLink(idx)}
                              disabled={isSaving}
                              className="text-red-500 hover:text-red-400 text-sm font-mono disabled:opacity-50"
                            >
                              ×
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Add New Link */}
                  {onAddLink && links.length < 10 && (
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={newLinkName}
                        onChange={(e) => setNewLinkName(e.target.value)}
                        maxLength={50}
                        className="flex-1 px-2 py-1.5 bg-primary-950 border border-primary-700 text-primary-300 font-mono text-sm focus:border-primary-500 focus:outline-none"
                        placeholder="Name"
                      />
                      <input
                        type="text"
                        value={newLinkUrl}
                        onChange={(e) => setNewLinkUrl(e.target.value)}
                        maxLength={200}
                        className="flex-[2] px-2 py-1.5 bg-primary-950 border border-primary-700 text-primary-300 font-mono text-sm focus:border-primary-500 focus:outline-none"
                        placeholder="https://..."
                      />
                      <button
                        onClick={handleAddLink}
                        disabled={isSaving || !newLinkName.trim() || !newLinkUrl.trim()}
                        className="px-3 py-1.5 bg-accent-900 border border-accent-600 text-accent-400 text-sm font-mono hover:bg-accent-800 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        +
                      </button>
                    </div>
                  )}
                  {links.length >= 10 && (
                    <p className="text-primary-600 font-mono text-xs mt-1">
                      Maximum 10 links reached
                    </p>
                  )}
                </div>
              )}

              {/* Links Display (View Mode) */}
              {!isEditing && links.length > 0 && (
                <div>
                  <h3 className="text-sm font-bold text-accent-400 mb-2 font-mono">
                    LINKS
                  </h3>
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
                        <span className="text-primary-700 text-xs truncate">
                          {link.url}
                        </span>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {/* Posts Feed */}
              {userPostsAddress && (
                <div className="mt-6 pt-6 border-t border-primary-800">
                  <UserPostsFeed
                    userPostsAddress={userPostsAddress}
                    repliesAddress={repliesAddress ?? null}
                    votingAddress={votingAddress ?? null}
                    profileOwner={userAddress}
                    provider={provider ?? null}
                    signer={signer}
                    currentAddress={currentUserAddress ?? null}
                    getDisplayName={getDisplayName}
                    onSelectUser={onSelectUser}
                    isOwnProfile={isOwnProfile}
                    selectedPostIndex={selectedPostFromUrl}
                    onPostChange={onPostChange}
                    getProfile={getProfile}
                    onFollow={onFollow}
                    onUnfollow={onUnfollow}
                    isFollowing={isFollowingUser}
                    onTip={onTip}
                    canTip={canTip}
                  />
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>

      {/* Tip Modal */}
      {userAddress && (
        <TipModal
          isOpen={showTipModal}
          onClose={() => setShowTipModal(false)}
          recipientAddress={userAddress}
          // ⭐ The profile page knows the display name; the hover card's `onTip(address)` does not.
          // So this route gives the nicer copy — "Sent 1.00 CASH to Ada" rather than to `0x1877…`.
          recipientName={profile?.displayName}
          // ⛔ THIS PROP IS WHAT MAKES THE MODAL FUNCTIONAL. Without it the modal renders its
          // "only works inside the Polkadot app" branch even inside the Polkadot app.
          payments={payments}
          onConnectWallet={onConnectWallet}
        />
      )}
    </div>
  );
}
