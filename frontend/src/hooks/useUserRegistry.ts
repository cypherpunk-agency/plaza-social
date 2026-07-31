import { useState, useCallback, useEffect, useMemo } from "react";
import type { Profile, Link } from "../types/contracts";
import UserRegistryABI from "../contracts/UserRegistry.json";
import { createReadContract, type Provider, type Signer } from "../utils/contracts";
import { createBatchLoader, decodeProfiles } from "../lib/batch";
import { useHostWrite } from "./usePublisher";

interface UseUserRegistryProps {
  registryAddress: string | null;
  provider: Provider | null;
  /** @deprecated ⛔ IGNORED. There is no separate write provider; there is no browser wallet. */
  writeProvider?: Provider | null;
  userAddress: string | null;
  /** @deprecated ⛔ IGNORED, and always `null`. See the note above the hook. */
  signer?: Signer | null;
  /** @deprecated ⛔ IGNORED, and always `null`. See the note above the hook. */
  delegateSigner?: Signer | null;
  /**
   * ⭐ THE ONLY WRITE PATH. Host-signed, one prompt per call.
   *
   * `createProfile` records `msg.sender` as the owner, so signing it with the delegate would create a
   * profile owned by a throwaway per-device key. The delegate is also unfunded, which surfaced as
   * `code 1012 "Transaction is temporarily banned"` — the node rejects the unpayable transaction and
   * the txpool then bans its hash, which reads like a mysterious ban rather than "no money".
   *
   * ⚠️ There is a CONTEXT fallback (`useHostWrite()`) for a future caller mounted inside
   * `PublisherProvider`. Today the only caller is `App`, which sits ABOVE that provider and must
   * therefore pass the prop — the prop wins whenever both exist.
   */
  hostWrite?: HostWrite | null;
  enabled?: boolean;
}

/**
 * How long a profile read stays fresh.
 *
 * ⚠️ BOUNDED ON PURPOSE. A cache with no expiry means a user who renames themselves keeps their old
 * name on everybody else's screen until the tab is reloaded — a bug that would look like the write
 * having failed. Sixty seconds is two poll periods, so a rename shows up within about a minute
 * without asking; the user's OWN writes do not wait for it at all, because every write in this hook
 * invalidates the cache immediately (see `submit`).
 *
 * ⚠️ SHORT IS CHEAP NOW, AND THAT IS THE POINT. Expiring the whole board's names costs ONE
 * `getProfiles` call on the next poll, not fifty `getProfile` calls, so freshness is no longer
 * traded against read count.
 */
const PROFILE_CACHE_TTL_MS = 60_000;

/**
 * Addresses per `getProfiles` call.
 *
 * The board reads 50 heads, so 50 covers a full page in one call. A longer queue is split into
 * several calls rather than sent as one — an unbounded array argument is a revert waiting for the
 * day somebody follows two hundred people.
 */
const PROFILE_BATCH_MAX = 50;

/** See `lib/host/types.ts` — `HostBackend.writeContract`. */
type HostWrite = (
  address: string,
  abi: Record<string, unknown>[],
  method: string,
  args: unknown[],
  label: string,
) => Promise<{ txHash: string }>;

interface UseUserRegistryReturn {
  // State
  profile: Profile | null;
  links: Link[];
  isLoading: boolean;
  error: string | null;

  // Profile actions
  createProfile: (displayName: string, bio: string) => Promise<void>;
  createDefaultProfile: () => Promise<void>;
  updateDisplayName: (displayName: string) => Promise<void>;
  updateBio: (bio: string) => Promise<void>;
  transferProfileOwnership: (newOwner: string) => Promise<void>;

  // Link actions
  addLink: (name: string, url: string) => Promise<void>;
  removeLink: (index: number) => Promise<void>;
  clearLinks: () => Promise<void>;

