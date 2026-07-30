# Contracts - Claude Code Guide

Smart contracts for Plaza on the Polkadot Products platform. Four contracts, no factories.

Design brief: `docs/products-platform/architecture.md` (§2 content model, §3 where state lives,
§4a retention, §5 signing). Read it before changing anything here — every non-obvious choice in
these files is traceable to a section of it.

## Commands

```bash
npm test                    # 136 tests, plain solc on the in-process EVM
npm run compile             # EVM compile (tests only)
npm run build:cdm           # PolkaVM compile via resolc — this is what gets deployed
npm run deploy:devnet -- --suri "$SEED_PHRASE"
node scripts/verify-deployment.mjs   # what is actually on chain
node scripts/probe-personhood.mjs    # why personhood cannot gate a write
```

Run a single test: `npx hardhat test --config hardhat.evm.config.js test/PostRegistry.test.js`
(the `--config` is not optional — the default config is the PolkaVM one and cannot run tests).

⚠️ **`npm run deploy:devnet` redeploys EVERY contract under `contracts/`**, at new addresses, as new
versions. There is no unchanged-code skip and no subset flag. It will orphan live instances along with
their storage. To deploy a subset, move the others out of `contracts/` for that one command — a
dot-directory such as `contracts/.isolate/` is not scanned. Do not leave them there: an isolated
contract has no artifact, so **its tests silently stop running**.

**Never deploy with `hardhat run --network`.** The funded account is sr25519 and cannot sign an
Ethereum transaction.

## Contract Hierarchy

```
UserRegistry (profiles, delegation with expiry)      0xfD00289e…F055FBD7  v0
     ^ pinned as a compile-time constant by all three below
     |
     +-- PostRegistry    head pointer per (registry, writer)   0xF6daC4BC…3722f8c9
     +-- FollowRegistry  follow graph, enumerable both ways    0x96A3274F…B9b7032E
     +-- Voting          tallies keyed by CID, or (registry,CID)  0x948c71E7…B96A14C0
```

**None of the three takes a constructor argument.** `cdm deploy` hard-codes empty constructor calldata
(`data = new Uint8Array(0)`), so a `constructor(address)` decodes `address(0)`, reverts, and fails
every other contract in the same deploy chunk. Pinning is also the correct semantics: resolving the CDM
name at call time would follow the *latest* version, and cdm's salt includes the version, so a redeploy
lands at a new address with empty storage — silently invalidating every delegation at once.

Each constructor reverts `UserRegistryNotDeployed` if the pinned address holds no code, so a
wrong-network deploy fails immediately rather than as opaque delegated-write reverts later. Tests must
therefore place UserRegistry's code there first — `test/helpers/pinnedUserRegistry.js`, which also
`hardhat_reset`s, because `setCode` leaves storage behind and a fixed address is shared across tests.

To move the pin: grep `PLAZA-USER-REGISTRY-ADDRESS`, edit all three, recompile, redeploy, and update
`deployments.json`.

There is nothing per-room, per-board or per-thread to deploy. A chat room, a board and a thread are
all just `bytes32` registry ids inside the one `PostRegistry`.

## The one idea

Post bodies live on Bulletin as immutable objects chained backwards by `prev`. The only mutable
thing is a **head pointer** per (registry, writer), and that is all `PostRegistry` stores.

**Storage therefore does not accumulate.** The deposit is paid once by a writer on their first post
in a registry and reused forever — the thousandth message in a room costs no new storage. Measured
cost: **0.00264 PAS-or-PGAS per new 32-byte slot**, ~0.0158 for a fresh head row with a 59-char CID,
and **0 for every overwrite**. Do not add per-post arrays; that is the mistake this replaced.

Storage deposits are payable from **PGAS as well as native PAS** (verified on chain: 21 live
`Revive::StorageDepositReserve` holds denominated in PGAS; 128 accounts holding zero native PAS
allocate fresh contract storage). No funding faucet is needed. The one native-only cost is
`map_account`'s 0.20052 PAS hold, which affects `AccountId32`-derived callers; nothing in these
contracts assumes one, and locally-generated H160 delegate keys never need mapping.

