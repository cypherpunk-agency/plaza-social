// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IUserRegistryDelegation {
    function canActAs(address actor, address principal) external view returns (bool);
}

/**
 * @title PostRegistry — the on-chain index for Plaza's Bulletin post chains
 * @notice The one mutable thing in a content-addressed system: "the newest object written by
 *         `writer` in `registry` is at CID c". Everything a user writes is an immutable Bulletin
 *         object linking backwards via `prev` (docs/products-platform/architecture.md §2). This
 *         contract stores no content, only pointers — plus the two positional fields a Bulletin
 *         renewal needs (§4a).
 *
 * WHY AN INDEX CONTRACT EXISTS AT ALL
 * -----------------------------------
 * Bulletin has no list, no prefix scan and no namespace primitive (§3). Given a CID you can fetch
 * an object and walk its `prev` chain, but there is no way to ask "what chains exist" or "what is
 * the newest object in this room". Discovery therefore has to live somewhere enumerable, and a
 * contract head is readable by anonymous `eth_call` — no wallet, no host container, no expiry.
 *
 * THE MODEL — one head per (registry, writer), last-write-wins
 * -----------------------------------------------------------
 * A `registry` is an opaque `bytes32`. The contract never parses it: `mapping(bytes32 => …)` is the
 * entire storage model, which is why there is no per-room, per-board or per-thread struct anywhere
 * in here. Plaza derives ids two ways, both `pure` helpers below:
 *
 *   · `openRegistryId("room:general")` — keccak of a name. Permissionless, no claim, no config
 *     storage. Rooms, threads and the well-known directories ("rooms", "boards") are these.
 *   · `registryIdFor(creator, salt)`   — keccak of (creator, salt). Boards are these, because a
 *     board needs a policy and a policy needs an owner. See CLAIMING below.
 *
 * Each writer owns exactly ONE head per registry, and only that writer can move or clear it. A
 * registry with five concurrent posters therefore has five valid heads and the client merges the
 * branches. A single authoritative head would be simpler to read and would silently drop a branch
 * whenever two people post at once.
 *
 * ⚠️ STORAGE DOES NOT ACCUMULATE, AND THAT IS THE WHOLE POINT
 * -----------------------------------------------------------
 * pallet-revive charges a storage deposit to whoever creates storage and refunds whoever frees it.
 * Because there is one row per (registry, writer) rather than one row per post, the deposit is paid
 * once by a writer on their first post in a registry and then reused forever — the thousandth
 * message in a chat room costs the same storage as the second, which is none. `_writers[registry]`
 * grows by one entry per (registry, writer) pair too, i.e. with exactly the same cardinality as the
 * head rows, so it is bounded by the same argument. No pruning mechanism is needed and none exists
 * (§3, "Decision: do not build pruning initially").
 *
 * Contrast with what this replaces: `ChatChannel.messages[]` and `DMConversation.messages[]` were
 * append-only with no delete path at all, so their deposits were immobilised permanently.
 *
 * Measured: **0.00264 PAS-or-PGAS per NEW 32-byte slot**, ~0.0158 for a fresh head row carrying a
 * 59-character CID, and **0 for every overwrite**. Deposits are payable from PGAS as well as native
 * PAS — verified on chain, so §5's BLOCKING open question is answered and a zero-native-balance user
 * can post. Nothing in this contract was made contingent on that either way; one head per (registry,
 * writer) was chosen for the accounting invariant, and the cost model only makes it cheaper.
 * The one native-only cost on the platform is `map_account`'s 0.20052 PAS hold, which applies to
 * `AccountId32`-derived callers; nothing here assumes one — every identity is a plain H160.
 *
 * Because a writer can only ever touch their OWN row, no writer's growth is paid for by another and
 * no writer can claim another's refund by evicting them. That invariant is load-bearing; every
 * access check in this file exists to preserve it, and it is the reason there is no `clearHeadFor`
 * (see `clearHead`).
 *
 * PERMISSION POLICY — three flavours, per §2
 * -----------------------------------------
 * | Registry      | Policy                | How it is enforced                                  |
 * |---------------|-----------------------|-----------------------------------------------------|
 * | Profile feed  | `OwnerOnly`, or none  | see the note below — usually needs no policy at all |
 * | Board (forum) | `Moderated` or `Open` | admin keeps an allow-list; unclaimed ⇒ Open         |
 * | Room (chat)   | `Open` (the default)  | no config storage, no claim, no deposit             |
 *
 * **A profile feed mostly does not need a policy.** Reads name a (registry, writer) pair, so
 * `headOf(FEED, alice)` is Alice's feed by construction: a squatter writing `_heads[FEED][bob]`
 * creates a row at Bob's own expense that no client ever asks for. `OwnerOnly` exists for the case
 * where a registry is read *as a whole* — an announcement board with a single author — and it is
 * enforced against the claimed registry's admin.
 *
 * CLAIMING — squatting is impossible by construction, not by being early
 * ---------------------------------------------------------------------
 * `claimRegistry` does not take an id; it takes a `salt` and DERIVES the id as
 * `keccak256(abi.encode(msg.sender, salt))`. Nobody can therefore claim an id derived from someone
 * else's address, because the only preimage the contract will ever hash is its own caller's. A
 * first-claim-wins scheme over predictable ids (`keccak("board:solidity")`) would let a stranger
 * spend one storage write to permanently own the policy of every board and profile feed a client
 * knows how to name. That is a cheap, targeted, irreversible griefing vector and this shape removes
 * it entirely rather than pricing it.
 *
 * An unclaimed registry is `Open`. Rooms and threads are never claimed, so they cost no config
 * storage at all.
 *
 * NO CONTRACT-WIDE ADMIN
 * ----------------------
 * No owner, no pause, no upgrade path, no global allowlist, no `selfdestruct`. A pointer store that
 * someone can freeze or rewrite is not a durable pointer store, and a global key would be a
 * censorship handle over every room and board on it.
 *
 * The per-registry `admin` is not a deviation from that: it is scoped to registries whose ids that
 * admin alone could have created, it cannot touch heads (only future write permission), and it can
 * be renounced by `releaseRegistry`. §3 lists "moderation roles / registry policy" as state that
 * "must be authoritative", and a moderated board is a stated product requirement.
 *
 * ⛔ WHAT AN ADMIN CANNOT DO: delete or move anyone's head. Banning a writer stops their FUTURE
 * writes; their existing row stays theirs, because freeing it would pay their deposit to the
 * admin. `HeadRef.allowed` is false for such a row so clients can hide it, and the storage stays
 * where its depositor put it. Moderation here is a write gate, not a delete button. If a board
 * needs content actually gone, the answer is Bulletin retention (§4) — an unrenewed object
 * evaporates on its own in ~14 days.
 *
 * DELEGATION — borrowed from UserRegistry, not reimplemented
 * ---------------------------------------------------------
 * In a Polkadot host container every user-signed contract call is an unconditional wallet modal
 * (§5), so posting a message, opening a thread and bumping a board would be three prompts. The fix
 * is a delegate key the app holds locally, authorised ONCE in `UserRegistry.authorizeDelegate`,
 * with an expiry. This contract asks `UserRegistry.canActAs(msg.sender, writer)` and nothing more —
 * one source of truth for "may this key act for that person", rather than two delegation tables
 * that drift.
 *
 * The direct path (`setHead`, where the writer is the caller) never touches UserRegistry, so a
 * broken or unreachable registry degrades delegated convenience and cannot break posting.
 *
 * WHY `storeBlock` IS IN HERE — it is a DEADLINE, not a locator
 * ------------------------------------------------------------
 * Renewal itself needs nothing from this contract but the CID: `renew`'s `entry` argument is
 * `Enum{ Position{block,index} | ContentHash([u8;32]) }`, so a content hash is accepted directly and
 * CID → content hash is a pure client-side multihash parse. An earlier draft of this contract
 * recorded `(block, index)` because §4a states that "`renew(block, index)` is positional" and a CID
 * "may not be enough to renew". That premise is wrong, verified against the live chain; §4a's
 * schema consequence does not hold and the extrinsic index has been dropped.
 *
 * The store BLOCK is still recorded, for a different and better reason: **content expires at
 * `storeBlock + RetentionPeriod`** (201,600 blocks ≈ 14 days), the chain's index entry is DELETED at
 * expiry, and a missed renewal is unrecoverable. Without the store block a client cannot say when
 * anything is about to lapse, which is precisely what §4a's "keep this alive" screen has to show.
 * A deadline is honest; a checkmark would not be.
 *
 * `RetentionPeriod` is deliberately NOT a constant in here. It is chain configuration that
 * governance can change, and this contract has no upgrade path — baking it in would mean a wrong
 * deadline forever. Clients read it from the chain and add.
 *
 * `storeBlock` is supplied by the writer and the contract cannot verify it. That is acceptable: a
 * wrong value only misleads that writer's own expiry countdown. Pass 0 when unknown.
 *
 * ⚠️ A renewal RESETS the deadline, and the row does not know. After a renewal the writer refreshes
 * it by calling `setHead` again with the SAME cid and the new block — re-announcing a cid is an
 * explicitly valid bump. A THIRD-PARTY renewal (§4a's donation mechanic) cannot update the row,
 * because that would mean writing someone else's storage. A donor announces it in their OWN row
 * instead: `setHead(openRegistryId("renewals"), …, cid, "", renewalBlock)`. No new machinery, and
 * it keeps the deposit invariant intact.
 */
