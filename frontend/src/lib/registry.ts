// Registry ids. Pure keccak, computed on the client — there is nothing to ask the chain for.
//
// `PostRegistry` never parses a registry id: `mapping(bytes32 => …)` is its whole storage model, so
// a room, a board, a profile feed and a thread's replies are all just `bytes32` values. Two
// derivations exist and both are `pure` on the contract:
//
//   · `openRegistryId(name)`        = keccak256(name)                    — permissionless, unclaimable
//   · `registryIdFor(creator,salt)` = keccak256(abi.encode(creator,salt)) — claimable, has a policy
//
// ⚠️ ONLY THE OPEN ONE IS HERE, AND THAT IS THE POINT. An id produced by `keccak256(name)` is not in
// the image of `registryIdFor` for any caller — finding a collision would be a keccak preimage
// attack — so `Open` is not merely its default policy, it is its ONLY possible one. Nobody can ever
// claim the reply registry of somebody else's thread and then moderate it. See PostRegistry.sol,
// "CLAIMING — squatting is impossible by construction".
//
// These live in one module because a registry id computed in two places is a registry id that will
// eventually disagree with itself, and the failure is silent: writes land in a chain nobody reads.

import { ethers } from "ethers";

/**
 * The id of an unclaimable, permanently-open registry. Mirrors `PostRegistry.openRegistryId`.
 *
 * Computed locally rather than through an `eth_call`: the contract function is `pure`, so a round
 * trip would buy nothing and could fail while a keccak cannot.
 */
export function openRegistryId(name: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

/** The board. Thread announcements are the chain hanging off each writer's head here. */
export const FORUM_REGISTRY = openRegistryId("forum");

/** Profile feeds. `headOf(FEED_REGISTRY, user)` is that user's own chain. */
export const FEED_REGISTRY = openRegistryId("feed");

/** Namespaces reply registries so they can never collide with a room or board name. */
export const THREAD_REGISTRY_PREFIX = "thread:";

/**
 * The registry that holds the replies to one thread or post.
 *
 * ⭐ A REPLY IS A POST WHOSE REGISTRY IS THE THREAD ITSELF (architecture §2). There is no parent
 * pointer in the wire format and there does not need to be one: the parent is the registry the reply
 * was written into. Replies to a given CID are therefore exactly the chains hanging off the heads of
 * `threadRegistryId(cid)`, which costs one `getHeadsPaged` and a walk — the same read as a board.
 *
 * Keyed on the parent's CID, not on its position, so the reply chain of a thread survives everybody
 * else posting. It is derived from the ANNOUNCEMENT's cid for a thread and from the post's own cid
 * for a profile post — in both cases the same value the vote tally is keyed on (`lib/entity.ts`).
 *
 * ⚠️ NULL FOR A MISSING CID, never a hash of the bare prefix. `keccak256("thread:")` is a single
 * valid registry id, so returning it would silently merge the replies of every unresolved parent
 * into one shared conversation — the same trap `entityIdOfCid` refuses for vote tallies.
 */
export function threadRegistryId(parentCid: string | null | undefined): string | null {
  if (!parentCid) return null;
  return openRegistryId(THREAD_REGISTRY_PREFIX + parentCid);
}
