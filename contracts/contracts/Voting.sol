// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IUserRegistryVoting {
    function canActAs(address actor, address principal) external view returns (bool);
    function hasProfile(address addr) external view returns (bool);
}

/**
 * @title Voting — shared tallies for anything addressable
 * @notice Upvotes and downvotes stay on chain. §3 gives the reason and it is not "votes are
 *         configuration": **a tally is an aggregate, and Bulletin has no aggregation.** Scoring a
 *         500-voter post from Bulletin alone would mean 500 head reads plus 500 object fetches to
 *         compute one integer that a single `SLOAD` can return.
 *
 * WHAT CHANGED FROM THE PREVIOUS VERSION
 * --------------------------------------
 * The shared-entity model is kept exactly as it was — one `bytes32 entityId`, one tally, one vote
 * per voter per entity — because it was already the right shape and it is agnostic about what an
 * entity IS. Only the DERIVATION changed. The old `getEntityId(contractAddress, entityType,
 * entityIndex)` addressed `UserPosts[7]` in a specific contract: a positional identity in an
 * append-only array. Those arrays are gone (§2 collapses `ForumThread`, `UserPosts` and `Replies`
 * into one Post type) and there is no index to point at any more. Posts are Bulletin objects, so
 * their identity is their CID.
 *
 * TWO DERIVATIONS, AND THE CHOICE MATTERS
 * ---------------------------------------
 * · `entityIdOfCid(cid)` — one global tally per post, wherever it is read. Cross-posting is N
 *   attachments to ONE Post (§2), so this is the tally of "the thing itself".
 * · `entityIdInRegistry(registry, cid)` — a separate tally per registry the post is attached to.
 *   The same body scored independently on each board.
 *
 * The contract does not choose; it hashes what it is given and the app picks per surface. The
 * trade-off, stated once so nobody has to rediscover it: global tallies make one popular
 * cross-post dominate every board it touches and let a brigade in one room set the score everywhere;
 * per-registry tallies contain that but fragment the signal and let the same account vote on the
 * same body once per board. Plaza's boards want per-registry; a profile feed wants global.
 *
 * ⚠️ CIDs ARE STABLE ACROSS RENEWAL, AND THAT IS WHY THIS WORKS. `renew` extends a storage record's
 * expiry and does not change the CID, so a tally keyed on a CID survives renewal. It does NOT
 * survive an edit: editing a post produces a new object with a new CID and therefore a new,
 * empty tally. That is a feature — a tally belongs to the bytes people actually voted on — but a UI
 * that shows an edited post's score as unchanged would be lying.
 *
 * STORAGE — the only thing in Plaza that accrues
 * ----------------------------------------------
 * One slot per (entity, voter) plus one tally slot per entity. §3 accepts this explicitly: it is
 * ~0.006 PAS at the measured child-trie rate, **paid by the voter and refundable by them** via
 * `removeVote`, which frees the slot and returns the deposit to whoever created it.
 *
 * There is deliberately NO `removeVoteFor` and no admin clear, for the same reason `PostRegistry`
 * has no `clearHeadFor`: freeing storage pays the refund to whoever freed it, so a delegated
 * un-vote would hand a delegate the voter's deposit. Voting is on the hot path and delegable;
 * withdrawal stays with the owner.
 */
/**
 * WHY THE REGISTRY IS PINNED AND NOT A CONSTRUCTOR ARGUMENT
 * --------------------------------------------------------
 * `cdm deploy` submits `Revive.instantiate_with_code` with `data = new Uint8Array(0)` — constructor
 * calldata is hard-coded empty and no flag can change it (verified 2026-07-30 in cdm-cli 0.8.26,
 * `ContractDeployer.dryRunDeploy`). A `constructor(address)` therefore decodes `address(0)` and
 * reverts, taking every other contract in the deploy chunk down with it. So the dependency is a
 * compile-time constant.
 *
 * Pinning is not merely the convenient option, it is the CORRECT one. The alternative — resolving
 * the CDM name `plaza-social/user-registry` through the CDM registry at call time — would follow the *latest*
 * version, and cdm's deploy salt includes the version, so a redeploy lands at a NEW address with
 * EMPTY storage. Every delegation would be silently invalidated at once. Delegation state lives in
 * one specific UserRegistry instance, so this contract must name that instance.
 *
 * ⚠️ The pin is to **v0**. A future `cdm deploy` that bumps UserRegistry to v1 puts it at a new
 * address and leaves this contract on v0 — which keeps working, holds the delegations, and is
 * probably what you want, but is not what "I just redeployed" suggests. `deployments.json` must
 * agree. To change the pin: grep `PLAZA-USER-REGISTRY-ADDRESS`, edit every site, recompile, redeploy.
 */
