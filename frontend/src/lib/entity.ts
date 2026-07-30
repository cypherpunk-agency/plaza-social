// Vote entity ids. Pure, and deliberately computed on the client rather than asked for.
//
// ⚠️ WHAT THIS REPLACES. `Voting` used to identify a votable thing POSITIONALLY —
// `getEntityId(contractAddress, entityType, entityIndex)` over a per-type contract. Those contracts
// are deleted and that function does not exist on the deployed `Voting`, which surfaced on every
// card as:
//
//   Failed to compute entity ID: TypeError: T.getEntityId is not a function
//
// A method the target does not have is the signature of an un-migrated call site, not of a broken
// contract — the same tell as the `getUserPostCount` reverts before it.
//
// The identity is now the **CID**, because that is what the votes were actually cast on. Two
// consequences that are features rather than accidents:
//
//   · a tally SURVIVES A RENEWAL — the CID does not change when content is kept alive
//   · a tally does NOT survive an EDIT — an edit is new bytes, so a new CID and a new, empty tally.
//     A tally belongs to the words people read.
//
// Both derivations are `pure` on the contract, so there is no reason to spend an `eth_call` on
// them. `Voting.sol` says so explicitly: computing them locally "keeps the CID string out of
// calldata on a call that runs on every tap". Doing it here also means a vote count renders on the
// first paint instead of after a round trip, and cannot fail.

import { ethers } from "ethers";

/**
 * One global tally for a post, wherever it appears. Mirrors `Voting.entityIdOfCid`.
 *
 * Returns `null` for an absent CID — a thread whose pointer is on chain but whose body we have not
 * resolved has nothing to key a tally on, and a zero hash would silently merge every such item into
 * one shared tally.
 */
export function entityIdOfCid(cid: string | null | undefined): string | null {
  if (!cid) return null;
  return ethers.keccak256(ethers.toUtf8Bytes(cid));
}

/**
 * A per-registry tally: the same body scored separately on each board. Mirrors
 * `Voting.entityIdInRegistry`.
 *
 * ⚠️ `abi.encode`, NOT `encodePacked`, and the contract is emphatic about it: packing a bytes32
 * next to a variable-length string is exactly the shape where two different (registry, cid) pairs
 * collide into one preimage.
 */
export function entityIdInRegistry(registry: string, cid: string | null | undefined): string | null {
  if (!cid) return null;
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "string"], [registry, cid]),
  );
}