  // Delegate actions.
  //
  // ⚠️ `addDelegate` / `removeDelegate` USED TO BE HERE AND CALLED FUNCTIONS THE CONTRACT DOES NOT
  // HAVE. `UserRegistry` exposes `authorizeDelegate(address,uint64)` and `revokeDelegate(address)`;
  // there has never been an `addDelegate`. They also went out through `getWriteContract`, i.e. the
  // delegate arm, for an OWNER-ONLY call. Both are the failure mode `frontend/CLAUDE.md` calls "a
  // call naming a function the target does not have" — it would have surfaced as `require(false)`
  // and read as a contract rejecting the user. Nothing imported them, so nothing broke; they are
  // replaced rather than fixed in place.
  /**
   * Authorise `delegateAddress` until `expiryUnixSeconds`, host-signed, then POLL until the chain
   * agrees. Resolves to the confirmed expiry in epoch **milliseconds**, or `null` when the reader
   * never saw it — which the caller must treat as "not authorised", never as success.
   */
  authorizeDelegate: (delegateAddress: string, expiryUnixSeconds: number) => Promise<number | null>;
  /** Revoke, host-signed, then poll until the chain shows it gone. `null` means confirmed revoked. */
  revokeDelegate: (delegateAddress: string) => Promise<number | null>;
  /** One read. Live expiry in epoch ms, or `null` for absent/expired. */
  delegateExpiry: (delegateAddress: string) => Promise<number | null>;
  /** Poll until the chain shows the expected state, or give up. Never throws. */
  confirmDelegate: (
    delegateAddress: string,
    expect: "authorised" | "revoked",
  ) => Promise<number | null>;
  /** `MAX_DELEGATION_SECONDS`, read rather than assumed — the contract REVERTS above it. */
  maxDelegationSeconds: () => Promise<number | null>;
  isDelegate: (delegateAddress: string) => Promise<boolean>;

  // Lookup

  getProfile: (address: string) => Promise<Profile>;
  getLinks: (address: string) => Promise<Link[]>;
  hasProfile: (address: string) => Promise<boolean>;

  // Refresh
  refresh: () => Promise<void>;
}

/**
 * (See the props above.) EVERY WRITE IN THIS HOOK IS HOST-SIGNED, 2026-07-31 — one prompt per call.
 *
 * `createDefaultProfile`, `setDisplayName`, `setBio`, `transferProfileOwnership`, `addLink`,
 * `removeLink` and `clearLinks` used to go out through `signer` / `delegateSigner` and could never
 * have worked: the delegate H160 is unfunded (`code 1012`, [V] 2026-07-30), and the first four are
 * `onlyProfileOwner` / `msg.sender`-keyed anyway, so a delegate-signed call would have edited a
 * profile owned by the throwaway key. See `lib/host/types.ts` `SignerSeam`.
 */
