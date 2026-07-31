import { useState, useCallback, useEffect } from "react";
import { ethers } from "ethers";
import type { Profile, Link } from "../types/contracts";
import UserRegistryABI from "../contracts/UserRegistry.json";
import { createReadContract, createWriteContract, type Provider, type Signer } from "../utils/contracts";

interface UseUserRegistryProps {
  registryAddress: string | null;
  provider: Provider | null;
  writeProvider?: Provider | null; // Optional separate provider for write operations (e.g., BrowserProvider for signing)
  userAddress: string | null;
  signer?: Signer | null; // Signer for owner-only operations (profile creation, delegate management)
  delegateSigner?: Signer | null; // Signer for delegate-capable operations (links) - uses session wallet
  /**
   * Host-signed contract write. **Owner-only calls MUST use this, not `signer`.**
   *
   * `createProfile` records `msg.sender` as the owner, so signing it with the delegate would create a
   * profile owned by a throwaway per-device key. The delegate is also unfunded, which surfaced as
   * `code 1012 "Transaction is temporarily banned"` — the node rejects the unpayable transaction and
   * the txpool then bans its hash, which reads like a mysterious ban rather than "no money".
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

export function useUserRegistry({
  registryAddress,
  provider,
  writeProvider,
  userAddress,
  signer,
  delegateSigner,
  hostWrite,
  enabled = true,
}: UseUserRegistryProps): UseUserRegistryReturn {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [links, setLinks] = useState<Link[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getReadContract = useCallback(() => {
    return createReadContract(registryAddress, UserRegistryABI.abi, provider);
  }, [registryAddress, provider]);

  const getWriteContract = useCallback(async () => {
    // Use writeProvider if provided (e.g., BrowserProvider for browser wallet signing)
    // Falls back to regular provider
    const providerToUse = writeProvider ?? provider;
    return createWriteContract(registryAddress, UserRegistryABI.abi, providerToUse, signer ?? null);
  }, [registryAddress, provider, writeProvider, signer]);

  // Write contract for delegate-capable operations (links)
  // Uses delegateSigner if available, otherwise falls back to getWriteContract behavior
  const getDelegateWriteContract = useCallback(async () => {
    if (delegateSigner) {
      // Use delegate signer directly with regular provider
      return createWriteContract(registryAddress, UserRegistryABI.abi, provider, delegateSigner);
    }
    // Fall back to regular write contract (owner signer)
    return getWriteContract();
  }, [registryAddress, provider, delegateSigner, getWriteContract]);

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
      if (!registryAddress) throw new Error("Contract not available");

      // ⚠️ OWNER-ONLY — MUST be host-signed. `createProfile` records `msg.sender` as the owner, so
      // the delegate path would create a profile owned by the per-device key rather than by the user,
      // and the delegate is unfunded besides (that is the `code 1012 "Transaction is temporarily
      // banned"` a user hit: the node rejects an unpayable tx, then the pool bans its hash).
      if (!hostWrite) {
        throw new Error(
          "Creating a profile has to be signed by your Polkadot account, and this session cannot " +
            "reach it. Open Plaza inside the Polkadot app and try again.",
        );
      }

      await hostWrite(
        registryAddress,
        UserRegistryABI.abi as unknown as Record<string, unknown>[],
        "createProfile",
        [displayName, bio],
        "createProfile",
      );

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
    [registryAddress, hostWrite, waitForProfile]
  );

  const createDefaultProfile = useCallback(async () => {
    if (!enabled) throw new Error("Wallet not ready");
    const contract = await getWriteContract();
    if (!contract) throw new Error("Contract not available");

    const tx = await contract.createDefaultProfile();
    await tx.wait();
    await loadProfile();
  }, [enabled, getWriteContract, loadProfile]);

  const transferProfileOwnership = useCallback(
    async (newOwner: string) => {
      if (!enabled) throw new Error("Wallet not ready");
      const contract = await getWriteContract();
      if (!contract) throw new Error("Contract not available");

      const tx = await contract.transferProfileOwnership(newOwner);
      await tx.wait();
      // After transfer, the current user no longer has a profile
      setProfile(null);
      setLinks([]);
    },
    [enabled, getWriteContract]
  );

  const updateDisplayName = useCallback(
    async (displayName: string) => {
      if (!enabled) throw new Error("Wallet not ready");
      const contract = await getWriteContract();
      if (!contract) throw new Error("Contract not available");

      const tx = await contract.setDisplayName(displayName);
      await tx.wait();
      await loadProfile();
    },
    [enabled, getWriteContract, loadProfile]
  );

  const updateBio = useCallback(
    async (bio: string) => {
      if (!enabled) throw new Error("Wallet not ready");
      const contract = await getWriteContract();
      if (!contract) throw new Error("Contract not available");

      const tx = await contract.setBio(bio);
      await tx.wait();
      await loadProfile();
    },
    [enabled, getWriteContract, loadProfile]
  );

  // Link operations use delegate signer (gasless via session wallet)
  const addLink = useCallback(
    async (name: string, url: string) => {
      if (!enabled) throw new Error("Wallet not ready");
      const contract = await getDelegateWriteContract();
      if (!contract) throw new Error("Contract not available");

      const tx = await contract.addLink(name, url);
      await tx.wait();
      await loadProfile();
    },
    [enabled, getDelegateWriteContract, loadProfile]
  );

  const removeLink = useCallback(
    async (index: number) => {
      if (!enabled) throw new Error("Wallet not ready");
      const contract = await getDelegateWriteContract();
      if (!contract) throw new Error("Contract not available");

      const tx = await contract.removeLink(index);
      await tx.wait();
      await loadProfile();
    },
    [enabled, getDelegateWriteContract, loadProfile]
  );

  const clearLinks = useCallback(async () => {
    if (!enabled) throw new Error("Wallet not ready");
    const contract = await getDelegateWriteContract();
    if (!contract) throw new Error("Contract not available");

    const tx = await contract.clearLinks();
    await tx.wait();
    await loadProfile();
  }, [enabled, getDelegateWriteContract, loadProfile]);

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
   * ⚠️ POLL UNTIL THE CHAIN AGREES. Same rule, and the same reason, as `waitForProfile` above: the
   * host submits at best-block while we read through a SEPARATE public RPC that can trail it, so one
   * read straight after the write returns the OLD value and the failure is silent. `eth_getLogs`
   * cannot see host-submitted contract calls at all (architecture §8), so `DelegateAuthorized` is no
   * help and polling the view function is the correct mechanism rather than a workaround.
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
      if (!registryAddress) throw new Error("Contract not available");
      if (!hostWrite) {
        throw new Error(
          "Authorising a posting key has to be signed by your Polkadot account, and this session " +
            "cannot reach it. Open Plaza inside the Polkadot app and try again.",
        );
      }

      await hostWrite(
        registryAddress,
        UserRegistryABI.abi as unknown as Record<string, unknown>[],
        "authorizeDelegate",
        [delegateAddress, BigInt(Math.floor(expiryUnixSeconds))],
        "authorizeDelegate",
      );

      return confirmDelegate(delegateAddress, "authorised");
    },
    [registryAddress, hostWrite, confirmDelegate]
  );

  /** Owner-only for the same reasons, and `revokeDelegate` is idempotent on chain. */
  const revokeDelegate = useCallback(
    async (delegateAddress: string): Promise<number | null> => {
      if (!registryAddress) throw new Error("Contract not available");
      if (!hostWrite) {
        throw new Error(
          "Revoking a posting key has to be signed by your Polkadot account, and this session " +
            "cannot reach it. Open Plaza inside the Polkadot app and try again.",
        );
      }

      await hostWrite(
        registryAddress,
        UserRegistryABI.abi as unknown as Record<string, unknown>[],
        "revokeDelegate",
        [delegateAddress],
        "revokeDelegate",
      );

      return confirmDelegate(delegateAddress, "revoked");
    },
    [registryAddress, hostWrite, confirmDelegate]
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
