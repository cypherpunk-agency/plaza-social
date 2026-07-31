import { useState, useCallback, useMemo } from "react";
import type { VoteType, VoteTally } from "../types/contracts";
import { VoteType as VoteTypeEnum } from "../types/contracts";
import VotingABI from "../contracts/Voting.json";
import { createReadContract, type Provider, type Signer } from "../utils/contracts";
import { createBatchLoader, decodeTallies, decodeUserVotes, isBatchEntryMissing } from "../lib/batch";
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
 * Entity ids per batched `Voting` read.
 *
 * A board page is 50 threads and a conversation is capped at 50 replies, so 50 covers the widest
 * screen either produces in one call. A longer queue splits into several calls rather than being
 * sent as one unbounded array.
 */
const VOTE_BATCH_MAX = 50;

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

  /**
   * ⭐ ONE `getTallies` FOR A WHOLE SCREENFUL, INSTEAD OF TWO READS PER CARD.
   *
   * Every `VotingWidget` on the page fires its own `useEffect` on mount, and they all mount in the
   * same commit — so all of their asks land in one tick and the loader turns them into a single
   * call. Fifty threads used to be a hundred reads here; they are one.
   *
   * ⚠️ VERIFIED AGAINST THE ABI: `getTallies(bytes32[] entityIds) -> VoteTally[] result`
   * (`contracts/Voting.json`, `contracts/Voting.sol:193`). One output, so the decoded `tuple[]`
   * reaches us untouched with `upvotes` / `downvotes` named.
   *
   * ⭐ AND `getScore` IS GONE FROM THE READ PATH, WHICH IS THE OTHER HALF OF THE SAVING. The
   * contract's implementation is exactly `int256(tally.upvotes) - int256(tally.downvotes)`
   * (`Voting.sol:180`) — a second round trip to subtract two numbers we already have. Computed here
   * instead. ⛔ If `getScore` ever stops being that subtraction, this has to go back to a read; the
   * tell would be a score that disagrees with the arrows above and below it.
   *
   * ⚠️ NO TTL. A tally changes the moment anybody votes, and this hook is what a vote is submitted
   * through. Batching without caching is the whole intent: fewer calls, never a stale number.
   */
  const tallies = useMemo(
    () =>
      createBatchLoader<string, VoteTally>({
        keyOf: (entityId) => entityId.toLowerCase(),
        maxBatch: VOTE_BATCH_MAX,
        missingMessage: (entityId) => `Voting.getTallies returned no entry for ${entityId}`,
        fetch: async (entityIds) => {
          const contract = getReadContract();
          if (!contract) throw new Error("Contract not available");
          // Decoded by `lib/batch.ts`, where the shape and the derived `score` are pinned by tests.
          return decodeTallies(await contract.getTallies(entityIds), entityIds.length);
        },
      }),
    [getReadContract]
  );

  /**
   * The same trick for "did I vote on this?" — `getUserVotes(bytes32[], address) -> VoteType[]`
   * (`contracts/Voting.json`, `contracts/Voting.sol:214`), one call for the page.
   *
   * ⚠️ REBUILT WHEN THE VOTER CHANGES. The address is baked into the batch call, so a loader built
   * for one account must never answer for another — signing in has to re-read, not re-use.
   * `VoteType.None` is `0`, which is a real answer and not the absent sentinel; only a slot the
   * batch did not return at all is absent.
   */
  const userVotes = useMemo(
    () =>
      createBatchLoader<string, VoteType>({
        keyOf: (entityId) => entityId.toLowerCase(),
        maxBatch: VOTE_BATCH_MAX,
        missingMessage: (entityId) => `Voting.getUserVotes returned no entry for ${entityId}`,
        fetch: async (entityIds) => {
          const contract = getReadContract();
          if (!contract || !userAddress) throw new Error("Contract not available");
          return decodeUserVotes(
            await contract.getUserVotes(entityIds, userAddress),
            entityIds.length
          );
        },
      }),
    [getReadContract, userAddress]
  );

  /**
   * ⚠️ THE ZEROES ON FAILURE ARE UNCHANGED, AND THEY ARE NOT A "MISSING MEANS 0" VIOLATION.
   *
   * A tally genuinely IS `(0, 0)` for anything nobody has voted on — that is the contract's own
   * answer for an unknown `entityId`, not an invention — and the pre-batch version returned the same
   * zeroes when the read failed. Preserving it keeps `VotingWidget`'s render identical, and the
   * widget has no other representation available: its `VoteTally` has no "unknown". Changing that
   * belongs with a change to the widget, which this pass is not allowed to touch.
   */
  const getVoteTally = useCallback(
    async (entityId: string): Promise<VoteTally> => {
      if (!getReadContract()) return { upvotes: 0, downvotes: 0, score: 0 };
      try {
        return await tallies.load(entityId);
      } catch (err) {
        // ⚠️ AN ABSENT SLOT IS NOT WORTH A CONSOLE LINE. `?backend=fake` answers every `tuple[]`
        // with `[]` deliberately, so on the fake EVERY key in every batch is absent — logging it
        // per card would bury the scenario the fake exists to test under fifty errors per paint.
        // A call that actually broke is still reported.
        if (!isBatchEntryMissing(err)) console.error("Failed to get vote tally:", err);
        return { upvotes: 0, downvotes: 0, score: 0 };
      }
    },
    [getReadContract, tallies]
  );

  const getUserVote = useCallback(
    async (entityId: string, voter?: string): Promise<VoteType> => {
      const contract = getReadContract();
      const voterAddress = voter ?? userAddress;
      if (!contract || !voterAddress) {
        return VoteTypeEnum.None;
      }

      try {
        // ⚠️ AN EXPLICIT `voter` BYPASSES THE BATCH. The loader is bound to `userAddress`; answering
        // a question about somebody else out of it would attribute one person's vote to another.
        // No caller passes one today (`VotingWidget`'s prop type is `(entityId) => …`), so this is
        // the rare path, not the hot one.
        if (voterAddress !== userAddress) {
          return Number(await contract.getUserVote(entityId, voterAddress)) as VoteType;
        }
        return await userVotes.load(entityId);
      } catch (err) {
        // Same rule as the tally above — absent is quiet, broken is loud.
        if (!isBatchEntryMissing(err)) console.error("Failed to get user vote:", err);
        return VoteTypeEnum.None;
      }
    },
    [getReadContract, userAddress, userVotes]
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
