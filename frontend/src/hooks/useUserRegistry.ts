import { useState, useCallback, useEffect } from "react";
import { ethers } from "ethers";
import type { Profile, Link } from "../types/contracts";
import UserRegistryABI from "../contracts/UserRegistry.json";
import { createReadContract, type Provider, type Signer } from "../utils/contracts";
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
  resolveToOwner: (address: string) => Promise<string>;
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
      return hostWrite(
        registryAddress,
        UserRegistryABI.abi as unknown as Record<string, unknown>[],
        method,
        args,
        method,
      );
    },
    [enabled, registryAddress, hostWrite]
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

      const profileData = await contract.getProfile(userAddress);
      setProfile({
        owner: profileData.owner,
        displayName: profileData.displayName,
        bio: profileData.bio,
        exists: profileData.exists,
      });

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
  }, [userAddress, getReadContract]);

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

  const resolveToOwner = useCallback(
    async (address: string): Promise<string> => {
      const contract = getReadContract();
      if (!contract) return ethers.ZeroAddress;

      return contract.resolveToOwner(address);
    },
    [getReadContract]
  );

  const getProfileFn = useCallback(
    async (address: string): Promise<Profile> => {
      const contract = getReadContract();
      if (!contract) throw new Error("Contract not available");

      const p = await contract.getProfile(address);
      return {
        owner: p.owner,
        displayName: p.displayName,
        bio: p.bio,
        exists: p.exists,
      };
    },
    [getReadContract]
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

  const hasProfile = useCallback(
    async (address: string): Promise<boolean> => {
      const contract = getReadContract();
      if (!contract) return false;

      return contract.hasProfile(address);
    },
    [getReadContract]
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
    resolveToOwner,
    getProfile: getProfileFn,
    getLinks: getLinksFn,
    hasProfile,
    refresh: loadProfile,
  };
}
