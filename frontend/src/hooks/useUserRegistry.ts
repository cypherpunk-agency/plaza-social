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

  // Delegate actions
  addDelegate: (delegateAddress: string) => Promise<void>;
  removeDelegate: (delegateAddress: string) => Promise<void>;
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

  const addDelegate = useCallback(
    async (delegateAddress: string) => {
      if (!enabled) throw new Error("Wallet not ready");
      const contract = await getWriteContract();
      if (!contract) throw new Error("Contract not available");

      const tx = await contract.addDelegate(delegateAddress);
      await tx.wait();
    },
    [enabled, getWriteContract]
  );

  const removeDelegate = useCallback(
    async (delegateAddress: string) => {
      if (!enabled) throw new Error("Wallet not ready");
      const contract = await getWriteContract();
      if (!contract) throw new Error("Contract not available");

      const tx = await contract.removeDelegate(delegateAddress);
      await tx.wait();
    },
    [enabled, getWriteContract]
  );

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
    addDelegate,
    removeDelegate,
    isDelegate,
    resolveToOwner,
    getProfile: getProfileFn,
    getLinks: getLinksFn,
    hasProfile,
    refresh: loadProfile,
  };
}
