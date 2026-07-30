import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Toaster } from 'react-hot-toast';
import { useUserRegistry } from './hooks/useUserRegistry';
import { useHostSession } from './hooks/useHostSession';
import { PublisherProvider } from './hooks/usePublisher';
import { useDeployments } from './hooks/useDeployments';
import { useFollowRegistry } from './hooks/useFollowRegistry';
import { SessionStatus } from './components/SessionStatus';
import { Sidebar, type ViewMode, type SidebarSection } from './components/Sidebar';
import { ProfileView } from './components/ProfileView';
import { HostNotice } from './components/HostNotice';
import { SettingsView } from './components/SettingsView';
import { ForumView } from './components/ForumView';
import { TipModal } from './components/TipModal';

/**
 * ⛔ CHAT IS UNWIRED FROM THE UI, AND NOT DELETED FROM THE REPO.
 *
 * `useChannel`, `useChannelRegistry`, `ChatFeed`, `MessageInput`, `ChannelHeader`,
 * `ChannelModerationModal`, `UserListPanel` and `CreateChannelModal` are all still on disk with no
 * importer. They call `ChatChannel` and `ChannelRegistry`, which were deleted when rooms collapsed
 * into `PostRegistry`, so every one of them fails as an unreadable `require(false)` revert. The UI
 * must not offer what cannot work; the code stays because it is the starting point for the
 * migration, and `useForumThread` already demonstrates the pattern it needs.
 */

/**
 * The product name the host binds this session to, and the statement-store topic. Not cosmetic — the
 * host refuses to sign when the identifier disagrees with the URL it loaded.
 */
const APP_NAME = 'plaza';