/// @custom:cdm @plaza-social/post-registry
contract PostRegistry {
    // ============ Types ============

    /**
     * @notice Who may set a head in a registry.
     * @dev `Open` is 0 so that an UNCLAIMED registry — `admin == address(0)`, no storage written —
     *      reads as open without a sentinel. Claiming is opt-in; the permissionless case is free.
     */
    enum Policy {
        Open,       // anyone may write their own row (chat rooms, threads, directories)
        Moderated,  // admin + allow-listed writers only (boards)
        OwnerOnly   // the admin only (single-author feeds)
    }

    /// @notice One writer's current pointer in one registry, as returned by every read function.
    /// @param cid        the newest object in this writer's branch of the chain
    /// @param prev       the object it links back to; empty at the start of a chain
    /// @param storeBlock Bulletin block that carried the store extrinsic (`result.blockNumber`).
    ///                   The content expires at `storeBlock + RetentionPeriod`; see the header.
    /// @param movedAt    `block.timestamp` of the write, in SECONDS. Clients wanting epoch
    ///                   milliseconds multiply by 1000.
    /// @param by         the writer this row belongs to
    /// @param allowed    whether `by` may still write here under the registry's current policy.
    ///                   False means "banned after the fact" — the row is real, the content is
    ///                   real, and a moderated client should hide it. Always true for an open or
    ///                   unclaimed registry.
    ///
    /// @dev The timestamp field is NOT called `at`, deliberately. On ethers v6 a decoded struct is
    ///      a `Result`, which subclasses Array — so `ref.at` resolves to `Array.prototype.at` and
    ///      silently hands the caller a *function* instead of a number.
    struct HeadRef {
        string cid;
        string prev;
        uint64 storeBlock;
        uint64 movedAt;
        address by;
        bool allowed;
    }

    /// @dev Storage form. `movedAt == 0` means "no entry". `index` is the writer's slot in
    ///      `_writers[registry]`. The three numeric fields pack into a single 32-byte slot
    ///      (64 + 64 + 32 = 160 bits), so recording the store block costs nothing that was not
    ///      already being paid for — and at 0.00264 PAS-or-PGAS per NEW slot, a field that fits into
    ///      a slot already being written is genuinely free.
    struct Head {
        string cid;
        string prev;
        uint64 storeBlock;
        uint64 movedAt;
        uint32 index;
    }

    /// @dev Per-registry policy. `admin == address(0)` means unclaimed, i.e. Open with no storage.
    struct RegistryConfig {
        address admin;
        Policy policy;
    }

    // ============ Constants ============

    /// @notice Upper bound on a CID string. A CIDv1 base32 (raw + blake2b-256) is 59 characters;
    ///         128 leaves room for every codec/base combination Bulletin can hand back without
    ///         letting a writer park arbitrary bytes in the index.
    uint256 public constant MAX_CID_BYTES = 128;

    /// @notice How many heads `getHeads(registry)` returns without paging.
    uint256 public constant DEFAULT_PAGE = 64;

    // ============ State ============

    /// PLAZA-USER-REGISTRY-ADDRESS — one of three pinned sites; grep the tag before editing.
    address internal constant USER_REGISTRY_ADDRESS = 0xfD00289e765414C0281EFC35335b6453F055FBD7;

    /**
     * @notice The delegation authority. Consulted ONLY when a caller writes on someone else's
     *         behalf, and a compile-time constant, so this contract has no configurable trust
     *         surface at all.
     * @dev Pinned rather than passed in for two independent reasons.
     *
     *      (1) `cdm deploy` hard-codes empty constructor calldata (`data = new Uint8Array(0)`,
     *      verified 2026-07-30 in cdm-cli 0.8.26 `ContractDeployer.dryRunDeploy`), so a
     *      `constructor(address)` decodes `address(0)`, reverts, and fails every other contract in
     *      the same deploy chunk.
     *
     *      (2) More importantly, pinning is semantically right. Resolving
     *      the CDM name `plaza-social/user-registry` through the CDM registry instead would follow the *latest*
     *      version, and cdm's deploy salt includes the version — so a redeploy lands at a new
     *      address with EMPTY storage and every delegation this contract honours would be silently
     *      invalidated at once. Delegation state lives in one specific instance; name that instance.
     *
     *      ⚠️ Pinned to **v0**. A future `cdm deploy` bumping UserRegistry to v1 leaves this on v0 —
     *      still working, still holding the delegations, but not what "I redeployed" implies.
     *      `deployments.json` must agree. See architecture.md §0 and gotchas §Contract toolchain.
     */
    IUserRegistryDelegation public constant userRegistry =
        IUserRegistryDelegation(USER_REGISTRY_ADDRESS);

    /// registry => writer => head
    mapping(bytes32 => mapping(address => Head)) private _heads;

    /// registry => writers that currently hold a head there. Appended on a writer's first write,
    /// swap-and-popped on `clearHead`, so it is exactly the live set and never a graveyard.
    mapping(bytes32 => address[]) private _writers;

    /// registry => policy. Absent for unclaimed registries.
    mapping(bytes32 => RegistryConfig) private _registries;

    /// registry => writer => may write. Only consulted under `Policy.Moderated`.
    mapping(bytes32 => mapping(address => bool)) private _allowedWriters;

    // ============ Events ============

    /**
     * @notice A head moved. This is the subscription surface: one `Revive.ContractEmitted` stream
     *         carries every registry and clients filter on `registry` or `group`.
     * @param registry the chain whose head moved
     * @param by       the writer it is credited to — the authorising user, never the signing key
     * @param group    the registry this announcement should also be delivered alongside; defaults
     *                 to `registry` itself. A thread sets its group to its BOARD, so one board
     *                 subscription hears the board's own chain and every reply on it.
     *
     * @dev ⚠️ Do not build the read path on this. `eth_getLogs` cannot see events from
     *      host-submitted contract calls: the host submits them as native `Revive` extrinsics
     *      producing `Revive.ContractEmitted` in `System.Events` and nothing in the ETH log index
     *      (§8). Delegate-signed calls DO produce ETH logs, so the stream is real but incomplete.
     *      Poll the read functions; treat events as a latency hint.
     */
    event HeadSet(
        bytes32 indexed registry,
        address indexed by,
        bytes32 indexed group,
        string cid,
        string prev,
        uint64 storeBlock,
        uint64 movedAt
    );

    /// @notice A writer withdrew their head and reclaimed the storage deposit it held.
    event HeadCleared(bytes32 indexed registry, address indexed by, bytes32 indexed group);

    /// @notice A registry was claimed. `admin` is necessarily the caller that derived the id.
    event RegistryClaimed(bytes32 indexed registry, address indexed admin, Policy policy);
    event RegistryPolicyChanged(bytes32 indexed registry, Policy policy);
    event RegistryAdminTransferred(bytes32 indexed registry, address indexed from, address indexed to);
    /// @notice The admin renounced the registry; it reverts to `Open` and the config slot is freed.
    event RegistryReleased(bytes32 indexed registry, address indexed admin);
    event WriterAllowed(bytes32 indexed registry, address indexed writer, bool allowed);

    // ============ Errors ============

    error CidEmpty();
    error CidTooLong(uint256 length, uint256 maximum);
    error NoHead(bytes32 registry, address writer);

    /// @dev `caller` is neither `writer` nor a live delegate of theirs in UserRegistry.
    error NotDelegate(address writer, address caller);
    /// @dev `writer` may not post in this registry under its current policy.
    error NotAllowedToWrite(bytes32 registry, address writer);

    error AlreadyClaimed(bytes32 registry, address admin);
    error NotRegistryAdmin(bytes32 registry, address caller);
    error ZeroAddress();
    error UserRegistryNotDeployed(address expected);

    // ============ Constructor ============

    /// @dev Takes no arguments — it cannot, see `userRegistry`. It exists only to fail the DEPLOY
    ///      when nothing lives at the pinned address, instead of letting every delegated write
    ///      revert later with an ABI-decode error that names nothing. A pinned address is
    ///      network-specific, and that is the exact class of silent failure that has cost the most
    ///      time on this stack.
    ///
    ///      Tests must therefore place UserRegistry's code at `USER_REGISTRY_ADDRESS` *before*
    ///      deploying this — `test/helpers/pinnedUserRegistry.js` does it with `hardhat_setCode`.
    constructor() {
        if (USER_REGISTRY_ADDRESS.code.length == 0) revert UserRegistryNotDeployed(USER_REGISTRY_ADDRESS);
    }

    // ============ Registry ids (pure) ============

    /**
     * @notice The id of a claimable registry: `keccak256(abi.encode(creator, salt))`.
     * @dev Pure and free, so a client can compute the id of a board it is about to claim, or of one
     *      it already knows the creator and salt of. `abi.encode` rather than `encodePacked`
     *      because packed encoding of (address, bytes32) is fixed-width here but the habit of
     *      packing hash preimages is how collisions get introduced later.
     */
    function registryIdFor(address creator, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt));
    }

    /**
     * @notice The id of an unclaimable, permanently-open registry: `keccak256(name)`.
     * @dev For rooms, threads and the well-known directories. These can never be claimed — an id
     *      produced this way is not in the image of `registryIdFor` for any caller (finding a
     *      collision would be a keccak preimage attack), so `Open` is not merely their default
     *      policy, it is their only possible one. That is the intended property for chat.
     */
    function openRegistryId(string calldata name) external pure returns (bytes32) {
        return keccak256(bytes(name));
    }

    // ============ Registry policy ============

    /**
     * @notice Claim a registry you derive, and set its policy. Returns the derived id.
     * @param salt any 32 bytes; the app usually uses `keccak256(utf8(boardName))`.
     * @param policy `Open`, `Moderated` or `OwnerOnly`.
     * @dev The id is derived from `msg.sender`, so this cannot claim anybody else's namespace and
     *      nobody can claim yours. Reverts if already claimed — including by you, so a client that
     *      re-runs onboarding sees a clear error instead of silently resetting a live board's
     *      policy. Use `setRegistryPolicy` to change it.
     *
     *      Costs one storage slot of deposit, paid by the claimer and refundable via
     *      `releaseRegistry`. Rooms and threads never call this.
     */
    function claimRegistry(bytes32 salt, Policy policy) external returns (bytes32 registry) {
        registry = registryIdFor(msg.sender, salt);
        RegistryConfig storage config = _registries[registry];
        if (config.admin != address(0)) revert AlreadyClaimed(registry, config.admin);

        config.admin = msg.sender;
        config.policy = policy;

        emit RegistryClaimed(registry, msg.sender, policy);
    }

    /// @notice Change a claimed registry's policy. Same-size write, so it moves no deposit.
    function setRegistryPolicy(bytes32 registry, Policy policy) external {
        RegistryConfig storage config = _requireAdmin(registry);
        config.policy = policy;
        emit RegistryPolicyChanged(registry, policy);
    }

    /**
     * @notice Hand a claimed registry's policy control to someone else.
     * @dev Note the id stays derived from the ORIGINAL creator — ids are permanent, admins are not.
     *      A client must therefore read `registryConfig` to learn the current admin rather than
     *      inferring it from the id.
     */
    function transferRegistryAdmin(bytes32 registry, address newAdmin) external {
        if (newAdmin == address(0)) revert ZeroAddress();
        RegistryConfig storage config = _requireAdmin(registry);
        address previous = config.admin;
        config.admin = newAdmin;
        emit RegistryAdminTransferred(registry, previous, newAdmin);
    }

    /**
     * @notice Renounce a claimed registry. It reverts to `Open` and the config slot is freed, so
     *         pallet-revive refunds the deposit to the caller — who is the admin, who paid it.
     * @dev Deliberately does NOT clear `_allowedWriters`: that is an unbounded loop and the flags
     *      are inert while the policy is `Open`. Only the original creator could ever re-claim this
     *      id, and the stale flags would be their own former grants, so nothing is smuggled in.
     *      Unset them first if that matters.
     *
     *      Heads are untouched. Releasing a registry cannot free anybody's row, for the usual
     *      reason.
     */
    function releaseRegistry(bytes32 registry) external {
        _requireAdmin(registry);
        delete _registries[registry];
        emit RegistryReleased(registry, msg.sender);
    }

    /// @notice Allow or disallow a writer under `Policy.Moderated`.
    /// @dev Costs the ADMIN a storage slot per allowed writer, refunded when they set it false.
    ///      That is why `Moderated` is opt-in per board rather than the default: an open room
    ///      should not make its creator pay a deposit per participant.
    function setWriterAllowed(bytes32 registry, address writer, bool allowed) external {
        if (writer == address(0)) revert ZeroAddress();
        _requireAdmin(registry);
        if (allowed) {
            _allowedWriters[registry][writer] = true;
        } else {
            delete _allowedWriters[registry][writer];
        }
        emit WriterAllowed(registry, writer, allowed);
    }

    // ============ Writes ============

    /**
     * @notice Point your row in `registry` at `cid`.
     * @param registry   the chain to bump
     * @param group      an additional event routing key; `bytes32(0)` means `registry` itself
     * @param cid        the new head
     * @param prev       the object it links back to; empty at the start of a chain
     * @param storeBlock Bulletin block of the store extrinsic, from which the client computes the
     *                   expiry deadline `storeBlock + RetentionPeriod`. 0 if unknown.
     *
     * @dev Re-announcing the same `cid` is a valid bump: it refreshes `movedAt`, records a new
     *      `storeBlock` after a renewal, and re-emits. That is the whole "refresh" mechanism — and
     *      because the row already exists it creates no storage, so it costs no deposit.
     */
    function setHead(
        bytes32 registry,
        bytes32 group,
        string calldata cid,
        string calldata prev,
        uint64 storeBlock
    ) external {
        _setHead(msg.sender, registry, group, cid, prev, storeBlock);
    }

    /**
     * @notice `setHead` on behalf of `writer`. The head lands in `writer`'s row and `HeadSet.by` is
     *         `writer`, so the post is credited to them and not to whichever key signed.
     * @dev Callable by `writer` themselves — in which case it is exactly `setHead` — or by a live
     *      delegate of theirs per `UserRegistry.canActAs`. Everything else reverts.
     *
     *      ⚠️ DEPOSITS. pallet-revive charges the storage deposit to the account that signs, so a
     *      delegate's first write in a registry is paid for by the DELEGATE, while `clearHead`
     *      refunds it to the WRITER (only they can call it). Both keys belong to the same person,
     *      so that is a transfer between their own pockets. What matters is the invariant it does
     *      not break: a delegate can only ever touch the one user who authorised them, so no
     *      stranger's storage can be grown or freed by anybody.
     */
    function setHeadFor(
        address writer,
        bytes32 registry,
        bytes32 group,
        string calldata cid,
        string calldata prev,
        uint64 storeBlock
    ) external {
        if (writer != msg.sender && !userRegistry.canActAs(msg.sender, writer)) {
            revert NotDelegate(writer, msg.sender);
        }
        _setHead(writer, registry, group, cid, prev, storeBlock);
    }

    /**
     * @notice Withdraw your head for `registry` and reclaim the storage deposit it holds.
     * @param group event routing key as in `setHead`; `bytes32(0)` means `registry`.
     * @dev Frees every slot the writer created, including their entry in `_writers[registry]`, so
     *      pallet-revive refunds the deposit to the caller. Only ever touches the caller's own row
     *      plus one `index` field of the writer swapped into their place — a same-size write that
     *      moves no deposit.
     *
     *      ⛔ THERE IS DELIBERATELY NO `clearHeadFor`, AND NO ADMIN CLEAR. Clearing frees storage
     *      and pallet-revive pays the refund to whoever freed it, so a delegated or moderated clear
     *      would hand someone else the writer's deposit — the one form of deposit theft this design
     *      is built to make impossible. It would also let a leaked convenience key destroy pointers
     *      rather than merely move them. Delegation is for the hot path; withdrawal stays with the
     *      owner.
     *
     *      Clearing is also NOT deletion of content: the Bulletin objects remain until their lease
     *      lapses. It withdraws the pointer.
     */
    function clearHead(bytes32 registry, bytes32 group) external {
        Head storage head = _heads[registry][msg.sender];
        if (head.movedAt == 0) revert NoHead(registry, msg.sender);

        address[] storage writers = _writers[registry];
        uint256 index = head.index;
        uint256 last = writers.length - 1;
        if (index != last) {
            address moved = writers[last];
            writers[index] = moved;
            _heads[registry][moved].index = uint32(index);
        }
        writers.pop();
        delete _heads[registry][msg.sender];

        emit HeadCleared(registry, msg.sender, group == bytes32(0) ? registry : group);
    }

    // ============ Reads ============

    /// @notice A registry's policy. `admin == address(0)` means unclaimed, which is `Open`.
    function registryConfig(bytes32 registry) external view returns (address admin, Policy policy) {
        RegistryConfig storage config = _registries[registry];
        return (config.admin, config.policy);
    }

    /// @notice May `writer` set a head in `registry` right now?
    /// @dev True for every writer in an open or unclaimed registry. Does not consider delegation —
    ///      a delegate writes as its principal, so ask about the principal.
    function canWrite(bytes32 registry, address writer) external view returns (bool) {
        RegistryConfig storage config = _registries[registry];
        return _isAllowed(registry, writer, config.policy, config.admin);
    }

    /// @notice One writer's head for `registry`. `movedAt == 0` means they hold none. O(1).
    function headOf(bytes32 registry, address writer) external view returns (HeadRef memory) {
        RegistryConfig storage config = _registries[registry];
        return _headRef(registry, writer, config.policy, config.admin);
    }

    /**
     * @notice The heads of an explicit list of writers, in the order given.
     * @dev O(writers) and independent of how big the registry is. This is the FEED read: take
     *      `FollowRegistry.getFollowing(user)` and hand it straight here, one `eth_call` for the
     *      whole timeline instead of one per followee. Writers with no head come back with
     *      `movedAt == 0` rather than being skipped, so the result lines up index-for-index with
     *      the input.
     */
    function headsOf(bytes32 registry, address[] calldata writers)
        external
        view
        returns (HeadRef[] memory refs)
    {
        RegistryConfig storage config = _registries[registry];
        Policy policy = config.policy;
        address admin = config.admin;
        refs = new HeadRef[](writers.length);
        for (uint256 i = 0; i < writers.length; ++i) {
            refs[i] = _headRef(registry, writers[i], policy, admin);
        }
    }

    /**
     * @notice The candidate heads for `registry`, newest first, capped at `DEFAULT_PAGE`.
     * @dev The everyday read for a room or board. Several heads is normal, not an error:
     *      concurrent writers each hold one and the client merges the branches.
     *
     *      When `writerCount` exceeds `DEFAULT_PAGE` this returns the 64 NEWEST, not the first 64 —
     *      the whole set is sorted before the cut. Older branches that fall outside are almost
     *      always ancestors of a newer head, so the backwards walk still reaches them.
     */
    function getHeads(bytes32 registry) external view returns (HeadRef[] memory refs) {
        (refs, ) = getHeadsPaged(registry, 0, DEFAULT_PAGE);
    }

    /**
     * @notice A page of `registry`'s heads, newest first, with the total so a caller knows to ask
     *         again.
     * @dev The ordering is global, not per-page: the full set is sorted before the slice is taken,
     *      so page 2 really is the 65th-onward newest. That costs an insertion sort over every
     *      writer in the registry on EVERY call, including the paged ones — paging does not make
     *      this cheaper, it only makes the response smaller. It is a view, so nobody pays gas, but
     *      an RPC's `eth_call` gas cap is a real ceiling: somewhere in the high hundreds of
     *      concurrent writers in a SINGLE registry this stops being callable.
     *      `getHeadsUnsorted` exists so that is never a dead end.
     */
    function getHeadsPaged(bytes32 registry, uint256 offset, uint256 limit)
        public
        view
        returns (HeadRef[] memory refs, uint256 total)
    {
        address[] storage writers = _writers[registry];
        total = writers.length;
        if (offset >= total || limit == 0) return (new HeadRef[](0), total);

        uint256 end = offset + limit;
        if (end > total) end = total;

        RegistryConfig storage config = _registries[registry];
        Policy policy = config.policy;
        address admin = config.admin;

        HeadRef[] memory all = new HeadRef[](total);
        for (uint256 i = 0; i < total; ++i) {
            all[i] = _headRef(registry, writers[i], policy, admin);
        }

        // Insertion sort, descending by `movedAt`. Stable, so writers that landed in the same block
        // keep their write order rather than shuffling between otherwise identical calls.
        for (uint256 i = 1; i < total; ++i) {
            HeadRef memory key = all[i];
            uint256 j = i;
            while (j > 0 && all[j - 1].movedAt < key.movedAt) {
                all[j] = all[j - 1];
                --j;
            }
            all[j] = key;
        }

        refs = new HeadRef[](end - offset);
        for (uint256 i = 0; i < refs.length; ++i) {
            refs[i] = all[offset + i];
        }
    }

    /**
     * @notice A page of `registry`'s heads in first-write order, NOT newest first. O(limit): it
     *         never sorts and never touches a writer outside the page.
     * @dev The safety valve. This contract exists so an anonymous visitor can read Plaza with no
     *      wallet, and a read that can grow uncallable would quietly break that promise for the
     *      busiest registry on the chain — the one that matters most. So there is always a read
     *      whose cost depends on `limit` and nothing else. The caller sorts by `movedAt`
     *      client-side, which is cheap and which the client already does when merging branches.
     */
    function getHeadsUnsorted(bytes32 registry, uint256 offset, uint256 limit)
        external
        view
        returns (HeadRef[] memory refs, uint256 total)
    {
        address[] storage writers = _writers[registry];
        total = writers.length;
        if (offset >= total || limit == 0) return (new HeadRef[](0), total);

        uint256 end = offset + limit;
        if (end > total) end = total;

        RegistryConfig storage config = _registries[registry];
        Policy policy = config.policy;
        address admin = config.admin;

        refs = new HeadRef[](end - offset);
        for (uint256 i = 0; i < refs.length; ++i) {
            refs[i] = _headRef(registry, writers[offset + i], policy, admin);
        }
    }

    /// @notice How many writers currently hold a head for `registry`. 0 means it is unwritten.
    function writerCount(bytes32 registry) external view returns (uint256) {
        return _writers[registry].length;
    }

    /// @notice The writers holding a head for `registry`, in first-write order, paged. O(limit).
    /// @dev For a client that would rather poll known writers with `headsOf` than read pages.
    function writersOf(bytes32 registry, uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory page, uint256 total)
    {
        address[] storage writers = _writers[registry];
        total = writers.length;
        if (offset >= total || limit == 0) return (new address[](0), total);
        uint256 end = offset + limit;
        if (end > total) end = total;
        page = new address[](end - offset);
        for (uint256 i = 0; i < page.length; ++i) {
            page[i] = writers[offset + i];
        }
    }

    // ============ Internal ============

    function _requireAdmin(bytes32 registry) private view returns (RegistryConfig storage config) {
        config = _registries[registry];
        if (config.admin != msg.sender) revert NotRegistryAdmin(registry, msg.sender);
    }

    /// @dev The single permission gate. Short-circuits with NO extra storage read for the open and
    ///      unclaimed cases, which is every chat room and every thread, i.e. the hot path.
    function _isAllowed(bytes32 registry, address writer, Policy policy, address admin)
        private
        view
        returns (bool)
    {
        if (admin == address(0)) return true;           // unclaimed ⇒ open
        if (policy == Policy.Open) return true;
        if (writer == admin) return true;
        if (policy == Policy.OwnerOnly) return false;
        return _allowedWriters[registry][writer];       // Moderated
    }

    /// @dev `writer` is the account the head is credited to — `msg.sender` on the direct path and
    ///      the authorising user on the delegated one. It is NEVER derived from anything the caller
    ///      can assert without the delegation check having agreed first.
    function _setHead(
        address writer,
        bytes32 registry,
        bytes32 group,
        string calldata cid,
        string calldata prev,
        uint64 storeBlock
    ) private {
        uint256 cidLength = bytes(cid).length;
        if (cidLength == 0) revert CidEmpty();
        if (cidLength > MAX_CID_BYTES) revert CidTooLong(cidLength, MAX_CID_BYTES);
        uint256 prevLength = bytes(prev).length;
        if (prevLength > MAX_CID_BYTES) revert CidTooLong(prevLength, MAX_CID_BYTES);

        RegistryConfig storage config = _registries[registry];
        if (!_isAllowed(registry, writer, config.policy, config.admin)) {
            revert NotAllowedToWrite(registry, writer);
        }

        Head storage head = _heads[registry][writer];
        if (head.movedAt == 0) {
            // First write by this writer in this registry: one entry is appended to the writer
            // list. The row belongs to `writer`; the deposit is charged by pallet-revive to
            // whoever signed, which is `writer` themselves unless they delegated. No third party's
            // storage grows either way.
            _writers[registry].push(writer);
            head.index = uint32(_writers[registry].length - 1);
        }
        head.cid = cid;
        head.prev = prev;
        head.storeBlock = storeBlock;
        head.movedAt = uint64(block.timestamp);

        emit HeadSet(
            registry,
            writer,
            group == bytes32(0) ? registry : group,
            cid,
            prev,
            storeBlock,
            head.movedAt
        );
    }

    function _headRef(bytes32 registry, address writer, Policy policy, address admin)
        private
        view
        returns (HeadRef memory)
    {
        Head storage head = _heads[registry][writer];
        return HeadRef({
            cid: head.cid,
            prev: head.prev,
            storeBlock: head.storeBlock,
            movedAt: head.movedAt,
            by: writer,
            allowed: _isAllowed(registry, writer, policy, admin)
        });
    }
}
