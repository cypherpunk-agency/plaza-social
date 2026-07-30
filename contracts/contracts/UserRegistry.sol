// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title UserRegistry — profiles and delegation
 * @notice Two jobs, both of which have to be on chain and neither of which can be Bulletin:
 *
 *         · **Profiles** (displayName, bio, links). Read on every message render, for many
 *           addresses at once — one multicall against this contract versus one gateway fetch per
 *           user (architecture.md §3). Small, hot, keyed.
 *         · **Delegation.** Which local key may act for which account. Must be authoritative and
 *           must be readable by the other contracts, so it lives here once rather than in each.
 *
 * WHAT CHANGED FROM THE PREVIOUS VERSION, AND WHY
 * -----------------------------------------------
 * 1. **`sessionPublicKeys` is gone.** Encrypted DMs are dropped entirely (§7) and nothing else read
 *    it. It was the only `bytes` in the contract, it was the reason profile transfer had a
 *    conditional copy, and the platform offers no substitute — so this is removing a feature, not
 *    relocating one.
 *
 * 2. **Delegations expire.** The old `addDelegate` authorised a key FOREVER with no expiry field at
 *    all. A delegate key lives in a browser: "until I revoke it" is a key that outlives the device
 *    it was generated on, the tab it was generated in, and the user's memory of having generated
 *    it. `MAX_DELEGATION_SECONDS` bounds how long a forgotten or leaked key stays dangerous, and
 *    re-authorising is one prompt a quarter rather than one per post.
 *
 * 3. **Delegate addresses are unique per owner, not globally.** The old code enforced
 *    `delegateToOwner[delegate] == address(0)` — one delegate address anywhere on the chain, ever.
 *    Delegate keys are DERIVED (same seed, same path ⇒ same address), so two profiles belonging to
 *    the same person legitimately collide, and the second profile could never authorise its own
 *    session key. The two-level mapping `delegateExpiry[owner][delegate]` makes uniqueness per-owner
 *    automatically: re-authorising the same pair is just an expiry update.
 *
 * 4. **⚠️ The global reverse lookup `delegateToOwner` is gone, and `resolveToOwner` with it.** This
 *    is forced by (3) and is the one breaking change to callers. If one address can be a live
 *    delegate of two owners, `delegateToOwner[d]` has no correct answer — it can only guess, and a
 *    wrong guess ATTRIBUTES A POST TO THE WRONG PERSON. The old `ChatChannel`, `Voting`,
 *    `FollowRegistry` and `UserPosts` all resolved authorship that way, which was safe only because
 *    of the global-uniqueness check being removed here.
 *
 *    The replacement is explicit and unambiguous: a delegated call NAMES its principal and the
 *    callee checks `canActAs(msg.sender, principal)`. See `FollowRegistry.followFor`,
 *    `Voting.voteFor`, `PostRegistry.setHeadFor`. A client always knows which profile it is acting
 *    for — it is the one whose key it holds — so nothing is lost but the guessing.
 *
 * WHY DELEGATION IS A TRANSACTION AND NOT A SIGNED MESSAGE
 * -------------------------------------------------------
 * `authorizeDelegate` reads `msg.sender` and nothing else: no `ecrecover`, no EIP-712 domain, no
 * signature to verify. A host-wallet account is sr25519 and its H160 is derived by pallet-revive's
 * `AddressMapper` from an AccountId32, NOT from a secp256k1 public key — there is no private key in
 * that derivation whose signature `ecrecover` could recover to the user's own address. A
 * signature-based scheme would be building on a primitive the platform may simply not have. It also
 * costs the same: either way the user approves exactly one thing, once (§5's prompt table makes
 * `authorizeDelegate` one of exactly two unavoidable modals). `msg.sender` is unforgeable, needs no
 * nonce, and cannot be replayed onto another contract.
 *
 * WHAT A DELEGATE CAN DO, EXACTLY
 * -------------------------------
 * Act as its principal in contracts that ask `canActAs`: move that principal's heads, follow and
 * unfollow, vote, edit their links. It cannot authorise further delegates, cannot revoke itself,
 * cannot change the display name or bio, cannot transfer the profile, cannot clear a head (which
 * would collect the principal's storage refund), and holds none of the principal's funds. The blast
 * radius of a leaked delegate key is "someone can post as you until the expiry you chose, and you
 * can revoke it sooner".
 *
 * STORAGE
 * -------
 * One profile row and up to ten link rows per owner, plus one slot per live delegation. Nothing
 * here grows with activity: posting does not touch this contract at all.
 */
/// @custom:cdm @plaza-social/user-registry
contract UserRegistry {

    // ============ Data Structures ============

    struct Link {
        string name;
        string url;
    }

    struct Profile {
        address owner;
        string displayName;
        string bio;
        bool exists;
    }

    // ============ Constants ============

    /**
     * @notice The furthest into the future a delegation may be authorised: 90 days.
     *
     * @dev 90 rather than something shorter because it must comfortably exceed Bulletin's ~14-day
     *      retention window (§4): a user whose delegation expires more often than their own content
     *      does would experience the prompt as constant. Clients should read this constant rather
     *      than hardcoding a window — `authorizeDelegate` REVERTS above it rather than clamping, so
     *      a client that guesses high fails loudly instead of silently getting less than it asked
     *      for.
     */
    uint64 public constant MAX_DELEGATION_SECONDS = 90 days;

    uint256 public constant MAX_DISPLAY_NAME_BYTES = 50;
    uint256 public constant MAX_BIO_BYTES = 500;
    uint256 public constant MAX_LINK_NAME_BYTES = 50;
    uint256 public constant MAX_LINK_URL_BYTES = 200;
    uint256 public constant MAX_LINKS = 10;

    // ============ State ============

    /// Profile data (owner address => profile)
    mapping(address => Profile) public profiles;

    /// Links stored separately (owner => links array), bounded at MAX_LINKS
    mapping(address => Link[]) private profileLinks;

    /**
     * @notice owner => delegate => unix second at which the delegation stops being valid. 0, or any
     *         value in the past, means "not a delegate".
     * @dev Public so a client can read the exact expiry — to decide WHEN to re-prompt — rather than
     *      only the boolean `isDelegate` gives it. The pair is (owner, delegate) in that order and
     *      the relation is one-directional: being someone's delegate grants nothing in reverse.
     */
    mapping(address => mapping(address => uint64)) public delegateExpiry;

    // ============ Events ============

    event ProfileCreated(address indexed owner);
    event DisplayNameUpdated(address indexed owner, string newName);
    event BioUpdated(address indexed owner, string newBio);
    event LinkAdded(address indexed owner, uint256 index, string name, string url);
    event LinkRemoved(address indexed owner, uint256 index);
    event LinksCleared(address indexed owner);

    /**
     * @notice `owner` allowed `delegate` to act for them until `expiry`.
     * @dev Re-authorising an existing delegate emits again with the new expiry, so the newest event
     *      for a pair is always the current state. `expiry` is the value actually stored, which —
     *      because the maximum reverts rather than clamps — is always the value that was asked for.
     */
    event DelegateAuthorized(address indexed owner, address indexed delegate, uint64 expiry);

    /// @notice `owner` withdrew `delegate`'s authority. Idempotent: emitted even if there was none.
    event DelegateRevoked(address indexed owner, address indexed delegate);

    event ProfileOwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ============ Errors ============

    error ProfileExists();
    error NoProfile(address owner);
    error DisplayNameRequired();
    error EmptyValue();
    error TooLong(uint256 length, uint256 maximum);
    error TooManyLinks(uint256 maximum);
    error IndexOutOfBounds(uint256 index, uint256 length);

    /// @dev `address(0)` is nobody's key; authorising it would be a silent no-op that reads as a
    ///      live delegation.
    error ZeroDelegate();
    /// @dev You can always act as yourself. Storing a self-delegation would cost a deposit, grant
    ///      nothing, and make a client's "do I need to prompt?" check answer yes for the one
    ///      account that never needs to.
    error SelfDelegate();
    /// @dev A non-zero expiry already in the past. Pass 0 to revoke; anything else that cannot
    ///      possibly authorise is a clock or unit bug (seconds vs milliseconds), and it should be
    ///      loud rather than stored.
    error ExpiryInPast(uint64 expiry, uint64 nowSeconds);
    error ExpiryTooFar(uint64 expiry, uint64 maximum);
    error NotAuthorized(address principal, address caller);

    error InvalidNewOwner();

    // ============ Modifiers ============

    modifier onlyProfileOwner() {
        if (!profiles[msg.sender].exists) revert NoProfile(msg.sender);
        _;
    }

    // ============ Internal Helpers ============

    /// @dev The single gate on every delegated write in this repo's contracts. A principal is
    ///      always allowed to act as themselves, so callers can use one code path whether or not a
    ///      delegation exists.
    function _requireCanActAs(address principal) internal view {
        if (principal == msg.sender) return;
        if (block.timestamp < delegateExpiry[principal][msg.sender]) return;
        revert NotAuthorized(principal, msg.sender);
    }

    // ============ Profile Management ============

    function createProfile(string calldata displayName, string calldata bio) external {
        if (profiles[msg.sender].exists) revert ProfileExists();
        if (bytes(displayName).length == 0) revert DisplayNameRequired();
        if (bytes(displayName).length > MAX_DISPLAY_NAME_BYTES) {
            revert TooLong(bytes(displayName).length, MAX_DISPLAY_NAME_BYTES);
        }
        if (bytes(bio).length > MAX_BIO_BYTES) revert TooLong(bytes(bio).length, MAX_BIO_BYTES);

        profiles[msg.sender] = Profile({
            owner: msg.sender,
            displayName: displayName,
            bio: bio,
            exists: true
        });

        emit ProfileCreated(msg.sender);
    }

    /// @notice Creates a profile with an address-derived display name.
    /// @dev Onboarding path: a user who has not chosen a name still needs a profile row so that
    ///      contracts gating on `hasProfile` (Voting) do not lock them out on their first action.
    function createDefaultProfile() external {
        if (profiles[msg.sender].exists) revert ProfileExists();

        profiles[msg.sender] = Profile({
            owner: msg.sender,
            displayName: _addressToShortString(msg.sender),
            bio: "",
            exists: true
        });

        emit ProfileCreated(msg.sender);
    }

    function _addressToShortString(address addr) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory str = new bytes(10); // "0x" + 8 chars
        str[0] = '0';
        str[1] = 'x';
        uint160 value = uint160(addr);
        for (uint256 i = 9; i >= 2; i--) {
            str[i] = alphabet[value & 0xf];
            value >>= 4;
        }
        return string(str);
    }

    /// @dev Name and bio are owner-only, deliberately: a leaked delegate key should not be able to
    ///      rename its principal. Links are delegable (below) because they are additive, bounded
    ///      and reversible.
    function setDisplayName(string calldata displayName) external onlyProfileOwner {
        if (bytes(displayName).length == 0) revert DisplayNameRequired();
        if (bytes(displayName).length > MAX_DISPLAY_NAME_BYTES) {
            revert TooLong(bytes(displayName).length, MAX_DISPLAY_NAME_BYTES);
        }

        profiles[msg.sender].displayName = displayName;
        emit DisplayNameUpdated(msg.sender, displayName);
    }

    function setBio(string calldata bio) external onlyProfileOwner {
        if (bytes(bio).length > MAX_BIO_BYTES) revert TooLong(bytes(bio).length, MAX_BIO_BYTES);

        profiles[msg.sender].bio = bio;
        emit BioUpdated(msg.sender, bio);
    }

    // ============ Links Management ============
    // Link operations take an explicit `owner` and accept a live delegate, for gasless UX.

    function addLink(address owner, string calldata name, string calldata url) external {
        _requireCanActAs(owner);
        if (!profiles[owner].exists) revert NoProfile(owner);
        if (bytes(name).length == 0 || bytes(url).length == 0) revert EmptyValue();
        if (bytes(name).length > MAX_LINK_NAME_BYTES) {
            revert TooLong(bytes(name).length, MAX_LINK_NAME_BYTES);
        }
        if (bytes(url).length > MAX_LINK_URL_BYTES) {
            revert TooLong(bytes(url).length, MAX_LINK_URL_BYTES);
        }
        if (profileLinks[owner].length >= MAX_LINKS) revert TooManyLinks(MAX_LINKS);

        uint256 index = profileLinks[owner].length;
        profileLinks[owner].push(Link({name: name, url: url}));
        emit LinkAdded(owner, index, name, url);
    }

    /// @dev Swap-and-pop, so removing a link REORDERS the list. Clients must re-read rather than
    ///      assume indices are stable.
    function removeLink(address owner, uint256 index) external {
        _requireCanActAs(owner);
        Link[] storage links = profileLinks[owner];
        if (index >= links.length) revert IndexOutOfBounds(index, links.length);

        links[index] = links[links.length - 1];
        links.pop();

        emit LinkRemoved(owner, index);
    }

    function clearLinks(address owner) external {
        _requireCanActAs(owner);
        delete profileLinks[owner];
        emit LinksCleared(owner);
    }

    function getLinks(address owner) external view returns (Link[] memory) {
        return profileLinks[owner];
    }

    function getLinkCount(address owner) external view returns (uint256) {
        return profileLinks[owner].length;
    }

    // ============ Delegation ============

    /**
     * @notice Let `delegate` act for YOU until `expiry`. One transaction, one prompt, and the app
     *         can then post without asking you again.
     *
     * @param delegate the key the app holds locally. Not you, not the zero address.
     * @param expiry   unix SECONDS at which the authority lapses, at most
     *                 `block.timestamp + MAX_DELEGATION_SECONDS`. **`0` revokes**, and is exactly
     *                 equivalent to `revokeDelegate(delegate)` — so a client that computes an
     *                 expiry and gets 0 does the safe thing rather than the surprising one.
     *
     * @dev Requires no profile. A user can authorise their session key before choosing a display
     *      name; making onboarding order-dependent would cost a second prompt for no benefit.
     *
     *      Re-authorising an existing delegate overwrites the expiry, extending OR shortening it.
     *      That is a same-size storage write, so it moves no deposit.
     *
     *      There is no cap on the number of delegates per owner because each one costs the owner a
     *      storage deposit they can reclaim, and nothing iterates the set — so a large number is
     *      the owner's own expense and nobody else's problem. Nothing enumerable is stored for the
     *      same reason: a client knows its delegate address because it generated it.
     */
    function authorizeDelegate(address delegate, uint64 expiry) external {
        if (delegate == address(0)) revert ZeroDelegate();
        if (delegate == msg.sender) revert SelfDelegate();

        if (expiry == 0) {
            _revokeDelegate(delegate);
            return;
        }

        uint64 nowSeconds = uint64(block.timestamp);
        if (expiry <= nowSeconds) revert ExpiryInPast(expiry, nowSeconds);
        uint64 maximum = nowSeconds + MAX_DELEGATION_SECONDS;
        if (expiry > maximum) revert ExpiryTooFar(expiry, maximum);

        delegateExpiry[msg.sender][delegate] = expiry;
        emit DelegateAuthorized(msg.sender, delegate, expiry);
    }

    /**
     * @notice Withdraw `delegate`'s authority over your account, at once.
     * @dev Idempotent and never reverts on "there was nothing to revoke": a revocation that errors
     *      because the desired state already holds is a UI that tells the user their key is still
     *      live when it is not. Frees the storage item, so the deposit comes back to you.
     *
     *      Only the OWNER may revoke — a delegate cannot revoke itself. Letting it would mean an
     *      account that is not the depositor frees storage and collects the refund, which is the
     *      accounting rule the whole design rests on.
     */
    function revokeDelegate(address delegate) external {
        _revokeDelegate(delegate);
    }

    function _revokeDelegate(address delegate) private {
        delete delegateExpiry[msg.sender][delegate];
        emit DelegateRevoked(msg.sender, delegate);
    }

    /**
     * @notice May `delegate` currently act for `owner`?
     * @dev False for an unauthorised pair, an expired one, and for `isDelegate(u, u)` — a user needs
     *      no delegation to act as themselves, and every `*For` entry point accepts them regardless
     *      of what this returns. Read `delegateExpiry(owner, delegate)` when you need to know
     *      *when* to re-prompt rather than *whether* to.
     */
    function isDelegate(address owner, address delegate) external view returns (bool) {
        return block.timestamp < delegateExpiry[owner][delegate];
    }

    /// @notice Can `actor` act on behalf of `principal`? True when they are the same address, or
    ///         when `actor` holds a live delegation from `principal`.
    /// @dev This is the function every other Plaza contract calls. Keep the signature stable.
    function canActAs(address actor, address principal) external view returns (bool) {
        if (actor == principal) return true;
        return block.timestamp < delegateExpiry[principal][actor];
    }

    // ============ Profile Ownership Transfer ============

    /**
     * @notice Move your profile row and links to a new address.
     * @dev Owner-only, never delegated: this is the one operation that could strand a user out of
     *      their own identity.
     *
     *      ⚠️ WHAT DOES NOT MOVE. Delegations do not (the new address authorises its own keys), and
     *      neither do `PostRegistry` heads, `FollowRegistry` edges or `Voting` rows — every one of
     *      those is keyed by the writer address and only that writer can move it, which is the same
     *      property that stops deposit theft. So this transfers the profile, not the account's
     *      history. Treat it as "I lost the old key's convenience", not as migration.
     */
    function transferProfileOwnership(address newOwner) external onlyProfileOwner {
        if (newOwner == address(0) || newOwner == msg.sender) revert InvalidNewOwner();
        if (profiles[newOwner].exists) revert ProfileExists();

        profiles[newOwner] = Profile({
            owner: newOwner,
            displayName: profiles[msg.sender].displayName,
            bio: profiles[msg.sender].bio,
            exists: true
        });

        Link[] storage oldLinks = profileLinks[msg.sender];
        uint256 linkCount = oldLinks.length;
        for (uint256 i = 0; i < linkCount; i++) {
            profileLinks[newOwner].push(oldLinks[i]);
        }

        delete profiles[msg.sender];
        delete profileLinks[msg.sender];

        emit ProfileOwnershipTransferred(msg.sender, newOwner);
    }

    // ============ Lookup Functions ============

    function getProfile(address owner) external view returns (Profile memory) {
        return profiles[owner];
    }

    function hasProfile(address addr) external view returns (bool) {
        return profiles[addr].exists;
    }

    /// @notice Several profiles in one call.
    /// @dev §3's reason this contract exists: profiles are read for many addresses at once on every
    ///      render. O(owners) and independent of how many profiles exist.
    function getProfiles(address[] calldata owners) external view returns (Profile[] memory result) {
        result = new Profile[](owners.length);
        for (uint256 i = 0; i < owners.length; ++i) {
            result[i] = profiles[owners[i]];
        }
    }
}
