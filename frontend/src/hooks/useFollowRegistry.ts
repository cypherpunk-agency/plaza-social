import { useState, useCallback, useEffect } from "react";
import FollowRegistryABI from "../contracts/FollowRegistry.json";
import { createReadContract, type Provider, type Signer } from "../utils/contracts";
import { useHostWrite } from "./usePublisher";

/**
 * ⭐ FOLLOW AND UNFOLLOW ARE HOST-SIGNED NOW, 2026-07-31. ONE PROMPT EACH.
 *
 * They used to go out through `signer` — the delegate arm — which could never work: the delegate
 * H160 is unfunded (`code 1012`, **[V]** 2026-07-30), and this hook called `follow(…)`, which
 * records `msg.sender`, so even a funded delegate would have built a follow graph belonging to a
 * throwaway per-device key. See `lib/host/types.ts` `SignerSeam`.
 *
 * ⭐ `follow(…)` IS THE RIGHT FUNCTION under host signing — `msg.sender` IS the user.
 * `followFor(follower, …)` is the delegate's form; ⛔ do not switch to it while writes are
 * host-signed.
 */

interface UseFollowRegistryProps {
  registryAddress: string | null;
  provider: Provider | null;
  userAddress: string | null;
  /**
   * @deprecated ⛔ IGNORED, and always `null`. The delegate arm is gone (see above). Kept because
   * the components that mount this hook declare the prop and pass it down.
   */
  signer?: Signer | null;
  /**
   * The host-signed writer. ⚠️ REQUIRED IN PRACTICE FOR THIS HOOK, unlike `useVoting`.
   *
   * `useVoting` is mounted by components that sit INSIDE `PublisherProvider`, so `useHostWrite()`
   * finds it. This hook is mounted by `App` itself, which RENDERS that provider and is therefore
   * above it — context would be `null` there and every follow would refuse. The prop wins; context
   * is the fallback for any future caller that does sit inside.
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

interface UseFollowRegistryReturn {
  // State
  following: string[];
  followers: string[];
  followingCount: number;
  followerCount: number;
  isLoading: boolean;
  error: string | null;

  // Actions
  follow: (address: string) => Promise<void>;
  unfollow: (address: string) => Promise<void>;
  isFollowing: (address: string) => Promise<boolean>;
  isFollowingSync: (address: string) => boolean;

  // Refresh
  refresh: () => Promise<void>;
}

export function useFollowRegistry({
  registryAddress,
  provider,
  userAddress,
  hostWrite: hostWriteProp,
  enabled = true,
}: UseFollowRegistryProps): UseFollowRegistryReturn {
  const [following, setFollowing] = useState<string[]>([]);
  const [followers, setFollowers] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getReadContract = useCallback(() => {
    return createReadContract(
      registryAddress,
      FollowRegistryABI.abi,
      provider
    );
  }, [registryAddress, provider]);

  // Prop first, context second — see `hostWrite` on the props above for why the prop is the one
  // that actually fires here.
  const contextWrite = useHostWrite();
  const hostWrite = hostWriteProp ?? contextWrite;

  /**
   * ⚠️ NO `tx.wait()`, AND THERE CANNOT BE ONE: `writeContract` hands back a SUBSTRATE EXTRINSIC
   * HASH, already watched to best-block by the host, with no Ethereum receipt to await. The
   * `loadFollowData()` that follows each call is what confirms the change — and it is a real read,
   * not decoration, because the host settles at best-block and `eth_getLogs` cannot see its calls
   * at all (architecture §8).
   */
  const submit = useCallback(
    async (method: string, address: string) => {
      if (!registryAddress) throw new Error("Contract not available");
      if (!hostWrite) {
        throw new Error(
          "Following has to be signed by your Polkadot account, and this session cannot reach it. " +
            "Open Plaza inside the Polkadot app and try again.",
        );
      }
      await hostWrite(
        registryAddress,
        FollowRegistryABI.abi as unknown as Record<string, unknown>[],
        method,
        [address],
        method,
      );
    },
    [registryAddress, hostWrite]
  );

  const loadFollowData = useCallback(async () => {
    if (!userAddress) {
      setFollowing([]);
      setFollowers([]);
      return;
    }

    const contract = getReadContract();
    if (!contract) return;

    try {
      setIsLoading(true);
      setError(null);

      const [followingList, followersList] = await Promise.all([
        contract.getFollowing(userAddress),
        contract.getFollowers(userAddress),
      ]);

      // Convert to plain arrays (ethers returns array-like objects)
      setFollowing([...followingList]);
      setFollowers([...followersList]);
    } catch (err) {
      console.error("Failed to load follow data:", err);
      setError(
        err instanceof Error ? err.message : "Failed to load follow data"
      );
    } finally {
      setIsLoading(false);
    }
  }, [userAddress, getReadContract]);

  useEffect(() => {
    if (enabled && registryAddress) {
      loadFollowData();
    }
  }, [enabled, userAddress, registryAddress, provider, loadFollowData]);

  const follow = useCallback(
    async (address: string): Promise<void> => {
      if (!enabled) throw new Error("Not enabled");

      // Optimistic update
      setFollowing((prev) => [...prev, address]);

      try {
        await submit("follow", address);
        // Refresh from chain to ensure consistency
        await loadFollowData();
      } catch (err) {
        // Revert optimistic update on error
        setFollowing((prev) => prev.filter((a) => a.toLowerCase() !== address.toLowerCase()));
        throw err;
      }
    },
    [enabled, submit, loadFollowData]
  );

  const unfollow = useCallback(
    async (address: string): Promise<void> => {
      if (!enabled) throw new Error("Not enabled");

      // Optimistic update
      const previousFollowing = [...following];
      setFollowing((prev) => prev.filter((a) => a.toLowerCase() !== address.toLowerCase()));

      try {
        await submit("unfollow", address);
        // Refresh from chain to ensure consistency
        await loadFollowData();
      } catch (err) {
        // Revert optimistic update on error
        setFollowing(previousFollowing);
        throw err;
      }
    },
    [enabled, submit, loadFollowData, following]
  );

  const isFollowingCheck = useCallback(
    async (address: string): Promise<boolean> => {
      if (!userAddress) return false;
      const contract = getReadContract();
      if (!contract) return false;

      return contract.isFollowing(userAddress, address);
    },
    [userAddress, getReadContract]
  );

  // Synchronous check against local state
  const isFollowingSync = useCallback(
    (address: string): boolean => {
      return following.some(
        (addr) => addr.toLowerCase() === address.toLowerCase()
      );
    },
    [following]
  );

  return {
    following,
    followers,
    followingCount: following.length,
    followerCount: followers.length,
    isLoading,
    error,
    follow,
    unfollow,
    isFollowing: isFollowingCheck,
    isFollowingSync,
    refresh: loadFollowData,
  };
}
