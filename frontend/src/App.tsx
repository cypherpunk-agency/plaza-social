import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Toaster } from 'react-hot-toast';
import { useUserRegistry } from './hooks/useUserRegistry';
import { useHostSession } from './hooks/useHostSession';
import { PublisherProvider } from './hooks/usePublisher';
import { PaymentsProvider } from './hooks/usePayments';
import { useDeployments } from './hooks/useDeployments';
import { useFollowRegistry } from './hooks/useFollowRegistry';
import { SessionStatus } from './components/SessionStatus';
import { Sidebar, SIDEBAR_DRAWER_ID, type ViewMode, type SidebarSection } from './components/Sidebar';
import { PANE_HEADER } from './components/paneChrome';
import { ProfileView } from './components/ProfileView';
import { HostNotice } from './components/HostNotice';
import { SettingsView } from './components/SettingsView';
import { ForumView } from './components/ForumView';
import { TipModal } from './components/TipModal';
import { readThreadSelection, writeThreadSelection } from './lib/threadLink';

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

/**
 * A short name for whatever view a history entry represents. Used only as the *label* on the back
 * control ("← BACK TO THREAD"); navigation itself is `history.back()`.
 */
type ViewLabel = 'FORUM' | 'THREAD' | 'PROFILE' | 'SETTINGS';

/**
 * What we stash on each history entry we push.
 *
 * ⚠️ `plazaDepth` IS HOW WE KNOW THERE IS ANYWHERE TO GO BACK TO, and it lives on the entry rather
 * than in a React ref on purpose: a ref is reset by a reload, and a reloaded deep entry still has a
 * real predecessor. A cold load has no state at all, so `undefined → 0` is exactly the "you arrived
 * here directly" case. Forward navigation is handled for free, because the entry carries its own
 * depth rather than us trying to count `popstate` events in the right direction.
 *
 * `plazaBackLabel` is the label of the entry we were LEAVING when this one was pushed — i.e. what
 * `history.back()` will land on. Null means we do not honestly know, and the control says `← BACK`.
 */
interface PlazaHistoryState {
  plazaDepth?: number;
  plazaBackLabel?: ViewLabel | null;
}

function readHistoryState(): PlazaHistoryState {
  const state = window.history.state as PlazaHistoryState | null;
  return state && typeof state === 'object' ? state : {};
}

/**
 * The label a URL denotes — the same precedence the `popstate` handler resolves state with (a thread
 * selection wins over a profile, everything else is the forum), so a label can never promise a
 * destination different from the one Back actually restores.
 *
 * Used to seed the FIRST entry of a session. Without it the first push has no recorded origin and
 * the control degrades to a bare `← BACK`, which is the common case whenever a persisted
 * `viewMode: 'profile'` moves the URL on load.
 */
