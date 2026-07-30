import { useState, useEffect } from 'react';

/**
 * Contract addresses for one network, as they appear in `public/deployments.json`.
 *
 * ⚠️ Field names must match that file exactly. Nothing type-checks across the `fetch` boundary, so a
 * renamed field simply reads as `undefined` and every consumer concludes "contract not deployed".
 */
export interface NetworkDeployment {
  network: string;
  chainId: number;
  rpcUrl: string;
  /** Profiles, links, delegation. Pinned as a compile-time constant by the other three. */
  userRegistry: string;
  /**
   * Head pointer per (registry, writer). A room, a board, a thread and a profile feed are all just
   * `bytes32` registry ids inside this ONE contract — there is nothing per-room to deploy, which is
   * why the old per-instance `channelRegistry` / `forumThread` / `userPosts` fields are gone.
   */
  postRegistry?: string;
  voting?: string;
  followRegistry?: string;
  deployedAt: string;
}

interface Deployments {
  [networkName: string]: NetworkDeployment;
}

interface UseDeploymentsReturn {
  deployments: Deployments | null;
  currentNetwork: NetworkDeployment | null;
  isLoading: boolean;
  error: string | null;
}

/**
 * The key to read out of `deployments.json`.
 *
 * ⚠️ THIS LINE IS WHY THE WHOLE APP LOOKED UNDEPLOYED. It was `'polkadot-asset-hub-testnet'`, a
 * network that no longer exists in that file, so `currentNetwork` was **always null**, every address
 * was `undefined`, and every view rendered its "contract not deployed" fallback — including well
 * after the contracts really were deployed. A missing *key* is indistinguishable from a missing
 * *deployment* unless something says so out loud, hence `resolveNetwork` and the `error` below.
 */
const DEFAULT_NETWORK = 'products-devnet';

/**
 * Pick a network without being brittle about its name.
 *
 * Prefers `?network=`, then the expected key, then — if the file describes exactly one network — that
 * one. The last case is deliberate: a single-network file has no ambiguity to resolve, and renaming
 * the key should not be able to blank the app a second time.
 */
function resolveNetwork(
  data: Deployments,
  override: string | null,
): { network: NetworkDeployment | null; note: string | null } {
  if (override) {
    return data[override]
      ? { network: data[override], note: null }
      : { network: null, note: `deployments.json has no network named "${override}"` };
  }
  if (data[DEFAULT_NETWORK]) return { network: data[DEFAULT_NETWORK], note: null };

  const keys = Object.keys(data);
  if (keys.length === 1) {
    return {
      network: data[keys[0]],
      note: `deployments.json has no "${DEFAULT_NETWORK}"; falling back to its only network "${keys[0]}"`,
    };
  }
  return {
    network: null,
    note: `deployments.json has no "${DEFAULT_NETWORK}" (found: ${keys.join(', ') || 'nothing'})`,
  };
}

export function useDeployments(): UseDeploymentsReturn {
  const [deployments, setDeployments] = useState<Deployments | null>(null);
  const [currentNetwork, setCurrentNetwork] = useState<NetworkDeployment | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadDeployments = async () => {
      try {
        // BASE_URL matters: the bundle is served from a Bulletin CID path inside the host's sandboxed
        // iframe, so an absolute '/deployments.json' 404s there with no reachable console.
        const basePath = import.meta.env.BASE_URL || '/';
        const response = await fetch(`${basePath}deployments.json`);
        if (!response.ok) throw new Error(`Failed to load deployments: ${response.status}`);
        const data: Deployments = await response.json();

        const override = new URLSearchParams(window.location.search).get('network');
        const { network, note } = resolveNetwork(data, override);

        setDeployments(data);
        setCurrentNetwork(network);
        if (note) {
          // Loud on purpose — a silently-null network is the exact failure this hook already had.
          console.warn(`[deployments] ${note}`);
          setError(note);
        }
      } catch (err) {
        console.warn('Could not load deployments.json:', err);
        setError(err instanceof Error ? err.message : 'Failed to load deployments');
      } finally {
        setIsLoading(false);
      }
    };

    loadDeployments();
  }, []);

  return { deployments, currentNetwork, isLoading, error };
}
