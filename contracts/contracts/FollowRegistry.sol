// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IUserRegistryFollow {
    function canActAs(address actor, address principal) external view returns (bool);
}

/**
 * @title FollowRegistry — the follow graph
 * @notice Kept essentially as it was, because it works and it is load-bearing: the feed reads
 *         `getFollowing(user)` and then fetches each followee's head, so the graph drives the
 *         product rather than decorating it (architecture.md §8). §3's reason it cannot be Bulletin
 *         is that it must be enumerable in BOTH directions, which a CID chain is not.
 *
 * The intended feed read is now two calls total:
 *
 *     address[] following = followRegistry.getFollowing(user);
 *     HeadRef[] heads     = postRegistry.headsOf(FEED_REGISTRY, following);
 *
 * ONE CHANGE, AND ONLY ONE
 * ------------------------
 * `follow`/`unfollow` no longer reverse-resolve the signer to a profile owner. The old
 * `_resolveFollower` called `UserRegistry.resolveToOwner(msg.sender)`, which no longer exists:
 * delegate addresses are now unique per owner rather than globally (see the UserRegistry header),
 * so a reverse lookup can only guess, and a wrong guess edits the wrong person's follow graph.
 *
 * The delegated path is therefore explicit — `followFor(owner, followee)` — and the plain
 * `follow(followee)` acts as `msg.sender`. Every read function is byte-identical to before, so the
 * feed code that consumes this does not change.
 *
 * STORAGE
 * -------
 * Two array entries and two index slots per edge, all four freed by `unfollow`, so the deposit is
 * fully reclaimable by whoever created it. An edge is created by the FOLLOWER and can only be
 * removed by the follower (or their delegate), so no account can free another's storage and collect
 * their refund — the same invariant `PostRegistry` is built around.
 *
 * ⚠️ `followFor` lets a delegate create an edge the delegate paid the deposit for, which
 * `unfollowFor` can also free — so a delegate CAN return that deposit to itself. That is safe here
 * and not in `PostRegistry.clearHead` for a concrete reason: an unfollow is symmetric and cheap to
 * redo, and both keys belong to the same person, whereas a cleared head destroys a pointer to
 * content whose chain nobody else can rebuild.
 */