function App() {
  // Load deployments from JSON file
  const { currentNetwork: deployments, error: deploymentsError } = useDeployments();

  // Get registry address from URL parameter or deployments.json
  const urlParams = new URLSearchParams(window.location.search);

  /**
   * ⚠️ `channelRegistry`, `forumThread`, `userPosts` and `replies` NO LONGER EXIST as contracts.
   * They collapsed into the one `PostRegistry`, where a room, a board, a thread and a profile feed
   * are all just `bytes32` registry ids. So all four of these now resolve to the same address, and
   * what used to distinguish them is a registry id passed at call time instead of a deployment.
   *
   * These are kept as separate names only so the not-yet-migrated views keep compiling; each one is
   * a marker for a call site that still speaks the old per-instance ABI.
   */
  const postRegistryAddress = urlParams.get('registry') || deployments?.postRegistry || null;
  const registryAddress = postRegistryAddress;
  const followRegistryAddress = urlParams.get('followRegistry') || deployments?.followRegistry || null;
  const userPostsAddress = postRegistryAddress;
  const repliesAddress = postRegistryAddress;
  const votingAddress = deployments?.voting || null;
  const forumThreadAddress = postRegistryAddress;
  const directProfileAddress = urlParams.get('profile');
  const directThreadIndex = urlParams.get('thread');
  const directPostIndex = urlParams.get('post');

  // Only show registry in URL if user provided non-default registry addresses
  const showRegistryInUrl = useMemo(() => {
    if (import.meta.env.VITE_SHOW_REGISTRY_IN_URL === 'true') return true;

    const params = new URLSearchParams(window.location.search);
    const urlRegistry = params.get('registry');

    // Show in URL only if user provided an address that differs from the default
    return !!urlRegistry && urlRegistry !== deployments?.postRegistry;
  }, [deployments?.postRegistry]);

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // THE HOST SESSION. One hook, replacing `useWallet` (MetaMask) and `useAppWallet` (standalone
  // in-app wallet), both deleted: architecture.md §1 decides the host container is the only surface,
  // so there is no wallet mode to persist, no mode to choose, and nothing to "connect".
  //
  // Everything the app used to derive from `walletMode` now comes from `host.capabilities`, which is
  // the ONLY thing components should branch on. See `lib/host/types.ts`.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  const host = useHostSession(APP_NAME);

  /**
   * The shim that keeps the 16 un-migrated feature hooks working unchanged.
   *
   * ⚠️ TRANSITIONAL, AND ITS KEY NAMES ARE THE ONLY REASON IT EXISTS. Every hook takes
   * `{ provider, signer }` shaped like this; they get migrated onto the seam once the contract
   * interface and Bulletin data layer land. Keeping the names means that migration touches each hook
   * once instead of twice. New code should read `host.*` directly and ignore this object.
   *
   * What went away with the wallet modes:
   *   · `browserProvider` — there is no MetaMask provider to fish a signer out of.
   *   · `profileSigner` vs `signer` — the split existed because owner-only operations had to be
   *     signed by the profile owner while delegatable ones could use the session wallet. Both now
   *     resolve to the same thing: the delegate arm, which the contract records as acting FOR the
   *     user. Host-signed owner-only calls need the prompting arm and the contract layer, which is
   *     not wired yet (`host.signer.host.submit === null`).
   *   · `isStandalone` / `isBrowser` — no modes left.
   */
  const walletConfig = useMemo(
    () => ({
      activeProvider: host.provider,
      activeAddress: host.address,
      signer: host.signer.delegateSigner,
      profileSigner: host.signer.delegateSigner,
      canRead: host.canRead,
      canWrite: host.canWrite,
      isReady: host.canWrite,
    }),
    [host.provider, host.address, host.signer, host.canRead, host.canWrite],
  );

  /**
   * The UserRegistry address, straight from deployments.json.
   *
   * ⚠️ This used to be discovered at runtime via `channelRegistry.getUserRegistryAddress()` — a call
   * on `ChannelRegistry`, which no longer exists. That call could only ever fail, so
   * `userRegistryAddress` stayed null forever and the ENTIRE profile system was disabled: no display
   * names anywhere, and "create a profile" could not work even once writes are wired. There is also
   * no reason to ask the chain: the three other contracts pin UserRegistry as a compile-time
   * constant, so this address is fixed by construction and deployments.json is its record.
   */
  const userRegistryAddress = deployments?.userRegistry ?? null;

  // User registry - enabled for reading even without wallet
  const userRegistry = useUserRegistry({
    registryAddress: userRegistryAddress,
    // `writeProvider` was the MetaMask BrowserProvider, used only to fish a signer out of the page.
    // There is no such provider any more; the read provider is the only one.
    writeProvider: null,
    provider: walletConfig.activeProvider,
    userAddress: walletConfig.activeAddress,
    signer: walletConfig.profileSigner,
    delegateSigner: walletConfig.signer,
    // Owner-only writes (createProfile) go through the product account, never the delegate.
    hostWrite: host.backend?.writeContract ?? null,
    enabled: !!userRegistryAddress,
  });

  // Refresh the profile when the account appears or changes.
  useEffect(() => {
    if (walletConfig.activeAddress && walletConfig.activeProvider) {
      userRegistry.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletConfig.activeAddress, walletConfig.activeProvider]);

  /**
   * View mode — URL param takes priority, then localStorage.
   *
   * ⚠️ THIS MUST NEVER RESOLVE TO THE OLD `'channels'` VALUE. Two inputs can still supply it: a
   * `?channel=0x…` link someone shared before chat was unwired, and a `viewMode` left in
   * localStorage by an earlier session. Both are ignored and fall through to `'forum'`, because the
   * alternative is a returning user landing on a view that renders nothing. The stale `?channel=`
   * param is then dropped from the URL by the navigation effect below.
   */
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    // URL params imply view mode
    if (directProfileAddress) return 'profile';
    if (directThreadIndex) return 'forum';
    const stored = localStorage.getItem('viewMode');
    if (stored === 'profile' || stored === 'forum') return stored;
    // Default to forum for new visitors, and for anyone arriving with a chat view persisted.
    return 'forum';
  });

  // Profile view state
  const [selectedProfile, setSelectedProfile] = useState<string | null>(() => {
    if (directProfileAddress) return directProfileAddress;
    return localStorage.getItem('selectedProfile');
  });

  // Forum thread view state
  const [selectedThread, setSelectedThread] = useState<number | null>(() => {
    if (directThreadIndex) {
      const parsed = parseInt(directThreadIndex, 10);
      return isNaN(parsed) ? null : parsed;
    }
    return null;
  });

  // User post view state (within profile view)
  const [selectedPost, setSelectedPost] = useState<number | null>(() => {
    if (directPostIndex) {
      const parsed = parseInt(directPostIndex, 10);
      return isNaN(parsed) ? null : parsed;
    }
    return null;
  });

  // Page title context (passed up from child components or derived)
  const [currentThreadTitle, setCurrentThreadTitle] = useState<string | null>(null);
  const [currentProfileName, setCurrentProfileName] = useState<string | null>(null);

  // Track last URL to prevent duplicate history entries
  const lastUrlRef = useRef<string>(window.location.href);

  // Sidebar expansion state
  const [sidebarExpanded, setSidebarExpanded] = useState(() => {
    const stored = localStorage.getItem('sidebarExpanded');
    if (stored) {
      try {
        return JSON.parse(stored);
      } catch {
        // ignore
      }
    }
    return { following: true };
  });

  const handleToggleSection = (section: SidebarSection) => {
    setSidebarExpanded((prev: Record<SidebarSection, boolean>) => ({
      ...prev,
      [section]: !prev[section],
    }));
  };

  // Persist sidebar expansion
  useEffect(() => {
    localStorage.setItem('sidebarExpanded', JSON.stringify(sidebarExpanded));
  }, [sidebarExpanded]);

  // Persist selected profile
  useEffect(() => {
    if (selectedProfile) {
      localStorage.setItem('selectedProfile', selectedProfile);
    }
  }, [selectedProfile]);

  // Fetch profile display name for page title
  useEffect(() => {
    if (selectedProfile && userRegistry.getProfile) {
      userRegistry.getProfile(selectedProfile)
        .then(profile => setCurrentProfileName(profile?.displayName || null))
        .catch(() => setCurrentProfileName(null));
    } else {
      setCurrentProfileName(null);
    }
  }, [selectedProfile, userRegistry.getProfile]);

  // Persist view mode
  useEffect(() => {
    localStorage.setItem('viewMode', viewMode);
  }, [viewMode]);

  // Handle browser back/forward navigation
  useEffect(() => {
    const handlePopState = () => {
      const urlParams = new URLSearchParams(window.location.search);
      const profile = urlParams.get('profile');
      const thread = urlParams.get('thread');
      const post = urlParams.get('post');

      // Update lastUrlRef to current URL to prevent re-pushing
      lastUrlRef.current = window.location.href;

      // Determine view mode and selections from URL
      if (thread !== null) {
        setViewMode('forum');
        setSelectedThread(parseInt(thread, 10));
      } else if (profile) {
        setViewMode('profile');
        setSelectedProfile(profile);
        setSelectedPost(post ? parseInt(post, 10) : null);
      } else {
        // Default to forum when no specific view. A `?channel=` param in the history entry is
        // deliberately not honoured — chat has no view to return to.
        setViewMode('forum');
        setSelectedThread(null);
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Follow Registry hook - enabled for reading even without wallet
  const followRegistry = useFollowRegistry({
    registryAddress: followRegistryAddress,
    provider: walletConfig.activeProvider,
    userAddress: walletConfig.activeAddress,
    signer: walletConfig.signer,
    enabled: !!followRegistryAddress,
  });

  // ⛔ THE AUTO-PROFILE-CREATION EFFECT IS GONE, ON PURPOSE.
  //
  // It fired on load for standalone-wallet users and sent a profile-creation transaction without
  // being asked. Inside a host container that is not a silent convenience: profile creation is a
  // contract call, every contract call reaches an unconditional signing modal (architecture.md §5),
  // and creating contract storage costs a deposit. So the old behaviour would show every new visitor a
  // signature request they did not ask for, before they had done anything.
  //
  // Profile creation now happens where the user initiated something — `handleSendMessage` below, and
  // the settings screen.

  // Get display name helper - depends only on getProfile to avoid frequent recreation
  const getDisplayName = useCallback(async (address: string): Promise<string> => {
    try {
      const profile = await userRegistry.getProfile(address);
      return profile.exists ? profile.displayName : '';
    } catch {
      return '';
    }
  }, [userRegistry.getProfile]);

  // Update URL and page title when navigation state changes
  useEffect(() => {
    const url = new URL(window.location.href);

    // Only include registry if config enabled or user originally provided it
    if (showRegistryInUrl) {
      if (registryAddress) url.searchParams.set('registry', registryAddress);
    } else {
      url.searchParams.delete('registry');
    }

    // Set profile or thread param based on view mode. Every branch deletes `channel`, which is how
    // a stale chat deep link leaves the address bar on the first render after arrival.
    if (viewMode === 'profile' && selectedProfile) {
      url.searchParams.set('profile', selectedProfile);
      if (selectedPost !== null) {
        url.searchParams.set('post', String(selectedPost));
      } else {
        url.searchParams.delete('post');
      }
      url.searchParams.delete('channel');
      url.searchParams.delete('thread');
    } else if (viewMode === 'forum') {
      if (selectedThread !== null) {
        url.searchParams.set('thread', String(selectedThread));
      } else {
        url.searchParams.delete('thread');
      }
      url.searchParams.delete('channel');
      url.searchParams.delete('profile');
      url.searchParams.delete('post');
    } else {
      // No selection - remove all
      url.searchParams.delete('channel');
      url.searchParams.delete('profile');
      url.searchParams.delete('post');
      url.searchParams.delete('thread');
    }

    // Determine page title
    let title = 'Plaza';
    if (viewMode === 'forum' && selectedThread !== null && currentThreadTitle) {
      title = `${currentThreadTitle} - Plaza`;
    } else if (viewMode === 'profile' && selectedProfile) {
      title = currentProfileName
        ? `${currentProfileName} - Profile - Plaza`
        : 'Profile - Plaza';
    } else if (viewMode === 'forum') {
      title = 'Forum - Plaza';
    }

    // Update page title
    document.title = title;

    // Push to history if URL changed (use pushState for history entries)
    const newUrl = url.toString();
    if (newUrl !== lastUrlRef.current) {
      window.history.pushState({}, title, newUrl);
      lastUrlRef.current = newUrl;
    }
  }, [viewMode, selectedProfile, selectedPost, selectedThread, currentThreadTitle, currentProfileName, showRegistryInUrl, registryAddress]);

  // Modals
  const [showHostNotice, setShowHostNotice] = useState(false);
  const [tipTargetAddress, setTipTargetAddress] = useState<string | null>(null);

  // Handler to navigate to profile (click navigates, tooltip shows on hover)
  const openProfile = useCallback((address: string | null) => {
    if (address) {
      setSelectedProfile(address);
      setSelectedPost(null); // Clear post selection when changing profiles
      setViewMode('profile');
    }
  }, []);

  /**
   * ⛔ `requireWallet`, `handleSendMessage`, `canPost` and the channel-management permission check all lived
   * here and went out with the chat view. The rule they encoded has NOT gone away and applies to
   * every remaining composer: gate on `canWrite`, NEVER on `canPushLive`. An account with a Bulletin
   * authorization and no personhood proof has `canWrite && !canPushLive` — the common case — and must
   * be able to post; the only thing it loses is instant propagation. `ForumView` and `ProfileView`
   * take `disabled={!walletConfig.canWrite}` for exactly this reason.
   */

  // Note: the host notice is never forced on load. Users browse freely; it only appears when they
  // attempt a write and cannot.

  // No profile yet, but there is an account to make one for.
  const showCreateProfileBanner =
    !!host.address && userRegistry.profile !== null && !userRegistry.profile.exists;

  /**
   * The posting key is worth setting up.
   *
   * ⚠️ IT IS AN OFFER, NOT A REQUIREMENT, and it must read that way. Without a delegate every post
   * still works — it just costs a signing modal each time, and some people prefer signing everything.
   *
   * ⚠️ SCOPED TO THE PROFILE SCREEN. It used to render on EVERY screen for as long as no delegate
   * existed, which turns an optional convenience into nagging: a persistent bar reads as an unfinished
   * task, not an offer, and there is no way to dismiss it by declining. On the profile screen, next to
   * the account it concerns, it is information; everywhere else it was noise.
   */
  const showDelegateBanner =
    viewMode === 'profile' &&
    !!host.address &&
    userRegistry.profile?.exists &&
    !!host.delegation &&
    !host.delegation.active;

  // ⛔ REMOVED: `showSetupProfileBanner` (`profile.exists && !profile.bio`).
  // A missing bio is not a problem. The banner nagged permanently over a perfectly good profile that
  // simply had no bio, and it could only be silenced by writing one — i.e. the app demanded content
  // the user had chosen not to provide. If a profile has a display name, it is set up.

  return (
    /**
     * The write path, provided once for the whole tree.
     *
     * ⚠️ CONTEXT, NOT PROPS — the composers are four and five levels down and every component in
     * between is presentation. `null` inside means this session cannot write, which is the honest
     * read-only state rather than an error. See `hooks/usePublisher.tsx`.
     */
    <PublisherProvider
      postRegistryAddress={postRegistryAddress}
      provider={walletConfig.activeProvider}
      author={walletConfig.activeAddress}
      putBlob={host.backend ? (bytes, opts) => host.backend!.putBlob(bytes, opts) : null}
      hostWrite={host.backend?.writeContract ?? null}
    >
    <div className="h-screen bg-black flex flex-col scanline">
      <Toaster
        position="top-right"
        toastOptions={{
          duration: 4000,
          style: {
            background: 'var(--color-bg-primary)',
            color: 'var(--color-primary-500)',
            border: '1px solid var(--color-primary-500)',
            fontFamily: "'IBM Plex Mono', monospace",
            boxShadow: '0 0 20px rgba(255, 136, 0, calc(0.5 * var(--enable-glow)))',
          },
          success: {
            iconTheme: {
              primary: 'var(--color-primary-500)',
              secondary: 'var(--color-bg-primary)'
            },
          },
          error: {
            style: {
              background: '#1a0000',
              color: 'var(--color-error)',
              border: '1px solid var(--color-error)',
              boxShadow: '0 0 20px rgba(220, 38, 38, calc(0.5 * var(--enable-glow)))',
            },
            iconTheme: {
              primary: 'var(--color-error)',
              secondary: '#1a0000'
            },
          },
          loading: {
            iconTheme: {
              primary: 'var(--color-accent-400)',
              secondary: 'var(--color-bg-accent)'
            },
          },
        }}
      />

      {/* Header */}
      <header className="border-b-2 border-primary-500 bg-black">
        <div className="flex items-center justify-between p-4">
          <button
            onClick={() => {
              setViewMode('forum');
              setSelectedThread(0);
            }}
            className="flex items-baseline gap-4 hover:opacity-80 transition-opacity"
          >
            <h1 className="text-2xl font-bold text-primary-500 text-shadow-neon">
              PLAZA
            </h1>
            <span className="text-sm text-accent-400 text-shadow-neon-sm font-mono">
              DECENTRALIZED SOCIAL
            </span>
          </button>
          <SessionStatus
            isInitializing={host.isInitializing}
            canRead={host.canRead}
            canWrite={host.canWrite}
            insideHost={host.capabilities.insideHost}
            onExplain={() => setShowHostNotice(true)}
          />
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex overflow-hidden">
        {/* Sidebar: profile, forum and following. There is no channels section — see Sidebar.tsx. */}
        {registryAddress && (
          <Sidebar
            isConnected={!!walletConfig.activeAddress}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            getDisplayName={getDisplayName}
            following={followRegistry.following}
            selectedProfile={selectedProfile}
            onSelectProfile={setSelectedProfile}
            followRegistryAvailable={!!followRegistryAddress}
            sidebarExpanded={sidebarExpanded}
            onToggleSection={handleToggleSection}
            currentUserAddress={walletConfig.activeAddress}
            currentUserDisplayName={userRegistry.profile?.displayName || null}
            forumAvailable={!!forumThreadAddress}
          />
        )}

        {/* Main content area (chat + user list) - wrapped for profile overlay */}
        <div className="flex-1 flex relative">
          {/* Chat area */}
          <div className="flex-1 flex flex-col bg-black">
          {/* Contracts could not be located. This used to say "NO REGISTRY SPECIFIED / add
              ?registry=0x… to URL", which asked the user to supply a ChannelRegistry — a contract
              that no longer exists. Addresses now come from deployments.json, so if we get here it is
              our configuration that is broken, not the user's URL, and the message should say so. */}
          {!registryAddress && (
            <div className="border-b-2 border-yellow-500 bg-yellow-950 bg-opacity-20 p-4">
              <div className="flex items-center font-mono">
                <span className="text-yellow-500 mr-3 text-xl">!</span>
                <div>
                  <p className="text-yellow-400 text-sm">CONTRACT ADDRESSES NOT LOADED</p>
                  <p className="text-yellow-600 text-xs mt-1">
                    {deploymentsError
                      ? deploymentsError
                      : 'deployments.json did not provide a postRegistry address for this network.'}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Profile creation banner */}
          {showCreateProfileBanner && (
            <div className="border-b-2 border-accent-500 bg-accent-950 bg-opacity-20 p-4">
              <div className="flex items-center justify-between font-mono">
                <div className="flex items-center">
                  <span className="text-accent-500 mr-3">i</span>
                  <span className="text-accent-400 text-sm">Create a profile to start posting</span>
                </div>
                <button
                  onClick={() => setViewMode('settings')}
                  className="px-4 py-1 bg-accent-900 text-accent-400 border border-accent-500 text-sm"
                >
                  CREATE PROFILE
                </button>
              </div>
            </div>
          )}

          {/* Posting-key offer. Optional, and worded as one — posting works without it, at the cost
              of one signing prompt per post. */}
          {showDelegateBanner && (
            <div className="border-b-2 border-accent-500 bg-accent-950 bg-opacity-20 p-4">
              <div className="flex items-center justify-between font-mono">
                <div className="flex items-center">
                  <span className="text-accent-500 mr-3">i</span>
                  <span className="text-accent-400 text-sm">
                    Set up a posting key to stop approving every post
                  </span>
                </div>
                <button
                  onClick={() => setViewMode('settings')}
                  className="px-4 py-1 bg-accent-900 text-accent-400 border border-accent-500 text-sm"
                >
                  SET UP POSTING KEY
                </button>
              </div>
            </div>
          )}

          {/* ⛔ The "Set up your profile with a username and bio" banner was deleted here — see the
              note next to `showDelegateBanner`. A profile with a display name is set up; a missing bio
              is a choice, not an incomplete task, and the banner could only be dismissed by writing
              one. */}

          {/* Error display.
              ⚠️ `capabilities.reason` is NOT included here on purpose. It is not an error — it is the
              normal state of a visitor who is reading, and putting it in a red banner would tell every
              anonymous reader that something is broken. It belongs in the host notice and the settings
              screen, where it reads as an explanation. */}
          {userRegistry.error && (
            <div className="border-b-2 border-red-500 bg-red-950 bg-opacity-20 p-4">
              <div className="flex items-center font-mono">
                <span className="text-red-500 mr-3">X</span>
                <p className="text-red-400 text-sm">{userRegistry.error}</p>
              </div>
            </div>
          )}

          {/* Conditional content based on view mode. The `'channels'` branch — ChannelHeader,
              ChatFeed, MessageInput — was removed with the chat view; `ViewMode` no longer has that
              member, so nothing can route here. */}
          {viewMode === 'profile' ? (
            // Profile view
            <ProfileView
              userAddress={selectedProfile}
              currentUserAddress={walletConfig.activeAddress}
              getProfile={userRegistry.getProfile}
              isFollowing={selectedProfile ? followRegistry.isFollowingSync(selectedProfile) : false}
              onFollow={followRegistry.follow}
              onUnfollow={followRegistry.unfollow}
              followLoading={followRegistry.isLoading}
              followerCount={followRegistry.followerCount}
              followingCount={followRegistry.followingCount}
              userPostsAddress={userPostsAddress}
              repliesAddress={repliesAddress}
              votingAddress={votingAddress}
              provider={walletConfig.activeProvider}
              signer={walletConfig.signer}
              getDisplayName={getDisplayName}
              onSelectUser={openProfile}
              getLinks={userRegistry.getLinks}
              onUpdateDisplayName={userRegistry.updateDisplayName}
              onUpdateBio={userRegistry.updateBio}
              onAddLink={userRegistry.addLink}
              onRemoveLink={userRegistry.removeLink}
              sessionWallet={walletConfig.signer}
              sessionWalletAddress={host.delegation?.address ?? null}
              sessionWalletBalance={host.delegation?.balance ?? 0n}
              isFollowingUser={followRegistry.isFollowingSync}
              onTip={setTipTargetAddress}
              canTip={host.canWrite}
              onConnectWallet={() => setShowHostNotice(true)}
              selectedPostFromUrl={selectedPost}
              onPostChange={setSelectedPost}
            />
          ) : viewMode === 'forum' ? (
            // Forum view (public threads)
            <ForumView
              forumThreadAddress={forumThreadAddress}
              repliesAddress={repliesAddress}
              votingAddress={votingAddress}
              userRegistryAddress={userRegistryAddress}
              provider={walletConfig.activeProvider}
              signer={walletConfig.signer}
              currentAddress={walletConfig.activeAddress}
              getDisplayName={getDisplayName}
              onSelectUser={openProfile}
              disabled={!walletConfig.canWrite}
              selectedThreadFromUrl={selectedThread}
              onThreadChange={setSelectedThread}
              onThreadTitleChange={setCurrentThreadTitle}
              getProfile={userRegistry.getProfile}
              onFollow={followRegistry.follow}
              onUnfollow={followRegistry.unfollow}
              isFollowing={followRegistry.isFollowingSync}
              onTip={setTipTargetAddress}
              canTip={host.canWrite}
            />
          ) : viewMode === 'settings' ? (
            // Settings view
            <SettingsView
              capabilities={host.capabilities}
              label={host.label}
              diagnostics={host.diagnostics}
              profile={userRegistry.profile}
              onCreateProfile={userRegistry.createProfile}
              onUpdateDisplayName={userRegistry.updateDisplayName}
              onUpdateBio={userRegistry.updateBio}
              delegation={host.delegation}
              onAuthorizeDelegate={host.authorizeDelegate}
              onRevokeDelegate={host.revokeDelegate}
              onRequestAllowanceAgain={host.requestAllowanceAgain}
            />
          ) : null}
          </div>

          {/* The `UserListPanel` rendered here for the chat view only. It listed the participants of
              a room, derived from `channel.messages`, so it has nothing to show without chat. */}
        </div>
      </main>

      {/* Modals.
          `HostNotice` replaces WalletChoiceModal, SessionAccountSetup, PrivateKeyExportModal and
          LinkBrowserWalletModal — all four existed to manage a choice between MetaMask and an in-app
          wallet, which architecture.md §1 removes. There is no choice to present, so what is left is
          an explanation plus the diagnostics record. */}
      <HostNotice
        isOpen={showHostNotice}
        onClose={() => setShowHostNotice(false)}
        capabilities={host.capabilities}
        label={host.label}
        diagnostics={host.diagnostics}
      />


      {/* Tip Modal (triggered from tooltip) */}
      {tipTargetAddress && (
        <TipModal
          isOpen={true}
          onClose={() => setTipTargetAddress(null)}
          recipientAddress={tipTargetAddress}
          sessionWallet={walletConfig.signer}
          sessionWalletAddress={host.delegation?.address ?? null}
          sessionWalletBalance={host.delegation?.balance ?? 0n}
          onConnectWallet={() => setShowHostNotice(true)}
        />
      )}

      </div>
    </PublisherProvider>
  );
}

export default App;