export function useUserRegistry({
  registryAddress,
  provider,
  userAddress,
  hostWrite: hostWriteProp,
  enabled = true,
}: UseUserRegistryProps): UseUserRegistryReturn {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [links, setLinks] = useState<Link[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getReadContract = useCallback(() => {
    return createReadContract(registryAddress, UserRegistryABI.abi, provider);
  }, [registryAddress, provider]);

  /**
   * ⭐ EVERY PROFILE READ IN THE APP GOES THROUGH ONE BATCHED, SHORT-LIVED CACHE.
   *
   * `getProfile` is the single most-called read here: the forum decorates every row with its
   * author's display name, replies do the same, the sidebar does it once per followee, and the
   * hover tooltip does it again. Before this it was literally one `getProfile(address)` per item,
   * per 30-second poll, with no memory between polls and no de-duplication even when the same
   * person wrote five of the fifty rows.
   *
   * ⚠️ THE FUNCTION VERIFIED AGAINST THE ABI IS `getProfiles(address[]) -> Profile[] result`
   * (`contracts/UserRegistry.json`, and `contracts/UserRegistry.sol:435`). One output, so
   * `normaliseCallResult` passes the decoded `tuple[]` through untouched and each entry arrives
   * with named fields.
   *
   * ⚠️ `exists: false` IS AN ANSWER, NOT AN ABSENCE. The contract returns a zeroed struct for an
   * address that never made a profile, exactly as single `getProfile` did, and that resolves and is
   * cached like any other value. Only a slot the batch did not return at all is treated as absent —
   * see `alignBatch`.
   */
  const profiles = useMemo(
    () =>
      createBatchLoader<string, Profile>({
        // Addresses reach us in mixed case (chain attribution vs. what an object claims), and two
        // spellings of one address must not be two cache entries or two batch slots.
        keyOf: (address) => address.toLowerCase(),
        ttlMs: PROFILE_CACHE_TTL_MS,
        maxBatch: PROFILE_BATCH_MAX,
        missingMessage: (address) =>
          `UserRegistry.getProfiles returned no entry for ${address}`,
        fetch: async (owners) => {
          const contract = getReadContract();
          // Same words the single read used, and the same meaning: no address or no reader. ⚠️ This
          // rejects EVERY key in the batch, which is what the per-item loop did when there was no
          // contract — each of its calls threw the same thing.
          if (!contract) throw new Error("Contract not available");
          // Decoded by `lib/batch.ts`, where the shape is pinned by `npm run test:lib`.
          return decodeProfiles(await contract.getProfiles(owners), owners.length);
        },
      }),
    [getReadContract],
  );

  // Prop first, context second. ⚠️ TODAY ONLY THE PROP FIRES: the sole caller is `App`, which
  // renders `PublisherProvider` and is therefore above `HostWriteContext`. The fallback is for a
  // caller mounted inside it — do not delete the prop on the assumption that context will cover.
  const contextWrite = useHostWrite();
  const hostWrite = hostWriteProp ?? contextWrite;

  /**
   * The ONE write path. Host-signed, one prompt each.
   *
   * NO `tx.wait()`, AND THERE CANNOT BE ONE: `writeContract` returns a SUBSTRATE EXTRINSIC HASH,
   * already watched to best-block by the host, with no Ethereum receipt to await
   * (`lib/host/contracts.ts`). Callers re-read instead — `loadProfile()` for the cheap cases and
   * `waitForProfile()` / `confirmDelegate()` where a stale read would be misreported as failure.
   */
  const submit = useCallback(
    async (method: string, args: unknown[]) => {
      if (!enabled) throw new Error("Wallet not ready");
      if (!registryAddress) throw new Error("Contract not available");
      if (!hostWrite) {
        throw new Error(
          "Changing your profile has to be signed by your Polkadot account, and this session " +
            "cannot reach it. Open Plaza inside the Polkadot app and try again.",
        );
      }
      const result = await hostWrite(
        registryAddress,
        UserRegistryABI.abi as unknown as Record<string, unknown>[],
        method,
        args,
        method,
      );

      /**
       * ⭐ THE CACHE'S EXPLICIT INVALIDATION, AND IT IS DELIBERATELY UNCONDITIONAL.
       *
       * Every write reachable from here is submitted AS the user (host-signed, so `msg.sender` is
       * them), and the ones that change what a name resolves to — `createProfile`,
       * `createDefaultProfile`, `setDisplayName`, `setBio`, `transferProfileOwnership` — are the
       * common ones. The delegation calls do not touch the `Profile` struct, but invalidating one
       * map entry costs nothing and a per-method allowlist is a thing that goes stale silently the
       * next time a method is added. ⛔ Do not "optimise" this into a switch.
       *
       * Without it, `ProfileView` re-reads right after an edit (`getProfile(userAddress)` on
       * line ~232) and would be served the pre-edit name from cache — the edit would look like it
       * had silently failed.
       */
      if (userAddress) profiles.invalidate(userAddress);
      return result;
    },
    [enabled, registryAddress, hostWrite, profiles, userAddress]
  );

  const loadProfile = useCallback(async () => {
    if (!userAddress) {
      setProfile(null);
      setLinks([]);
      return;
    }

    const contract = getReadContract();
    if (!contract) return;

    try {
      setIsLoading(true);
      setError(null);

      // ⚠️ THE SINGLE `getProfile`, ON PURPOSE, AND IT MUST BYPASS THE CACHE. This is the
      // read-after-write path for the user's own profile: routing it through `profiles.load` would
      // let a value written moments ago be answered from the cache the write just invalidated and
      // some other row re-populated. One address, one read — there is nothing to batch here anyway.
      const profileData = await contract.getProfile(userAddress);
      const own: Profile = {
        owner: profileData.owner,
        displayName: profileData.displayName,
        bio: profileData.bio,
        exists: profileData.exists,
      };
      setProfile(own);
      // …but the value is fresh and came from the same chain read, so hand it to the cache. Every
      // `getDisplayName(me)` on the board is then free. See `BatchLoader.prime`.
      profiles.prime(userAddress, own);

      if (profileData.exists) {
        const linksData = await contract.getLinks(userAddress);
        setLinks(
          linksData.map((l: { name: string; url: string }) => ({
            name: l.name,
            url: l.url,
          }))
        );
      } else {
        setLinks([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load profile");
    } finally {
      setIsLoading(false);
    }
  }, [userAddress, getReadContract, profiles]);

  useEffect(() => {
    if (enabled) {
      loadProfile();
    }
  }, [enabled, userAddress, registryAddress, provider, loadProfile]);

  /**
   * Re-read the profile until it reports `exists`, or give up.
   *
   * Giving up is NOT an error: the write already succeeded, and the reader may simply be further
   * behind than we are willing to wait. The next natural refresh will pick it up — so this resolves
   * either way and never throws.
   */
  const waitForProfile = useCallback(
    async (timeoutMs = 30_000, intervalMs = 1_500) => {
      const contract = getReadContract();
      const deadline = Date.now() + timeoutMs;
      while (contract && Date.now() < deadline) {
        try {
          const data = await contract.getProfile(userAddress);
          if (data?.exists) break;
        } catch {
          /* a transient read failure is not a reason to stop waiting */
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      await loadProfile();
    },
    [getReadContract, userAddress, loadProfile]
  );

  const createProfile = useCallback(
    async (displayName: string, bio: string) => {
      // OWNER-ONLY, and `submit` is host-signed, so `msg.sender` is the user. (`submit` already
      // refuses when there is no address or no writer — one guard, in one place.)
      await submit("createProfile", [displayName, bio]);

      /**
       * ⚠️ POLL UNTIL THE PROFILE IS VISIBLE. One read here is not enough and the failure is silent.
       *
       * The write is submitted by the HOST and settles at best-block, but we read through a SEPARATE
       * public RPC. That reader can trail the block the host just saw, so an immediate `getProfile`
       * returns `exists: false` — the profile is created, the UI believes it is not, and the
       * "set up your profile" banner stays up over a profile that plainly exists. Observed
       * 2026-07-30. Events are no help: `eth_getLogs` cannot see host-submitted contract calls at
       * all (architecture §8), so polling the view function is the correct mechanism, not a
       * workaround.
       */
      await waitForProfile();
    },
    [submit, waitForProfile]
  );

  const createDefaultProfile = useCallback(async () => {
    await submit("createDefaultProfile", []);
    // Same reason as `createProfile`: one immediate read can trail the block the host just saw.
    await waitForProfile();
  }, [submit, waitForProfile]);

  const transferProfileOwnership = useCallback(
    async (newOwner: string) => {
      await submit("transferProfileOwnership", [newOwner]);
      // After transfer, the current user no longer has a profile
      setProfile(null);
      setLinks([]);
    },
    [submit]
  );

  const updateDisplayName = useCallback(
    async (displayName: string) => {
      await submit("setDisplayName", [displayName]);
      await loadProfile();
    },
    [submit, loadProfile]
  );

  const updateBio = useCallback(
    async (bio: string) => {
      await submit("setBio", [bio]);
      await loadProfile();
    },
    [submit, loadProfile]
  );

  /**
   * THE LINK CALLS NAME THEIR PRINCIPAL, AND THEY ALWAYS DID.
   *
   * The contract is `addLink(address owner, string, string)`, `removeLink(address, uint256)` and
   * `clearLinks(address)` — every one NAMES its principal, because that is the shape a delegated
   * call has to have (`_requireCanActAs(owner)`; there is no reverse lookup from a delegate to an
   * owner). This hook was calling `addLink(name, url)`: two arguments to a three-argument function,
   * which cannot even be encoded. Same class as the four in `frontend/CLAUDE.md`'s table, and it was
   * hidden because the delegate signer was `null`, so "Contract not available" fired first and
   * nobody ever reached the real error.
   *
   * `_requireCanActAs(owner)` accepts the owner themselves and the host submits AS the owner, so
   * passing `userAddress` is exactly right.
   */
  const requireUser = useCallback(() => {
    if (!userAddress) throw new Error("No account — sign in to the Polkadot app to edit your links.");
    return userAddress;
  }, [userAddress]);

  const addLink = useCallback(
    async (name: string, url: string) => {
      await submit("addLink", [requireUser(), name, url]);
      await loadProfile();
    },
    [submit, requireUser, loadProfile]
  );

  const removeLink = useCallback(
    async (index: number) => {
      await submit("removeLink", [requireUser(), BigInt(index)]);
      await loadProfile();
    },
    [submit, requireUser, loadProfile]
  );

  const clearLinks = useCallback(async () => {
    await submit("clearLinks", [requireUser()]);
    await loadProfile();
  }, [submit, requireUser, loadProfile]);

  /* ------------------------------------------------------------------ delegation - */

  /**
   * What the contract records for `(user, delegate)` right now, in epoch **milliseconds**, or `null`
   * when there is no live authorisation.
   *
   * ⚠️ `delegateExpiry`, NOT `isDelegate`. `isDelegate` collapses "never authorised" and "authorised
   * but expired" into the same `false`, and the posting-key panel says different sentences for those
   * two ("your next post will set it up" vs "…will renew it"). The contract's own NatSpec says the
   * same thing: read `delegateExpiry` when you need to know *when*, `isDelegate` for *whether*.
   *
   * ⚠️ THE CONTRACT STORES UNIX SECONDS; everything above the hook boundary is milliseconds
   * (`frontend/CLAUDE.md` § timestamps — the mismatch that once rendered a post as 58548-06-08).
   * Converted here, once.
   */
  const delegateExpiry = useCallback(
    async (delegateAddress: string): Promise<number | null> => {
      if (!userAddress) return null;
      const contract = getReadContract();
      if (!contract) return null;

      const seconds = await contract.delegateExpiry(userAddress, delegateAddress);
      const ms = Number(seconds) * 1000;
      return Number.isFinite(ms) && ms > Date.now() ? ms : null;
    },
    [getReadContract, userAddress]
  );

  /**
   * ⚠️ POLL UNTIL THE CHAIN AGREES. Same rule, and the same reason, as `waitForProfile` above.
   *
   * ⚠️ CORRECTED 2026-07-31: this used to blame "a SEPARATE public RPC that can trail" the host. That
   * reader no longer exists — reads and writes share one chain client and `.query()` targets `best`
   * on purpose. The reason that survives is the one that never depended on it: `eth_getLogs` cannot
   * see host-submitted contract calls at all (architecture §8), and a native extrinsic gives no
   * receipt to await, so `DelegateAuthorized` is no help and polling the view function is the
   * correct mechanism rather than a workaround. A write can also still be in flight when we look.
   *
   * Returns the LAST OBSERVED expiry — so a caller can distinguish "confirmed authorised" (a number)
   * from "we never saw it" (`null`). Giving up is not an error and this never throws, but ⛔ `null`
   * must never be reported to the user as success: not seeing it is exactly the case in which the
   * write silently did nothing.
   */
  const confirmDelegate = useCallback(
    async (
      delegateAddress: string,
      expect: "authorised" | "revoked",
      timeoutMs = 30_000,
      intervalMs = 1_500
    ): Promise<number | null> => {
      const deadline = Date.now() + timeoutMs;
      let observed: number | null = null;
      for (;;) {
        try {
          observed = await delegateExpiry(delegateAddress);
          const matches = expect === "authorised" ? observed !== null : observed === null;
          if (matches) return observed;
        } catch {
          /* a transient read failure is not a reason to stop waiting */
        }
        if (Date.now() >= deadline) return observed;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    },
    [delegateExpiry]
  );

  /**
   * ⚠️ OWNER-ONLY — MUST be host-signed, for both of the reasons in `gotchas.md` § "Host-signed
   * contract writes". The contract keys the delegation on `msg.sender`, so a delegate-signed call
   * would authorise a delegate *for the delegate*; and the delegate is an H160 nobody funds
   * (balance 0.0, nonce 0, [V] 2026-07-30), which produces `code 1012 "Transaction is temporarily
   * banned"` rather than anything legible.
   *
   * ⚠️ `expiryUnixSeconds` IS AN ABSOLUTE TIMESTAMP, not a duration. `lib/host/delegate.ts` hands
   * its injected `authorizeOnChain` a DURATION in seconds, so a caller bridging the two must add
   * `Math.floor(Date.now() / 1000)`. Passing a duration would be a timestamp in 1970 and revert with
   * `ExpiryInPast`; passing more than `MAX_DELEGATION_SECONDS` ahead reverts with `ExpiryTooFar`.
   * `0` is not an error — the contract treats it as a revoke.
   */
  const authorizeDelegate = useCallback(
    async (delegateAddress: string, expiryUnixSeconds: number): Promise<number | null> => {
      await submit("authorizeDelegate", [delegateAddress, BigInt(Math.floor(expiryUnixSeconds))]);
      return confirmDelegate(delegateAddress, "authorised");
    },
    [submit, confirmDelegate]
  );

  /** Owner-only for the same reasons, and `revokeDelegate` is idempotent on chain. */
  const revokeDelegate = useCallback(
    async (delegateAddress: string): Promise<number | null> => {
      await submit("revokeDelegate", [delegateAddress]);
      return confirmDelegate(delegateAddress, "revoked");
    },
    [submit, confirmDelegate]
  );

  /**
   * Read rather than assume: `authorizeDelegate` REVERTS above the maximum instead of clamping, and
   * asking for exactly the maximum has already been measured reverting with `ExpiryTooFar` — see
   * `lib/host/delegate.ts` § CLOCK_SKEW_SLACK_SECONDS, which is what subtracts the slack.
   */
  const maxDelegationSeconds = useCallback(async (): Promise<number | null> => {
    const contract = getReadContract();
    if (!contract) return null;
    const value = await contract.MAX_DELEGATION_SECONDS();
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }, [getReadContract]);

  const isDelegate = useCallback(
    async (delegateAddress: string): Promise<boolean> => {
      if (!userAddress) return false;
      const contract = getReadContract();
      if (!contract) return false;

      return contract.isDelegate(userAddress, delegateAddress);
    },
    [getReadContract, userAddress]
  );

/**
 * ⛔ `resolveToOwner` WAS DELETED HERE, 2026-07-31, AND MUST NOT COME BACK AS A CONTRACT CALL.
 *
 * It called `contract.resolveToOwner(address)`, which exists in **neither `UserRegistry.json` nor
 * `UserRegistry.sol`** — the sixth instance of this repo's most repeated bug, after `getEntityId`,
 * `getThreadCount`, `getUserPostCount`, `addReply`, and the `addLink` arity mismatch. It had zero
 * consumers, so it had never been called and never failed.
 *
 * ⚠️ AND THE SEMANTICS IT IMPLIED CANNOT EXIST. "Resolve a delegate back to its owner" is a REVERSE
 * lookup, and architecture.md rules it out on purpose: a delegate address is only unique *per owner*,
 * so there is nothing to resolve to and a guess would misattribute a post to the wrong person. That
 * is why every delegated call NAMES its principal — `setHeadFor`, `followFor`, `voteFor` — and the
 * callee checks `canActAs`. If you need an owner, take it as an argument; do not look it up.
 */
  /**
   * ⭐ THE ONE PROFILE READ EVERYTHING ELSE USES — batched and cached, same signature as before.
   *
   * Callers still ask for one address; `profiles` turns the whole tick's worth of asks into a single
   * `getProfiles`. Nothing above this line had to change, which is why the forum, the replies, the
   * sidebar and the hover tooltip all got the reduction without being edited.
   *
   * ⚠️ IT STILL REJECTS. `getDisplayName` in `App.tsx` catches and renders no name, and
   * `ProfileTooltip` / `UserProfileModal` have their own catches. A batch whose call failed rejects
   * every key in it, and a batch that came back missing one entry rejects that key alone — so one
   * unreadable profile can no longer be the reason the other forty-nine rows show nothing.
   */
  const getProfileFn = useCallback(
    async (address: string): Promise<Profile> => profiles.load(address),
    [profiles]
  );

  const getLinksFn = useCallback(
    async (address: string): Promise<Link[]> => {
      const contract = getReadContract();
      if (!contract) return [];

      const linksData = await contract.getLinks(address);
      return linksData.map((l: { name: string; url: string }) => ({
        name: l.name,
        url: l.url,
      }));
    },
    [getReadContract]
  );

  /**
   * ⚠️ SERVED FROM THE SAME BATCH, not from `UserRegistry.hasProfile`.
   *
   * The contract's `hasProfile(addr)` is literally `profiles[addr].exists`, so asking it separately
   * would be a second read for a field the batched struct already carries. `false` on a failed read
   * is what the old single-call version returned, and is kept: this answer gates a UI affordance,
   * and "we could not tell" has to fall on the side of not claiming a profile exists.
   */
  const hasProfile = useCallback(
    async (address: string): Promise<boolean> => {
      try {
        return (await profiles.load(address)).exists;
      } catch {
        return false;
      }
    },
    [profiles]
  );

  return {
    profile,
    links,
    isLoading,
    error,
    createProfile,
    createDefaultProfile,
    updateDisplayName,
    updateBio,
    transferProfileOwnership,
    addLink,
    removeLink,
    clearLinks,
    authorizeDelegate,
    revokeDelegate,
    delegateExpiry,
    confirmDelegate,
    maxDelegationSeconds,
    isDelegate,

    getProfile: getProfileFn,
    getLinks: getLinksFn,
    hasProfile,
    refresh: loadProfile,
  };
}