/// @custom:cdm @plaza-social/follow-registry
contract FollowRegistry {

    // ============ State ============

    /// PLAZA-USER-REGISTRY-ADDRESS — one of three pinned sites; grep the tag before editing.
    address internal constant USER_REGISTRY_ADDRESS = 0xfD00289e765414C0281EFC35335b6453F055FBD7;

    /// @notice The delegation authority, consulted only for `followFor` / `unfollowFor`.
    /// @dev A compile-time constant, not a constructor argument: `cdm deploy` hard-codes empty
    ///      constructor calldata, and resolving the name through the CDM registry would follow the
    ///      latest version — landing on a fresh, empty UserRegistry and silently invalidating every
    ///      delegation. See the long version in PostRegistry.sol. Pinned to **v0**.
    IUserRegistryFollow public constant userRegistry = IUserRegistryFollow(USER_REGISTRY_ADDRESS);

    // user => list of addresses they follow
    mapping(address => address[]) private _following;
    // user => followee => index+1 in _following array (0 means not following)
    mapping(address => mapping(address => uint256)) private _followingIndex;

    // followee => list of their followers
    mapping(address => address[]) private _followers;
    // followee => follower => index+1 in _followers array (0 means not a follower)
    mapping(address => mapping(address => uint256)) private _followerIndex;

    // ============ Events ============

    event Followed(address indexed follower, address indexed followee);
    event Unfollowed(address indexed follower, address indexed followee);

    // ============ Errors ============

    error ZeroAddress();
    error CannotFollowSelf();
    error AlreadyFollowing();
    error NotFollowing();
    error NotAuthorized(address principal, address caller);
    error UserRegistryNotDeployed(address expected);

    // ============ Constructor ============

    /// @dev No arguments — it cannot take any. Fails the DEPLOY if the pinned address holds no code,
    ///      so a wrong-network deploy is caught immediately rather than surfacing much later as a
    ///      delegated follow that reverts for no visible reason. Tests place the code first via
    ///      `test/helpers/pinnedUserRegistry.js`.
    constructor() {
        if (USER_REGISTRY_ADDRESS.code.length == 0) revert UserRegistryNotDeployed(USER_REGISTRY_ADDRESS);
    }

    // ============ Follow Management ============

    /// @notice Follow a user, as yourself.
    function follow(address user) external {
        _follow(msg.sender, user);
    }

    /// @notice Unfollow a user, as yourself.
    function unfollow(address user) external {
        _unfollow(msg.sender, user);
    }

    /// @notice Follow `user` on behalf of `follower`. Callable by `follower` or a live delegate.
    function followFor(address follower, address user) external {
        _requireCanActAs(follower);
        _follow(follower, user);
    }

    /// @notice Unfollow `user` on behalf of `follower`. Callable by `follower` or a live delegate.
    function unfollowFor(address follower, address user) external {
        _requireCanActAs(follower);
        _unfollow(follower, user);
    }

    // ============ View Functions ============

    /// @notice Get list of addresses a user is following
    /// @dev Unpaged, and deliberately so: this is the input to `PostRegistry.headsOf` and a partial
    ///      list is a partial feed. It is a view, so nobody pays gas — but a user following
    ///      thousands of accounts will eventually exceed an RPC's `eth_call` cap, and
    ///      `getFollowingPaged` is the escape hatch for that.
    function getFollowing(address user) external view returns (address[] memory) {
        return _following[user];
    }

    /// @notice Get list of followers for a user
    function getFollowers(address user) external view returns (address[] memory) {
        return _followers[user];
    }

    /// @notice A page of the following list. O(limit).
    function getFollowingPaged(address user, uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory page, uint256 total)
    {
        return _page(_following[user], offset, limit);
    }

    /// @notice A page of the follower list. O(limit).
    function getFollowersPaged(address user, uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory page, uint256 total)
    {
        return _page(_followers[user], offset, limit);
    }

    /// @notice Check if one user follows another
    function isFollowing(address follower, address followee) external view returns (bool) {
        return _followingIndex[follower][followee] != 0;
    }

    /// @notice Get the number of users someone is following
    function getFollowingCount(address user) external view returns (uint256) {
        return _following[user].length;
    }

    /// @notice Get the number of followers for a user
    function getFollowerCount(address user) external view returns (uint256) {
        return _followers[user].length;
    }

    // ============ Internal ============

    function _requireCanActAs(address principal) private view {
        if (principal == msg.sender) return;
        if (userRegistry.canActAs(msg.sender, principal)) return;
        revert NotAuthorized(principal, msg.sender);
    }

    function _follow(address follower, address user) private {
        if (user == address(0)) revert ZeroAddress();
        if (user == follower) revert CannotFollowSelf();
        if (_followingIndex[follower][user] != 0) revert AlreadyFollowing();

        _following[follower].push(user);
        _followingIndex[follower][user] = _following[follower].length; // index+1

        _followers[user].push(follower);
        _followerIndex[user][follower] = _followers[user].length; // index+1

        emit Followed(follower, user);
    }

    /// @dev Swap-and-pop on both sides, so both lists REORDER on an unfollow. Clients must re-read.
    function _unfollow(address follower, address user) private {
        if (_followingIndex[follower][user] == 0) revert NotFollowing();

        uint256 followingIdx = _followingIndex[follower][user] - 1;
        uint256 lastFollowingIdx = _following[follower].length - 1;
        if (followingIdx != lastFollowingIdx) {
            address lastFollowing = _following[follower][lastFollowingIdx];
            _following[follower][followingIdx] = lastFollowing;
            _followingIndex[follower][lastFollowing] = followingIdx + 1;
        }
        _following[follower].pop();
        delete _followingIndex[follower][user];

        uint256 followerIdx = _followerIndex[user][follower] - 1;
        uint256 lastFollowerIdx = _followers[user].length - 1;
        if (followerIdx != lastFollowerIdx) {
            address lastFollower = _followers[user][lastFollowerIdx];
            _followers[user][followerIdx] = lastFollower;
            _followerIndex[user][lastFollower] = followerIdx + 1;
        }
        _followers[user].pop();
        delete _followerIndex[user][follower];

        emit Unfollowed(follower, user);
    }

    function _page(address[] storage list, uint256 offset, uint256 limit)
        private
        view
        returns (address[] memory page, uint256 total)
    {
        total = list.length;
        if (offset >= total || limit == 0) return (new address[](0), total);
        uint256 end = offset + limit;
        if (end > total) end = total;
        page = new address[](end - offset);
        for (uint256 i = 0; i < page.length; ++i) {
            page[i] = list[offset + i];
        }
    }
}