## Contract Details

### UserRegistry.sol
- Profile: `displayName` (≤50 bytes), `bio` (≤500), links (≤10, name ≤50, url ≤200)
- **Delegation has an expiry**: `authorizeDelegate(delegate, expiry)` / `revokeDelegate(delegate)`,
  capped at `MAX_DELEGATION_SECONDS` (90 days). Passing `expiry == 0` revokes. Over the cap it
  **reverts rather than clamping**, so a client that guesses high fails loudly.
- `canActAs(actor, principal)` is the function every other contract calls. Keep it stable.
- **No `sessionPublicKeys`** — DMs are dropped (architecture §7).
- **No `delegateToOwner` / `resolveToOwner`.** Delegate addresses are unique per owner, not
  globally, because derived keys collide across profiles. With one address able to serve two owners
  a reverse lookup can only guess, and a wrong guess attributes a post to the wrong person. Every
  delegated call therefore names its principal: `setHeadFor`, `followFor`, `voteFor`, `addLink(owner,…)`.
- Owner-only, never delegable: `setDisplayName`, `setBio`, `transferProfileOwnership`,
  `revokeDelegate`.

### PostRegistry.sol
- `setHead(registry, group, cid, prev, storeBlock)` — writes the caller's own row.
  `setHeadFor(writer, …)` does the same for a principal you hold a live delegation from.
- `clearHead(registry, group)` frees your row and returns your deposit. **There is deliberately no
  `clearHeadFor` and no admin clear**: freeing storage pays the refund to whoever freed it, so a
  delegated or moderated clear would be deposit theft. Read the comment before adding one.
- `storeBlock` is the Bulletin block of the store extrinsic. It is **not** needed to renew — `renew`
  accepts a content hash directly — it is there so a client can compute the expiry deadline
  `storeBlock + RetentionPeriod`. `RetentionPeriod` is not a constant in the contract: it is
  governance-changeable chain config and the contract has no upgrade path.
- Policies: unclaimed ⇒ `Open` (rooms, threads, directories; no config storage at all),
  `Moderated` (admin + allow-list), `OwnerOnly` (admin only).
- `claimRegistry(salt, policy)` **derives** the id as `keccak256(abi.encode(msg.sender, salt))` and
  returns it. Squatting is impossible rather than merely expensive: nobody can claim an id derived
  from another address. Open ids are `keccak256(name)` and can never be claimed.
- Reads: `headOf` (O(1)), `headsOf(registry, writers[])` (the feed read), `getHeads` /
  `getHeadsPaged` (sorted newest-first, cost grows with the whole writer set),
  `getHeadsUnsorted(offset, limit)` (**O(limit) — the safety valve; keep it**), `writersOf`,
  `writerCount`, `canWrite`, `registryConfig`. All work for an anonymous `eth_call`.
- `HeadRef.allowed` is false for a writer banned after the fact. Moderation is a write gate, not a
  delete button — the row stays with its depositor and clients hide it.
- No contract-wide owner, pause or upgrade path. The per-registry `admin` is scoped to ids only that
  admin could have created and can be renounced with `releaseRegistry`.

### FollowRegistry.sol
- `follow` / `unfollow` act as `msg.sender`; `followFor` / `unfollowFor` name a principal.
- Reads are unchanged from the previous version, deliberately: `getFollowing`, `getFollowers`,
  `isFollowing`, counts, plus `getFollowingPaged` / `getFollowersPaged`.
- The feed is two calls: `getFollowing(user)` → `PostRegistry.headsOf(FEED, following)`.

### Voting.sol
- Entity ids: `entityIdOfCid(cid)` for one global tally per post, `entityIdInRegistry(registry, cid)`
  for a separate tally per board. The contract does not choose; the app picks per surface.