/// @custom:cdm @plaza-social/voting
contract Voting {
    /// PLAZA-USER-REGISTRY-ADDRESS — one of three pinned sites; grep the tag before editing.
    address internal constant USER_REGISTRY_ADDRESS = 0xfD00289e765414C0281EFC35335b6453F055FBD7;

    enum VoteType { None, Up, Down }

    struct VoteTally {
        uint256 upvotes;
        uint256 downvotes;
    }

    /// entityId => tally
    mapping(bytes32 => VoteTally) public tallies;

    /// entityId => voter => vote
    mapping(bytes32 => mapping(address => VoteType)) public userVotes;

    IUserRegistryVoting public constant userRegistry = IUserRegistryVoting(USER_REGISTRY_ADDRESS);

    event Voted(bytes32 indexed entityId, address indexed voter, VoteType voteType, int256 newScore);
    event VoteRemoved(bytes32 indexed entityId, address indexed voter, int256 newScore);

    error ProfileRequired();
    error NotVoted();
    error InvalidVoteType();
    error NotAuthorized(address principal, address caller);
    error UserRegistryNotDeployed(address expected);

    /**
     * @dev Fails the DEPLOY if nothing lives at the pinned address, rather than letting every
     *      delegated write revert later with an ABI-decode error that names nothing. A pinned
     *      address is network-specific and this is the whole class of silent failure that costs the
     *      most time on this stack, so it is worth 200 gas once.
     *
     *      In tests this means UserRegistry's code must be placed at `USER_REGISTRY_ADDRESS`
     *      *before* this contract is deployed — `test/helpers/pinnedUserRegistry.js` does that with
     *      `hardhat_setCode`. UserRegistry has no constructor, so copied code plus empty storage is
     *      indistinguishable from a fresh deploy.
     */
    constructor() {
        if (USER_REGISTRY_ADDRESS.code.length == 0) revert UserRegistryNotDeployed(USER_REGISTRY_ADDRESS);
    }

    // ============ Entity ids (pure) ============

    /**
     * @notice One global tally for a post, identified by its Bulletin CID.
     * @dev Pure and free. Clients may also compute `keccak256(utf8(cid))` locally and pass the
     *      bytes32 straight to `vote`, which keeps the CID string out of calldata on a call that
     *      runs on every tap.
     */
    function entityIdOfCid(string calldata cid) external pure returns (bytes32) {
        return keccak256(bytes(cid));
    }

    /// @notice A per-registry tally for a post: the same body scored separately on each board.
    /// @dev `abi.encode`, not `encodePacked`: packing a bytes32 next to a variable-length string is
    ///      exactly the shape where two different (registry, cid) pairs can produce one preimage.
    function entityIdInRegistry(bytes32 registry, string calldata cid) external pure returns (bytes32) {
        return keccak256(abi.encode(registry, cid));
    }

    // ============ Writes ============

    /// @notice Vote as yourself.
    function vote(bytes32 entityId, VoteType voteType) external {
        _vote(msg.sender, entityId, voteType);
    }

    /**
     * @notice Vote on behalf of `voter`. The vote is credited to `voter`, not to the signing key.
     * @dev Callable by `voter` themselves or by a live delegate of theirs. The principal is NAMED
     *      rather than reverse-resolved from the signer, because a delegate address is only unique
     *      per owner (see the UserRegistry header) and guessing would misattribute the vote.
     */
    function voteFor(address voter, bytes32 entityId, VoteType voteType) external {
        if (voter != msg.sender && !userRegistry.canActAs(msg.sender, voter)) {
            revert NotAuthorized(voter, msg.sender);
        }
        _vote(voter, entityId, voteType);
    }

    /**
     * @notice Withdraw your vote and reclaim the storage deposit it holds.
     * @dev Owner-only by design; see the contract header. Reverts if there was nothing to withdraw,
     *      because unlike a revocation this is not an idempotent safety operation — a silent
     *      success would hide a client bug about which entity it is looking at.
     */
    function removeVote(bytes32 entityId) external {
        VoteType existing = userVotes[entityId][msg.sender];
        if (existing == VoteType.None) revert NotVoted();

        _decrement(entityId, existing);
        delete userVotes[entityId][msg.sender];

        emit VoteRemoved(entityId, msg.sender, getScore(entityId));
    }

    // ============ Reads ============

    /// @notice upvotes − downvotes.
    function getScore(bytes32 entityId) public view returns (int256) {
        VoteTally storage tally = tallies[entityId];
        return int256(tally.upvotes) - int256(tally.downvotes);
    }

    function getTally(bytes32 entityId) external view returns (uint256 upvotes, uint256 downvotes) {
        VoteTally storage tally = tallies[entityId];
        return (tally.upvotes, tally.downvotes);
    }

    /**
     * @notice Tallies for many entities in one call, in the order given.
     * @dev The read a rendered board or feed actually needs: one `eth_call` for a screenful of
     *      posts instead of one per post. O(entityIds).
     */
    function getTallies(bytes32[] calldata entityIds)
        external
        view
        returns (VoteTally[] memory result)
    {
        result = new VoteTally[](entityIds.length);
        for (uint256 i = 0; i < entityIds.length; ++i) {
            result[i] = tallies[entityIds[i]];
        }
    }

    /// @notice A specific account's vote. Plain lookup — pass the PROFILE OWNER, not a delegate.
    function getUserVote(bytes32 entityId, address user) external view returns (VoteType) {
        return userVotes[entityId][user];
    }

    function hasVoted(bytes32 entityId, address user) external view returns (bool) {
        return userVotes[entityId][user] != VoteType.None;
    }

    /// @notice One account's votes across many entities, for rendering a screenful at once.
    function getUserVotes(bytes32[] calldata entityIds, address user)
        external
        view
        returns (VoteType[] memory result)
    {
        result = new VoteType[](entityIds.length);
        for (uint256 i = 0; i < entityIds.length; ++i) {
            result[i] = userVotes[entityIds[i]][user];
        }
    }

    // ============ Internal ============

    /// @dev A profile is required to vote. It is not sybil resistance — profiles are free — but it
    ///      does mean a vote is attached to something with a name, and it keeps the tally readable
    ///      as "N people" rather than "N addresses".
    ///
    ///      ⛔ DO NOT replace this with the personhood precompile. Verified 2026-07-30
    ///      (`scripts/probe-personhood.mjs`, gotchas §Personhood): `personhoodStatus(address,context)`
    ///      resolves an address to a person via `AccountToAlias`, which has **zero entries** in all
    ///      three places it exists, and the `AliasFee` Asset Hub's binding extrinsic needs is unset.
    ///      It returns 0 for every address in existence, so a gate on it rejects everyone.
    ///
    ///      That is a limit on what SOLIDITY can see, not on personhood. Personhood lives on the
    ///      Individuality chain, where `PeopleLite.LitePeople` is keyed by plain account and has 151
    ///      entries — a real one-human-one-account check that the **frontend** should gate on. The
    ///      division of labour: the app enforces personhood, this contract enforces attribution.
    ///      Revisit the precompile the day `AccountToAlias` is non-empty; `contextAlias` would then
    ///      be strictly better than `hasProfile`, which gates nothing since profiles are free.
    function _vote(address voter, bytes32 entityId, VoteType voteType) private {
        if (voteType == VoteType.None) revert InvalidVoteType();
        if (!userRegistry.hasProfile(voter)) revert ProfileRequired();

        VoteType existing = userVotes[entityId][voter];
        if (existing == voteType) return; // idempotent: re-tapping the same arrow is not an error
        if (existing != VoteType.None) _decrement(entityId, existing);

        if (voteType == VoteType.Up) {
            tallies[entityId].upvotes++;
        } else {
            tallies[entityId].downvotes++;
        }
        userVotes[entityId][voter] = voteType;

        emit Voted(entityId, voter, voteType, getScore(entityId));
    }

    function _decrement(bytes32 entityId, VoteType voteType) private {
        if (voteType == VoteType.Up) {
            tallies[entityId].upvotes--;
        } else if (voteType == VoteType.Down) {
            tallies[entityId].downvotes--;
        }
    }
}
