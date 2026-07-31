import { useState, useCallback } from "react";
import type { VoteType, VoteTally } from "../types/contracts";
import { VoteType as VoteTypeEnum } from "../types/contracts";
import VotingABI from "../contracts/Voting.json";
import { createReadContract, type Provider, type Signer } from "../utils/contracts";
import { useHostWrite } from "./usePublisher";

/**
 * ⛔ `EntityType` AND `computeEntityId` ARE GONE. DO NOT REINTRODUCE THEM.
 *
 * A votable thing used to be identified POSITIONALLY — `(contract, entityType, index)` — because
 * every type had its own contract and its own array. Those contracts are deleted, and the deployed
 * `Voting` has no `getEntityId`, which showed up on every card as:
 *
 *   Failed to compute entity ID: TypeError: T.getEntityId is not a function
 *
 * The identity is now the **CID**. Derive it with `entityIdOfCid` from `lib/entity.ts` — both
 * derivations are `pure` on the contract, so they are computed locally and cannot fail or cost a
 * round trip. Everything below takes an already-derived `bytes32`.
 */

/**
 * ⭐ VOTES ARE HOST-SIGNED NOW, 2026-07-31. ONE PROMPT PER VOTE, AND THAT IS THE HONEST STATE.
 *
 * They used to go out through `signer` — the delegate arm — which meant pressing UPVOTE did an
 * `ethers` round trip to a third-party public RPC and failed, every time, for two independent
 * reasons: the delegate H160 is unfunded (`code 1012`, **[V]** 2026-07-30) and this hook called
 * `vote(…)`, which credits `msg.sender`, so even a funded delegate would have recorded the throwaway
 * key as the voter. See `lib/host/types.ts` `SignerSeam`.
 *
 * ⭐ AND `vote(…)` IS NOW THE CORRECT FUNCTION, not a leftover. `writeContract` submits as the
 * PRODUCT ACCOUNT, so `msg.sender` IS the user. `voteFor(voter, …)` is the delegate's form and
 * exists for the day a delegate can actually sign; ⛔ do not switch to it while writes are
 * host-signed — it would only add a `canActAs` check that must pass trivially.
 */
interface UseVotingProps {
  votingAddress: string | null;
  provider: Provider | null;
  /**
   * @deprecated ⛔ IGNORED, and always `null`. The delegate arm is gone (see above). Kept because
   * four components declare the prop and pass it down; it is not read here.
   */
  signer?: Signer | null;
  userAddress: string | null;
  enabled?: boolean;
}

interface UseVotingReturn {
  // Actions
  vote: (entityId: string, voteType: VoteType) => Promise<void>;
  removeVote: (entityId: string) => Promise<void>;

  // Queries
  getVoteTally: (entityId: string) => Promise<VoteTally>;
  getUserVote: (entityId: string, voter?: string) => Promise<VoteType>;

  // State
  isVoting: boolean;
  error: string | null;
}

export function useVoting({
  votingAddress,
  provider,
  userAddress,
  enabled = true,
}: UseVotingProps): UseVotingReturn {
  const [isVoting, setIsVoting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** ⭐ The host-signed write arm, out of context rather than a prop. See `usePublisher.tsx`. */
  const hostWrite = useHostWrite();

  const getReadContract = useCallback(() => {
    return createReadContract(votingAddress, VotingABI.abi, provider);
  }, [votingAddress, provider]);

  const getVoteTally = useCallback(
    async (entityId: string): Promise<VoteTally> => {
      const contract = getReadContract();
      if (!contract) {
        return { upvotes: 0, downvotes: 0, score: 0 };
      }

      try {
        const [upvotes, downvotes] = await contract.getTally(entityId);
        const score = await contract.getScore(entityId);
        return {
          upvotes: Number(upvotes),
          downvotes: Number(downvotes),
          score: Number(score),
        };
      } catch (err) {
        console.error("Failed to get vote tally:", err);
        return { upvotes: 0, downvotes: 0, score: 0 };
      }
    },
    [getReadContract]
  );

  const getUserVote = useCallback(
    async (entityId: string, voter?: string): Promise<VoteType> => {
      const contract = getReadContract();
      const voterAddress = voter ?? userAddress;
      if (!contract || !voterAddress) {
        return VoteTypeEnum.None;
      }

      try {
        const voteType = await contract.getUserVote(entityId, voterAddress);
        return Number(voteType) as VoteType;
      } catch (err) {
        console.error("Failed to get user vote:", err);
        return VoteTypeEnum.None;
      }
    },
    [getReadContract, userAddress]
  );

  /**
   * The one write path. ⚠️ NO `tx.wait()` AND THERE CANNOT BE ONE: `writeContract` returns a
   * SUBSTRATE EXTRINSIC HASH, already watched to best-block by the host, and there is no Ethereum
   * receipt to await (`lib/host/contracts.ts`). The tally the UI shows is re-read by the caller.
   */
  const submit = useCallback(
    async (method: string, args: unknown[], failure: string): Promise<void> => {
      if (!enabled) throw new Error("Wallet not ready");
      if (!votingAddress) throw new Error("Contract not available");
      if (!hostWrite) {
        throw new Error(
          "Voting has to be signed by your Polkadot account, and this session cannot reach it. " +
            "Open Plaza inside the Polkadot app and try again.",
        );
      }

      setIsVoting(true);
      setError(null);
      try {
        await hostWrite(
          votingAddress,
          VotingABI.abi as unknown as Record<string, unknown>[],
          method,
          args,
          method,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : failure);
        throw err;
      } finally {
        setIsVoting(false);
      }
    },
    [enabled, votingAddress, hostWrite]
  );

  const vote = useCallback(
    async (entityId: string, voteType: VoteType): Promise<void> => {
      if (voteType === VoteTypeEnum.None) {
        throw new Error("Cannot vote with VoteType.None, use removeVote instead");
      }
      // `vote`, not `voteFor` — the host submits as the product account, so `msg.sender` is the user.
      await submit("vote", [entityId, voteType], "Failed to vote");
    },
    [submit]
  );

  const removeVote = useCallback(
    async (entityId: string): Promise<void> => {
      await submit("removeVote", [entityId], "Failed to remove vote");
    },
    [submit]
  );

  return {
    vote,
    removeVote,
    getVoteTally,
    getUserVote,
    isVoting,
    error,
  };
}