- `vote` / `voteFor` / `removeVote`, `getTally`, `getScore`, `getTallies`, `getUserVotes`.
- Voting gates on `UserRegistry.hasProfile`. ⛔ **Do not replace this with the personhood precompile.**
  It resolves an address to a person via `AccountToAlias`, which is empty in all three places it exists
  and whose Asset Hub binding fee is unset, so it returns 0 for every address. A gate on it rejects
  everyone. This is a limit on what *Solidity* can see: personhood itself is readable from the
  Individuality chain (`PeopleLite.LitePeople`, 151 entries, keyed by account) and the **frontend**
  should gate on that. `scripts/probe-personhood.mjs` shows both halves.
- Votes are the **only** thing in Plaza that accrues storage — one slot per (entity, voter), paid by
  the voter and refunded by `removeVote`. Hence no `removeVoteFor`.
- A tally keyed on a CID survives renewal (the CID does not change) but not an edit (a new object is
  a new CID and a new, empty tally).

## Removed, and why

| Removed | Why |
|---|---|
| `OnChainChat.sol` | Superseded and never deployed. |
| `ChatChannel.sol`, `ChannelRegistry.sol` | Per-instance factory pair; a room is now a registry id. `messages[]` was append-only with no delete path, immobilising its deposit permanently. |
| `DMConversation.sol`, `DMRegistry.sol` | Encrypted DMs dropped entirely (architecture §7). |
| `posts/UserPosts.sol`, `posts/ForumThread.sol`, `posts/Replies.sol` | Collapsed into the one Post type (§2). Their positional `(contract, entityType, index)` identity is what `Voting` no longer needs. |
| `lib/Moderation.sol` | Was unused by every contract. Not adopted: its `Permissions` struct is shaped for one-owner-per-deployment, its events carry no registry id so they are unroutable in a shared contract, and its third `admins` tier would cost a deposit per admin per registry for no product requirement. `PostRegistry` implements the two roles it actually needs inline. |
| `scripts/seed-test-data.js` | Seeded channels and threads that no longer exist. A head pointing at a Bulletin object that was never stored is a dangling pointer, so seeding now belongs with the fake Bulletin backend, not with a contract script. |
| `scripts/migrate-channels.js`, `deploy-channel-registry.js`, `deploy-forum-thread.js` | Deployed removed contracts. |

## Testing

Tests in `test/` using Hardhat + Chai:
- `UserRegistry.test.js` — profiles, links, **delegation expiry**, per-owner delegate uniqueness,
  ownership transfer
- `PostRegistry.test.js` — heads, clearing and index integrity, delegated writes, **all three
  permission policies**, anti-squatting, **every read path** including anonymous `eth_call`
- `FollowRegistry.test.js` — edges both ways, swap-and-pop integrity, delegated follows, and the
  two-call feed composition with `PostRegistry`
- `Voting.test.js` — both entity-id derivations, vote changes, delegated voting, batch reads

## Configuration

**Two Hardhat configs on purpose, with separate artifact directories.**

- `hardhat.config.cjs` — **PolkaVM**, solc 0.8.28 + `resolc`, optimizer 200 runs. What `cdm` builds
  and deploys. `networks.hardhat.polkadot: true` is what switches the backend; without it the build
  succeeds and silently emits EVM bytecode. Deliberately has **no live network entry**.
- `hardhat.evm.config.js` — plain solc, `artifacts-evm`/`cache-evm`, tests only. Sharing directories
  with the above means one build overwrites the other and a deploy picks up the wrong bytecode.

**Network:** Products Devnet (Paseo Asset Hub), chainId **420420417**, ETH RPC
`https://paseo-assethub-rpc.laissez-faire.trade`. Addresses in `deployments.json`.

## Important Notes

- Contract ABIs in `frontend/src/contracts/` must be updated after contract changes.
- Reads must never depend on events. `eth_getLogs` cannot see events from host-submitted contract
  calls (architecture §8) — the host submits them as native `Revive` extrinsics. Poll the view
  functions; treat events as a latency hint only.