function labelOfUrl(search: string): ViewLabel {
  const params = new URLSearchParams(search);
  const thread = readThreadSelection(params);
  if (thread.cid || thread.legacyIndex !== null) return 'THREAD';
  if (params.get('profile')) return 'PROFILE';
  return 'FORUM';
}

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
  const directPostIndex = urlParams.get('post');

  /**
   * The inbound thread deep link.
   *
   * ⚠️ `?cid=` IS THE LINK; `?thread=N` IS A POSITION AND ONLY SURVIVES BECAUSE IT WAS PUBLISHED.
   * `N` indexed the page `useForumThread` happened to have walked, so a shared `?thread=` retargeted
   * itself whenever anybody posted. `readThreadSelection` lets `cid` win when both are present and
   * refuses to guess at a malformed `thread`; `ForumView` converts a surviving position into a CID
   * as soon as the list arrives, after which the param is gone for good. See `lib/threadLink.ts`.
   */
  const initialThreadSelection = readThreadSelection(window.location.search);

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
   *     signed by the profile owner while delegatable ones could use the session wallet.
   *   · `isStandalone` / `isBrowser` — no modes left.
   *
   * ⛔ AND `signer` IS NOW PERMANENTLY `null`, 2026-07-31. It was `host.signer.delegateSigner`, an
   * `ethers.Wallet` on a public RPC that could never have worked — unfunded key, and every call site
   * naming `vote(…)`/`follow(…)` instead of `voteFor(…)`/`followFor(…)`. See `lib/host/types.ts`
   * `SignerSeam`. Contract writes go through `host.backend.writeContract`, which the hooks reach via
   * `useHostWrite()` (see `hooks/usePublisher.tsx`) rather than through a prop.
   *
   * The key is kept in the object, still passed down, still `null`: about ten presentation
   * components declare a `signer` prop and only forward it. Removing it means editing all of them to
   * delete a word, and they are not this change's business.
   */
  const walletConfig = useMemo(
    () => ({
      activeProvider: host.provider,
      activeAddress: host.address,
      signer: null,
      profileSigner: null,
      canRead: host.canRead,
      canWrite: host.canWrite,
      isReady: host.canWrite,
    }),
    [host.provider, host.address, host.canRead, host.canWrite],
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
    if (initialThreadSelection.cid || initialThreadSelection.legacyIndex !== null) return 'forum';
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

  /**
   * Forum thread selection — the CID, which is the thread's identity.
   *
   * ⚠️ NOT PERSISTED TO `localStorage`, unlike `viewMode` and `selectedProfile`. A cold load lands on
   * the board, not on whatever thread you last read; restoring it would make a plain visit
   * indistinguishable from following a link.
   */
  const [selectedThreadCid, setSelectedThreadCid] = useState<string | null>(
    () => initialThreadSelection.cid,
  );

  /**
   * ⚠️ TRANSIENT, AND ONLY EVER SET FROM AN INBOUND `?thread=N`. `ForumView` is the only component
   * that holds the loaded page, so it is the only thing that can turn this position into a CID; it
   * calls `onThreadChange` with the answer, which lands in `selectedThreadCid` and clears this.
   * Nothing writes a new value here.
   */
  const [legacyThreadIndex, setLegacyThreadIndex] = useState<number | null>(
    () => initialThreadSelection.legacyIndex,
  );

  /** The one place a thread selection changes. Setting a CID always retires the legacy position. */
  const selectThread = useCallback((cid: string | null) => {
    setSelectedThreadCid(cid);
    setLegacyThreadIndex(null);
  }, []);

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

  /**
   * ─── THE BACK CONTROL ──────────────────────────────────────────────────────────────────────────
   *
   * Reported: "when I click on a profile, I don't get a back button — but I was just reading a
   * thread." The history stack was already correct — the navigation effect below `pushState`s every
   * view change and the `popstate` handler above re-derives state from the URL — so `history.back()`
   * genuinely does restore the thread. What was missing is an AFFORDANCE, and inside the host
   * container it is the only possible one: Plaza runs in an iframe under the dot.li shell, so the
   * address bar belongs to the shell and there is no browser Back the user can reach.
   *
   * ⚠️ SO DO NOT BUILD A PARALLEL NAVIGATION STACK. `previousViewState` does not exist and should
   * not come back; the browser already holds this.
   *
   * The one thing `history.back()` cannot decide for itself is whether there is anything to go back
   * TO. A cold load straight onto `?profile=0x…` — a shared link, or `viewMode` restored from
   * localStorage — has the profile as the FIRST entry, and `back()` would leave Plaza entirely.
   * `plazaDepth` on the history entry answers that: 0 (or absent) means we pushed nothing, so the
   * control falls back to an explicit "BACK TO FORUM" that navigates by state instead.
   */
  const historyDepthRef = useRef<number>(readHistoryState().plazaDepth ?? 0);
  /** The label of the view the CURRENT entry was pushed FROM. `null` → render a generic `← BACK`. */
  const lastLabelRef = useRef<ViewLabel | null>(labelOfUrl(window.location.search));
  const [backTarget, setBackTarget] = useState<{ canGoBack: boolean; label: ViewLabel | null }>(
    () => {
      const state = readHistoryState();
      return {
        canGoBack: (state.plazaDepth ?? 0) > 0,
        label: state.plazaBackLabel ?? null,
      };
    },
  );

  /**
   * ⚠️ SEPARATE FROM `sidebarExpanded` AND IT MUST STAY THAT WAY. `sidebarExpanded` is which
   * SECTIONS of the nav are unfolded, and it is persisted. This is whether the nav PANEL is on
   * screen at all below `xl`, and it is deliberately transient — a drawer that remembers being open
   * across loads is a drawer that covers the app on arrival.
   */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  /**
   * Closing restores focus to the control that opened it. `Sidebar` owns moving focus IN; the
   * toggle lives up here, so returning it is this side's job. Both `.focus()` calls are no-ops at
   * `xl`, where the button is `display: none` and nothing was ever "opened".
   */
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    menuButtonRef.current?.focus();
  }, []);

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
      const post = urlParams.get('post');
      // ⚠️ Parsed through the same function the projection writes with, so Back can never disagree
      // with Forward about what a URL means. `cid` wins over a legacy `thread`.
      const thread = readThreadSelection(urlParams);

      // Update lastUrlRef to current URL to prevent re-pushing
      lastUrlRef.current = window.location.href;

      // The entry we just landed on carries its own depth and back-label, so Back and Forward are
      // both handled without counting events or guessing a direction.
      const historyState = readHistoryState();
      historyDepthRef.current = historyState.plazaDepth ?? 0;
      setBackTarget({
        canGoBack: historyDepthRef.current > 0,
        label: historyState.plazaBackLabel ?? null,
      });

      // Determine view mode and selections from URL
      if (thread.cid || thread.legacyIndex !== null) {
        setViewMode('forum');
        setSelectedThreadCid(thread.cid);
        setLegacyThreadIndex(thread.legacyIndex);
      } else if (profile) {
        setViewMode('profile');
        setSelectedProfile(profile);
        setSelectedPost(post ? parseInt(post, 10) : null);
      } else {
        // Default to forum when no specific view. A `?channel=` param in the history entry is
        // deliberately not honoured — chat has no view to return to.
        setViewMode('forum');
        setSelectedThreadCid(null);
        setLegacyThreadIndex(null);
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
    // ⚠️ THE PROP, NOT THE CONTEXT. `App` renders `PublisherProvider`, so it is ABOVE
    // `HostWriteContext` and `useHostWrite()` would be null here. See the hook's `hostWrite` doc.
    hostWrite: host.backend?.writeContract ?? null,
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

  /**
   * ⭐ THE DISPLAY-NAME HELPER. BATCHED AND CACHED UNDERNEATH, AND ITS IDENTITY NEVER CHANGES.
   *
   * ⚠️ THE STABILITY IS THE LOAD-BEARING PART, not the caching. This function is handed to
   * `useForumThread`, `useUserPosts`, `useReplies` and `Sidebar`; inside those hooks it is a
   * dependency of the loader, and the loader used to be a dependency of the 30-second poll's
   * effect. An unstable `getDisplayName` therefore tore the interval down and restarted it on every
   * render — so the 30 seconds never elapsed and **the poll silently never fired**. Those hooks now
   * hold the loader in a ref for exactly that reason, and this `useCallback([])` is the other half:
   * belt and braces, because the failure is invisible (nothing errors, the list simply stops
   * updating).
   *
   * ⛔ DO NOT ADD A DEPENDENCY HERE. `userRegistry.getProfile` changes identity whenever the
   * registry address or the reader does, which is precisely the event that used to restart every
   * poll. It is read through a latch instead — see below.
   *
   * ⚠️ THE BATCHING IS NOT HERE, IT IS IN `useUserRegistry`. `getProfile` is now a batched,
   * 60-second-cached read over `UserRegistry.getProfiles(address[])`, so the fifty calls this
   * function makes while the board renders collapse into ONE `getProfiles`, and the next poll
   * usually makes none at all. Everything else that reads a profile — the hover tooltip, the
   * profile modal, the sidebar's follow list — shares that cache without knowing it exists.
   */
  const getProfileLatch = useRef(userRegistry.getProfile);
  // ⚠️ ASSIGNED DURING RENDER, NOT IN AN EFFECT, AND THAT IS NOT AN OVERSIGHT. React runs CHILD
  // effects before parent effects, so a child that asks for a display name in its own mount effect
  // would read a latch this component had not updated yet — i.e. the previous reader, right after
  // the reader changed. A plain latest-value latch has no ordering to get wrong.
  getProfileLatch.current = userRegistry.getProfile;

  const getDisplayName = useCallback(async (address: string): Promise<string> => {
    try {
      const profile = await getProfileLatch.current(address);
      // ⚠️ '' MEANS "NO NAME TO SHOW", and it has to stay distinguishable from a name. A profile
      // that does not exist has an empty `displayName` anyway; a read that FAILED also lands here,
      // and the callers render the address instead of inventing one.
      return profile.exists ? profile.displayName : '';
    } catch {
      return '';
    }
  }, []);

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
      writeThreadSelection(url.searchParams, { cid: null, legacyIndex: null });
    } else if (viewMode === 'forum') {
      // One function owns the `cid`/`thread` pair, and it is the same one `readThreadSelection`
      // reverses. It only ever WRITES `cid`; `thread` survives just long enough for `ForumView` to
      // resolve an inbound legacy link.
      writeThreadSelection(url.searchParams, {
        cid: selectedThreadCid,
        legacyIndex: legacyThreadIndex,
      });
      url.searchParams.delete('channel');
      url.searchParams.delete('profile');
      url.searchParams.delete('post');
    } else {
      // No selection - remove all
      url.searchParams.delete('channel');
      url.searchParams.delete('profile');
      url.searchParams.delete('post');
      writeThreadSelection(url.searchParams, { cid: null, legacyIndex: null });
    }

    // Determine page title
    let title = 'Plaza';
    if (viewMode === 'forum' && selectedThreadCid !== null && currentThreadTitle) {
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

    /**
     * The short name of the view this render represents. Recorded so the NEXT push can tell the
     * back control what it will land on — the entry we are about to leave is described by the label
     * from the previous run, which is what `lastLabelRef` holds at this point.
     */
    const label: ViewLabel =
      viewMode === 'profile'
        ? 'PROFILE'
        : viewMode === 'settings'
          ? 'SETTINGS'
          : selectedThreadCid || legacyThreadIndex !== null
            ? 'THREAD'
            : 'FORUM';

    // Push to history if URL changed (use pushState for history entries)
    const newUrl = url.toString();
    if (newUrl !== lastUrlRef.current) {
      const backLabel = lastLabelRef.current;
      const depth = historyDepthRef.current + 1;
      // ⚠️ The state object is no longer `{}`. It is what tells a later render whether Back has
      // anywhere to go — see `PlazaHistoryState`. Anything else pushing history must carry it too,
      // or the back control will silently offer to leave the app.
      window.history.pushState(
        { plazaDepth: depth, plazaBackLabel: backLabel } satisfies PlazaHistoryState,
        title,
        newUrl,
      );
      historyDepthRef.current = depth;
      setBackTarget({ canGoBack: true, label: backLabel });
      lastUrlRef.current = newUrl;
    }

    lastLabelRef.current = label;
  }, [viewMode, selectedProfile, selectedPost, selectedThreadCid, legacyThreadIndex, currentThreadTitle, currentProfileName, showRegistryInUrl, registryAddress]);

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
   * Leaving a profile.
   *
   * ⚠️ TWO DIFFERENT MECHANISMS, AND THE CHOICE IS NOT COSMETIC. When this session pushed the entry
   * (`plazaDepth > 0`), `history.back()` is the right move: the `popstate` handler re-derives
   * `viewMode`, `selectedThreadCid` and `legacyThreadIndex` from the URL, so the thread you were
   * reading comes back with its scroll position and its loaded replies, and Forward still works.
   * Setting state instead would push a THIRD entry and strand the thread behind two Backs.
   *
   * When the profile IS the first entry — a shared `?profile=…` link, or `viewMode` restored from
   * localStorage — `history.back()` would leave Plaza for whatever the container had open before,
   * with no way home. So that case navigates by state to the forum, and the label says so.
   */
  const handleProfileBack = useCallback(() => {
    if (backTarget.canGoBack) {
      window.history.back();
      return;
    }
    setViewMode('forum');
    selectThread(null);
    setSelectedPost(null);
  }, [backTarget.canGoBack, selectThread]);

  /**
   * Named for where it actually goes, and generic only when we genuinely do not know — a `← BACK`
   * that lands somewhere unexpected is worse than one that promised nothing.
   */
  const backLabel = !backTarget.canGoBack
    ? 'BACK TO FORUM'
    : backTarget.label
      ? `BACK TO ${backTarget.label}`
      : 'BACK';

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
    {/*
      The CASH seam, provided once for the same reason the write path is: a hover card four levels
      down needs it, and `canTip`/`onTip` are already drilled through nine components. `null` means
      this session cannot pay — the honest state, not an error. See `hooks/usePayments.tsx`.
    */}
    <PaymentsProvider payments={host.backend?.payments ?? null}>
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
        <div className="flex items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-3 min-w-0">
          {/* The drawer toggle. `xl:hidden` — above the breakpoint the nav is a static column and
              there is nothing to toggle, which is also why `aria-expanded` is not a lie there: the
              button does not exist. Only rendered when there IS a sidebar to open. */}
          {registryAddress && (
            <button
              type="button"
              ref={menuButtonRef}
              onClick={() => (drawerOpen ? closeDrawer() : setDrawerOpen(true))}
              aria-expanded={drawerOpen}
              aria-controls={SIDEBAR_DRAWER_ID}
              className="xl:hidden shrink-0 px-3 py-2 leading-none font-mono text-lg text-primary-500 border border-primary-700 hover:border-primary-500 transition-colors"
            >
              <span aria-hidden="true">&#9776;</span>
              <span className="sr-only">Navigation menu</span>
            </button>
          )}
          <button
            onClick={() => {
              // ⚠️ WAS `setSelectedThread(0)`. The home button selected the FIRST THREAD in the
              // loaded page rather than clearing the selection — clicking PLAZA opened a thread,
              // and which one depended on who had posted most recently.
              setViewMode('forum');
              selectThread(null);
            }}
            className="flex items-baseline gap-4 min-w-0 hover:opacity-80 transition-opacity"
          >
            <h1 className="text-2xl font-bold text-primary-500 text-shadow-neon">
              PLAZA
            </h1>
            {/* `truncate min-w-0` so the added toggle cannot push a 375px header into horizontal
                scroll — the tagline gives way, the wordmark and the toggle do not. */}
            <span className="text-sm text-accent-400 text-shadow-neon-sm font-mono truncate min-w-0">
              DECENTRALIZED SOCIAL
            </span>
          </button>
          </div>
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
            isDrawerOpen={drawerOpen}
            onCloseDrawer={closeDrawer}
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
            <>
            {/* The way back. Inside the host container Plaza is an iframe under the dot.li shell,
                so there is no address bar and no browser Back within reach — an in-app control is
                the ONLY exit. Shares `PANE_HEADER` with the forum's two panes so the row is the
                same height and its border the same rule. */}
            <div className={PANE_HEADER}>
              <button
                type="button"
                onClick={handleProfileBack}
                className="text-sm font-mono text-primary-500 hover:text-primary-400 whitespace-nowrap transition-colors"
              >
                &larr; {backLabel}
              </button>
            </div>
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
              // ⚠️ NOT `host.canWrite`. That is POSTING ability and says nothing about funds — it
              // showed a tip control to everyone who could post, including sessions with no way to
              // pay at all. What makes a tip possible is a CASH payment seam.
              canTip={!!host.backend?.payments}
              onConnectWallet={() => setShowHostNotice(true)}
              selectedPostFromUrl={selectedPost}
              onPostChange={setSelectedPost}
            />
            </>
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
              selectedThreadCid={selectedThreadCid}
              legacyThreadIndex={legacyThreadIndex}
              onThreadChange={selectThread}
              onThreadTitleChange={setCurrentThreadTitle}
              getProfile={userRegistry.getProfile}
              onFollow={followRegistry.follow}
              onUnfollow={followRegistry.unfollow}
              isFollowing={followRegistry.isFollowingSync}
              onTip={setTipTargetAddress}
              // ⚠️ NOT `host.canWrite`. That is POSTING ability and says nothing about funds — it
              // showed a tip control to everyone who could post, including sessions with no way to
              // pay at all. What makes a tip possible is a CASH payment seam.
              canTip={!!host.backend?.payments}
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
              /**
               * ⚠️ THE ONLY THING THAT LETS SETTINGS SAY "AUTHORISED" TRUTHFULLY.
               *
               * Without it the screen can never reach its confirmed outcome and falls back to a
               * neutral "sent, check the line above" — because the seam resolving is NOT evidence
               * the chain agrees. `confirmDelegate` polls `delegateExpiry`, which is the same
               * poll-until-visible rule every host-signed write in this app obeys.
               *
               * ⚠️ CORRECTED 2026-07-31 — HALF OF THE OLD REASON IS DEAD, THE OTHER HALF IS NOT.
               * This used to say the poll was needed because "we read through a separate public RPC
               * that trails" the host. That reader is gone: reads and writes now share one chain
               * client and `.query()` defaults to `at: "best"`, deliberately so reads observe the
               * same state `.tx()` resolved against. What survives, and is enough on its own, is
               * that a host-submitted call emits `Revive.ContractEmitted` into `System.Events` and
               * NOTHING into the ETH log index — so `eth_getLogs` cannot see it and there is no
               * receipt to await. Poll the view function. See gotchas.md.
               */
              onConfirmDelegate={(address) => userRegistry.confirmDelegate(address, 'authorised')}
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
          // Tips are paid in CASH by the host, from the USER's balance. The delegate key is not on
          // this path — it is never funded, which is why every tip used to fail with "Insufficient
          // balance in selected wallet". The `sessionWallet*` props are gone with it.
          payments={host.backend?.payments ?? null}
          onConnectWallet={() => setShowHostNotice(true)}
        />
      )}

      </div>
    </PaymentsProvider>
    </PublisherProvider>
  );
}

export default App;
