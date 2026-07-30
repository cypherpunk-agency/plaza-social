# Plaza on the Polkadot Products platform — architecture

**Status:** design, agreed in discussion 2026-07-29. Open questions are marked and blocking where noted.
**Standing rule for this document:** every factual claim carries its provenance — how it was
established, where, and when. Claims are tagged **[V]** verified by direct observation this session,
**[I]** inference, **[?]** unknown. A prior claim being written down somewhere is *not* provenance;
`docs/platform/sdk-notes.md` in the `yolodot` repo carries `[V]` tags that are now stale (see
§7), which is why this rule exists.

---

## 0. Status, and the shortest path to seeing it live

**Status 2026-07-30. FIRST DEPLOYMENT IS LIVE.**

| What | Where |
|---|---|
| App bundle | **https://plaza-social.dot.li** — `plaza-social.dot` (`.dev-dot.li` serves it too) |
| Bundle CID | `bafybeieyyrnfs2ymo6mnx4gfd3b3priknbxvwe6lxokyw2fda7tkgt26je` (contenthash verified on chain, finalised block 11596617) |
| `UserRegistry` | `0xfD00289e765414C0281EFC35335b6453F055FBD7` — `@plaza-social/user-registry` v0, 73,787 bytes |
| `PostRegistry` | `0xF6daC4BC4e721c5C84504A5Bfe033AE63722f8c9` |
| `Voting` | `0x948c71E7134E82c8d71e1bAD781F5BD4B96A14C0` |
| `FollowRegistry` | `0x96A3274Fa3696bbF5F8e1D8B58455300B9b7032E` |
| Deployer | `5Fk6mNEA…P1qP5R` / `0x82A06d…B345` (sr25519) |
| Spent | ~5 PAS of 4921, plus a refundable domain deposit already held |

**All four contracts are deployed as of 2026-07-30**, verified by
`contracts/scripts/verify-deployment.mjs`: code present at each, each satellite's `userRegistry()`
returns the pinned address, and an anonymous `eth_call` read executes through each. Contract tests are
**136 passing, 0 failing**.

Verified independently, not taken from the tool's output: the on-chain contenthash matches the
published CID, and the CID root is retrievable from two public gateways.
`MAX_DELEGATION_SECONDS` reads back as `7776000` from `UserRegistry` over an anonymous `eth_call`.

⚠️ **You cannot check individual files that way.** The published CID is a **CAR file**, not a unixfs
directory — 7,571,187 bytes of `application/octet-stream` starting with a CBOR `{roots, version}` header
[V] 2026-07-30. The root fetches fine; `<cid>/index.html` 404s with `no link named …`. An earlier
version of this paragraph claimed "the served asset hashes match the local build file for file", which
is not something a gateway can answer here. To prove new code is in a bundle, grep the strings you
changed in the exact `dist/` you uploaded.

⚠️ **Deployed is not working, but the gap has narrowed.** As of 2026-07-30 the following are proven on
a real device: the publish path, the contract set, forum and profile-feed reads end to end, and **arm 1
— a profile created on chain, host-signed, with the product account as `msg.sender`**.

What remains: **chat and channels still call deleted contracts.** Threads, profile posts and replies
are migrated onto `PostRegistry` + Bulletin and go through the two-signature publisher; thread
creation is verified on a phone, replies are wired and fake-tested but have not yet been published
from one. See [`STATUS.md`](STATUS.md), which is kept current; this section is the reasoning, not the
state.

### How the constructor problem was resolved — option A, plus a guard

**`cdm deploy` cannot pass constructor arguments** **[V]** — established from cdm-cli 0.8.26 source,
not inferred from its flag list: `ContractDeployer.dryRunDeploy` builds
`Revive.instantiate_with_code({… data, salt})` after `const data = new Uint8Array(0);`. A
`constructor(address)` therefore decodes `address(0)` and reverts, and **every** contract in the deploy
chunk is marked failed regardless of which one broke. yolodot never hit this because `PlazaHeads` and
`Guestbook` have no constructor dependencies.

Two hypotheses were **disproved** along the way and are recorded so nobody re-runs them:
- **Not name ownership.** `@plaza-social/user-registry` claimed itself on first publish. Decision 005
  asserts the signing account must own the name and never says how ownership is acquired — because it
  happens automatically.
- **Not code size.** The 73.8 KB blob deployed fine, well above yolodot's proven 56,507 bytes.

**Chosen: A.** The three satellites hold `UserRegistry` as a compile-time `constant`
(`PLAZA-USER-REGISTRY-ADDRESS`) and take no constructor arguments.

The decisive argument turned out not to be convenience but **semantics**. The obvious alternative —
resolve the CDM name `plaza-social/user-registry` through the registry contract at call time, which
needs no constructor argument either — follows the **latest** version, and cdm's deploy salt includes
the version. So any redeploy lands at a new address with empty storage and every delegation the
satellites honour would be invalidated at once, silently. Delegation state lives in one specific
instance; the contract must name that instance. Pinning is the safer semantic, not the lazier one.

Each constructor now reverts `UserRegistryNotDeployed` if the pinned address holds no code. A pinned
address is network-specific, and this converts the resulting failure from "every delegated write
reverts with an opaque ABI-decode error" into "the deploy fails immediately, naming the address".

The costs, stated honestly: the pin is to **v0**, so a future `cdm deploy` that bumps `UserRegistry` to
v1 leaves the satellites on v0 — still working, still holding the delegations, but not what
"I redeployed" suggests, and `deployments.json` must agree. And tests need `UserRegistry`'s code at the
pinned address, which `test/helpers/pinnedUserRegistry.js` arranges; that is sound only because
`UserRegistry` has no constructor.

**Rejected: B** (a direct `instantiate_with_code` deploy path that can pass arguments) — a second deploy
path to maintain, and it would have lost cdm's name registration. **Rejected: C** (drop the `*For`
variants) — posts would be credited to the signing key rather than the author, defeating the delegate
design entirely.

⛔ **REJECTED, do not revisit: taking the registry address as a call argument.** The caller would deploy
`contract Evil { function canActAs(address,address) external pure returns (bool) { return true; } }`,
pass it in, and write to anyone's row. An authority that answers "is this allowed?" can never be chosen
by the party being checked.

### ⛔ Personhood cannot gate a contract write — the plan for `Voting` is dead

The precompile is real: `0x000000000000000000000000000000000a010000`, selector `0x886af133` =
`personhoodStatus(address,bytes32) -> (uint8 status, bytes32 contextAlias)` **[V]**. It is in
`yolodot/apps/plaza/src/lib/personhood.js`; `sdk-notes.md` §5c still records it as `[?]`.

**And it returns 0 for every address in existence** **[V]** 2026-07-30, `scripts/probe-personhood.mjs`.
Asset Hub has no personhood pallet; it has `MembersSubscriber`, `AliasAccounts`, `Pgas`. The only
account→person mapping is `AliasAccounts.AccountToAlias`, which has **zero entries** chain-wide, and its
binding extrinsic `set_alias_account` needs `AliasFee`, which is **unset** — so nobody can bind even if
they wanted to. Meanwhile `Pgas.ClaimedGasAliases` has 23 entries: personhood here is proven
per-extrinsic by an alias, never by an account a contract can look up.

A contributing error worth recording: the `context` argument is not free-form. Valid contexts are the
keys of `MembersSubscriber.RingCollectionStates` — ASCII, space-padded to 32 bytes,
`"pop:polkadot.network/people-lite"` and `"pop:polkadot.network/people     "`. yolodot's module defaults
to `bytes32(0)`, which names no ring, so every earlier probe was asking a malformed question. Both real
contexts still return 0, so the conclusion holds — but a future probe that passes zeros proves nothing.

So **`Voting` keeps `hasProfile`** and personhood stays a frontend advisory read, exactly as yolodot's
own module insisted ("ADVISORY ONLY and must never gate a write") — now verified rather than cautious.
When `AccountToAlias` becomes non-empty this is worth revisiting, because `contextAlias` really is
strictly better than `hasProfile`: profiles are free and unlimited so that check gates nothing, whereas
an alias gives one-human-one-vote *and* a per-app pseudonym. At that point: **accept `status == 1 || 2`**
— devnet has 94 lite people to 41 full, so requiring full would exclude the majority.

Note also that personhood was never a full substitute: it answers "are you a human", not "may you act
for Alice", and a delegate key has no personhood at all. `canActAs` was always going to be needed.

### Toolchain facts that cost real time

- **`networks.hardhat.polkadot: true` is what switches the compiler to resolc.** Requiring
  `@parity/hardhat-polkadot` alone is not enough: the build succeeds and silently emits **EVM**
  bytecode, and cdm then reports "did not produce deployable bytecode". A PolkaVM artifact starts
  `0x50564d00` (`PVM\0`); EVM starts `0x60…`.
- **The two builds must use separate output directories.** EVM → `artifacts-evm`/`cache-evm`, PolkaVM →
  the defaults. Otherwise they overwrite each other.
- **The PolkaVM config is `hardhat.config.cjs`, not `.ts`.** This package is `"type": "module"`;
  Hardhat 2 loads a TS config through ts-node as CommonJS and rejects it with HH19. Plain `.cjs` needs
  no ts-node at all — worth avoiding, since ts-node 10.9 cannot read TypeScript 7's compiler API and
  fails as `Cannot read properties of undefined (reading 'fileExists')`.
- **`contract.getAddress()` is an ethers v6 built-in** and silently shadows a same-named ABI function,
  returning the contract's *own* address. Same family as the `ref.at` trap in `PlazaHeads`. Use
  `contract.getFunction("getAddress(string)")`.
- **`.cdm/solidity/<scope>/<name>.sol` is NOT a reliable address record.** ~~The deployed address is in
  the header, which is the reliable way to recover it.~~ Corrected 2026-07-30: it is regenerated on every
  build, and a contract not part of *this* build comes back as a stub with `ADDRESS = 0x0000…0000`. That
  happened to `user-registry.sol` while the contract was live on chain the whole time.
  `deployments.json` plus `scripts/verify-deployment.mjs` are the record.
- **`cdm deploy` always redeploys, at a new address, as a new version.** The salt is
  `computeDeploySalt(package, version, scope)` and `getOnChainCode` is defined but never called, so there
  is no unchanged-code skip and no subset flag. It will silently orphan a live instance *and its
  storage*. To deploy a subset, move the rest out of `contracts/` for that one command — but not as a
  resting state, because an isolated contract has no artifact and **its tests stop running silently**
  (this hid 93 of 136 tests for a while).
- **Solc reads `@scope/name` in a NatSpec comment as a doc tag** and fails with
  `DocstringParsingError … not valid for public state variables`, which points at the variable rather
  than at the prose. Drop the `@` in prose.
- **Always pass `--env devnet` to `pad`.** Its default is `paseo-next-v2`, a *valid* id, so omitting it
  deploys to the wrong network and looks successful.

| Stream | State |
|---|---|
| Contracts | `PostRegistry`, `UserRegistry`, `Voting`, `FollowRegistry` — **all four deployed**, **136 tests passing**. 10 old contracts deleted. |
| Bulletin data layer | `wire`, `walk`, `blob-cache`, `gateways`, `image` — **80 tests**, zero dependencies. |
| Host layer | 13 modules + React binding + fake backend — verified running in a browser. |
| Test harness | Playwright against a real Spektr host — **15 tests**. |
| DM removal | Complete; build and typecheck clean. |
| **Not done** | Arm 1 (`host.submit`), the 16 feature-hook migration, the save-content screen. |

**The 16 feature hooks still reference deleted contracts.** The app builds, but its features will not
work against a new deployment. That is expected and is *not* on the critical path below — the shortest
path to live deliberately bypasses them with a minimal probe view.

### The two things that let us skip most of the work

1. **`PostRegistry.setHead` writes the caller's own row and needs no delegation and no profile.** Only
   `setHeadFor` needs an authorised delegation. So a locally-held key can post *as itself* without
   `authorizeDelegate` — which means **arm 1 is not on the critical path.** Cost: posts are attributed
   to the key rather than to a user profile. Acceptable for a smoke test, and it removes the one
   unfinished module from the blocking set.
2. **Bulletin reads work anywhere via public gateways**; only writes are container-bound. So a large
   part of the loop is testable off-platform.

### Tier 1 — real chain, no personhood, available immediately

Proves: contracts deploy on the real chain, anonymous `eth_call` reads work, delegate contract writes
work, gateway reads work. Does **not** prove Bulletin writes or any host behaviour.

1. Install the four SDK packages; move `@parity/product-sdk` to runtime `dependencies`; delete the
   `parityOptionalDeps()` Vite shim. Build must be clean.
2. **Point Hardhat at Products Devnet** — it still targets the dead Passet Hub. Replace with
   `https://paseo-assethub-rpc.laissez-faire.trade`, chain id **420420417**.
3. Fund a deployer key (human step H2 below). Budget 10–20 PAS for four contracts; `PostRegistry`
   alone is enough for a first loop.
4. `npm run deploy`, then copy `deployments.json` into `frontend/public/`.
5. Send a little PAS from the deployer to the local posting key. **It cannot be sponsored** — PGAS is
   personhood-gated and a fresh key has no personhood. A fresh head row costs ~0.0158 PAS plus fees.
6. Build a **minimal probe view** — one screen: write a post, list posts. Not the 16 hooks.

### Tier 2 — in the host, needs personhood

Proves the rest: session handshake, allowances, Bulletin writes, and the prompt behaviour that is
still inference in §5.

7. Register a `.dot` domain (10 PAS **refundable deposit**; a 9+ character stem avoids a personhood
   check on the name itself).
8. `pad --env devnet` — always pass `--env` explicitly; `pad` defaults to `paseo-next-v2`, which is a
   valid id, so omitting it deploys to the wrong network and looks like it worked.
9. Load it in the phone app and read the diagnostics panel.

### Human prerequisites — only Tommi can do these

- **H1. Personhood on the phone app.** Gates PGAS minting, publishing, and short domain names. This is
  the long pole for Tier 2 and blocks nothing in Tier 1.
- **H2. A funded account.** `faucet.polkadot.io`, **SS58** address (not `0x…`), 5000 PAS per 24 h,
  captcha.
- **H3. Bulletin storage authorization**, if `dotns bulletin authorize` turns out not to be scriptable
  (§1a, unproven).

**Rate limit that shapes everything after this: 1 publish/day on Lite personhood, 5 on Full.** Iterate
locally against the fake backend; treat each publish as expensive.

## 1. What we are building

Plaza moves from a self-hosted browser dapp on a dead testnet to a Products-platform app: a static
bundle published to Bulletin, bound to a `.dot` domain, running inside the Polkadot host container.

**Decided:** the host container is the only surface. No MetaMask path, no standalone in-app wallet.
Anonymous reading still works *inside* the host (no wallet connected ⇒ `canWrite: false`, reads
succeed); what is given up is a public web URL usable without the Polkadot app.

**Consequence — a fake backend is required infrastructure, not a nicety.** The SDK throws outside a
container, so there is no localhost development without one. `yolodot/apps/plaza/src/lib/transport-fake.js`
is a working reference.

## 1a. Publishing constraints that shape the workflow

Detail and provenance in [`publishing.md`](publishing.md). The consequences for this design:

- ~~**Publishing is personhood-gated and rate-limited: Lite 1/day, Full 5/day** **[V]**.~~
  **FALSIFIED 2026-07-30 — this `[V]` was wrong and cost real time.** Two full `pad` deploys succeeded
  ~20 minutes apart on the same account (blocks 11599710, 11600873), and neither was personhood-gated.
  A `RateLimitExceeded` error does exist in the pallet with those numbers (see `publishing.md` §351),
  but it does not gate a deploy — most likely it applies to `pad --publish`, the Browse *directory
  listing*, which is separately personhood-gated and fails non-fatally exiting 0. Actual deploy cap:
  **[?]**.

  The local dev loop and the fake backend are still load-bearing, but for the honest reason: the
  iteration loop is seconds instead of a minute. **Not** because publishing is scarce. A prior version
  of this bullet concluded "we cannot iterate against the published surface", which was false and led
  to telling the user a finished fix could not be shipped.
- **Vite needs `base: "./"`** **[V]** — all four deployed bundles and `dotli-starter` set it. The
  earlier "a stock Vite build needs no base config" claim was an inference from reading the service
  worker and is contradicted in practice.
- **Domain cost is a refundable 10 PAS deposit, not a fee** **[V]** (`dotns escrow status` → `amount:
  10 PAS / released: false / status: held`). The documented pricing formula does not describe devnet.
- **Bulletin authorization may be scriptable after all [?]** — `dotns bulletin authorize <ss58>
  --transactions … --bytes … --env devnet` exists, signed by a shared devnet authorizer. Documented,
  not yet proven; it signs, so it was not run.
- **`pad` validates `--env` and rejects typos** **[V]**; only `dotns` accepts a bogus value silently.
  The real trap is `pad`'s *default* of `paseo-next-v2`, which is a valid id — so omitting the flag
  deploys to the wrong network and looks like it worked. Always pass `--env devnet` explicitly.
- **Neither `pad` nor `dotns` can renew stored data** **[V]**; `dotns bulletin refresh` renews the
  *authorization*, not the record. The only renewal UI on the platform is a page in Parity's Console.
  `CloudStorageClient.renew()` in the SDK is the only programmatic path — which is what makes §4a
  worth building.

## 2. The content model

**One envelope, discriminated payloads.** What unifies is the *mechanics* — immutable Bulletin object,
CID chain, head pointer, one walk implementation, one expiry model, one permission model. The payload
schema genuinely differs per kind, and collapsing it into a single type with optional fields would
force every consumer to know which fields are meaningful when. That was an early mis-statement in this
document; corrected here.

```
envelope   { kind, author, at, prev, skips[], prevAuthor, prevAt }
msg        { body, attachments[] }             // chat message
post       { body, attachments[], index }      // reply, or profile post
thread     { title, tags[], excerpt, opCid }   // announcement; points at the opening post
dir        { id, name, topic }                 // registry directory entry
```

**Envelope fields beyond `prev` exist to survive holes**, and belong here rather than being an
implementation detail:

- **`skips[]`** — an ancestor ladder, `skips[i]` = ancestor at distance `i+2`, 3 levels. Linear rather
  than exponential, and that is forced: exponential skips would need ancestor reads at write time, and
  the next link is usually written by someone else — whereas the tip's own ladder shifts forward for
  free. Every stepped-over CID is named, so nothing is skipped invisibly.
- **`prevAuthor` / `prevAt`** — so a hole renders with a real author and timestamp instead of a void.
  This is what makes "a lapsed body must never hide the fact that a post existed" implementable.

**`attachments` is on `msg` too.** An earlier version of this table gave `msg {body}` while the prose
said chat could carry images — a contradiction. Resolved in favour of allowing them: prompt-free
Bulletin writes removed the reason to confine images to one surface.

**`at` is self-asserted, so ordering is not a security property.** It is a claim inside an object the
author wrote. The only attribution that is *not* self-asserted is `HeadRef.by`, which comes from the
index contract. Surface both separately if a verified-authorship badge is ever wanted.

**`attachments[].mime` is untrusted metadata.** Bulletin's `store()` takes no content type, so `mime`
is whatever the writer claimed, inside an object anyone can write. **Readers must whitelist before
rendering** — `image/svg+xml` in an `<img>` from a stranger's chain is XSS. The upload gate and the
render gate are deliberately separate checks.

**`post.index` is approximate, not a count.** With one head per writer, two writers can concurrently
produce the same index, so a reply count read off the head object is a *lower bound*. The alternative —
scoping `index` per writer and summing — requires reading every head and defeats the cheap read.
Accepted as approximate; label it that way in the UI rather than pretending precision.

Note that **a reply and a chat message carry the same fields** — the real distinction is not
chat-vs-post but *whether the thing has a subject line*. And a thread is not a post with a title: it
is a separate announcement object pointing at the opening post's CID. That indirection is what makes
cross-posting possible (N announcements, one body).

**Attachments are plural, and that is free.** Each image is its own Bulletin object with its own CID;
the post body holds references. The reference list lives inside the Bulletin object, not in contract
storage, so an array costs nothing on chain. There is no reason for the single-attachment limit
inherited from `yolodot`.

```
attachments: [{ cid, mime, width?, height?, alt? }]
```

Chat may allow 0–1 by UI convention while the format permits N.

Two consequences to design for:

- **Each attachment has its own retention clock**, independent of the body. A post can lose its
  images while keeping its text, or the reverse. The `bodyState: 'unavailable'` pattern must extend
  to per-attachment state.
- **Bulletin has no delete and no takedown.** `yolodot`'s image pipeline re-encodes through a
  `<canvas>` rather than stripping EXIF, on the reasoning that a stripping pass can miss a vendor
  block and a re-encode cannot. Allowing N images per post multiplies that exposure; keep the
  re-encode.

**This is a wire-format concern only.** The index contract stores CIDs and never parses content, so
the payload schema can change without touching the contracts.

A **PostRegistry** is a scope with a permission policy and a retention policy. Three flavours:

| Registry | Who may attach | Retention |
|---|---|---|
| Profile feed | owner only | see §4 |
| Board (forum) | per-board policy, moderated or open | see §4 |
| Room (chat) | open | rolling window |

An **attachment** is an announcement object appended to a registry's chain, pointing at a Post's CID.
Cross-posting is N attachments to one Post — the body exists once. A **reply** is a Post whose
registry is the thread itself.

**Implemented as `openRegistryId("thread:" + parentCid)`** — `frontend/src/lib/registry.ts`,
2026-07-30. Keyed on the parent's CID rather than its position, so the conversation survives everyone
else posting; open, so nobody can claim and then moderate somebody else's replies; and nothing is
deployed or claimed to bring one into existence. The reply's `HeadSet.group` is the BOARD, which is
what that parameter is for: one board subscription hears the board's chain and every reply on it.
⛔ **Nesting is therefore not representable and the app does not fake it.** A `post` carries `prev`
and no parent pointer, so `parentReplyIndex`/`depth` have nowhere to live; replies render as one flat
level and the reply-to-a-reply control was removed. The shape that would work is a nested registry
(`thread:<replyCid>`), which the same derivation gives for free — an open product decision, not a
missing function.

This collapses `ForumThread`, `UserPosts` and `Replies` into one type with three policies.
**`UserPosts` is `ForumThread` minus `title` minus `tags`** — both are
`{author, sender, body, timestamp, editedAt, isDeleted}`, both cap at 40,000 bytes, both integrate
Replies and Voting through `entityType`. **[V]** — read from
`contracts/contracts/posts/UserPosts.sol` and `contracts/contracts/posts/ForumThread.sol`, 2026-07-29.

Chat is the same model with a shorter window, which is why it needs no separate design.

## 3. Where state lives

The sort is **payload size × read pattern**, not content vs. configuration.

**Bulletin** — large, immutable, single-author, read in context, walked backwards:
post bodies, image attachments.

**Contract** — small, hot-read by key or aggregated, must be enumerable:

| State | Why it cannot be Bulletin |
|---|---|
| Head pointer per (registry, writer) | Bulletin has no list, prefix scan, or namespace primitive at all. Discovery needs an on-chain index. |
| Profiles (name, bio, links) | Read on every message render, for many addresses at once — one multicall vs. one gateway fetch per user. |
| Vote tallies | A tally is an aggregate; Bulletin has no aggregation. Scoring a 500-voter post would need 500 head reads plus 500 fetches. |
| Follow graph | Structured, enumerable in both directions. |
| Moderation roles / registry policy | Must be authoritative — but see below: authoritative cannot mean deletable. |

**Most surfaces cost no policy storage at all.** An unclaimed registry is `Open` by default, so every
chat room, thread and directory needs zero configuration state; a profile feed is a per-writer row and
needs none either. **Only moderated boards pay for config storage.** That is the difference between
"every surface costs a deposit to create" and "only the moderated ones do."

**Moderation cannot mean deletion, and this is structural.** An admin able to delete a writer's head
would free that writer's storage and collect their deposit refund — the one form of deposit theft the
whole design exists to prevent (§3, and `PlazaHeads`' reasoning). So on-chain moderation is a **write
gate plus a hide flag**: a banned writer keeps their row, `allowed` reads false, and clients do not
render it. If a board needs content genuinely *gone*, the mechanism is **Bulletin retention — stop
renewing it** — not the contract. Moderation and retention turn out to be the same lever, which is a
real benefit of the ephemeral model rather than a workaround.

**Storage is bounded, by construction.** The index stores *one head per (registry, writer)*, not a
growing list of entries — so it does not accumulate, the deposit is paid once per writer per registry
and reused forever, and no pruning mechanism is needed. This is why `PlazaHeads` chose
one-head-per-(scope, writer); deposit accounting was the stated reason. Votes are the only thing that
accrues (one slot per voter per entity, ~0.006 PAS at the measured child-trie rate, paid by the voter
and refundable by them). **Decision: do not build pruning initially.**

Contrast with today, where `ChatChannel.messages[]` and `DMConversation.messages[]` are append-only
with **no delete path at all**, so their deposits are immobilised permanently. **[V]** — read from
`contracts/contracts/ChatChannel.sol` and `contracts/contracts/DMConversation.sol`, 2026-07-29.

## 4. Retention — open, and it decides the product

One retention story, not per-surface. Bulletin content expires after `RetentionPeriod`
(201,600 blocks ≈ 14 days) unless renewed.

**Renewal is prompt-free** under the same Bulletin allowance that covers stores (§5), so it is
something the app can do silently rather than a signature the user must approve. That removes most of
the force from the "renewal is a chore that decays" worry: Plaza can renew a user's content whenever
they open the app. The residual risk is a user who does not open the app inside the retention window.

**Still open: can a third party renew content it did not store?** `CloudStorageClient.renew(block,
index)` takes **no owner or author parameter**, and renewal charges the caller's quota **[V]** — read
from `@parity/product-sdk-cloud-storage` `dist/index.d.ts`, 2026-07-29. If a third party with a
Bulletin authorization can renew anything **[?]**, Plaza can run a server-side renewal service and
persistence becomes fully an operator policy, independent of whether users return. If not, content
survives only as long as its author keeps using the app — and because chains walk backwards, an author
who stops also orphans everyone's replies below the hole.

**Retention is ≥14 days, and blocks are the primary unit.** `RetentionPeriod` is 201,600 blocks
**[V]**. At a measured 6.457 s block time that is 15.06 days; at 6.03 s it is 14.07. Every deadline
computed from a flat "14 days" is therefore *early* — safe for a preservation UI, but wrong. Compute
in blocks.

**Chains truncate at the first run of holes, not at the first hole — and the ladder changes the
strategy.** With the `skips[]` ancestor ladder in §2, a walk survives isolated holes and only stops at
a run of `SKIP_LEVELS+1` consecutive lapsed objects. That has a direct consequence for §4a worth
banking: **renewing every 4th object keeps an entire chain reachable.** Bodies in between still lapse,
so the walk shows holes, but it still reaches the start. With a ~10-item quota that is the difference
between saving 10 posts and keeping a 40-post thread navigable — which is what a preservation screen
should actually optimise for.

This substantially weakens what was previously the strongest argument against a single uniform
retention story. It does not eliminate it: a chain still degrades, and a forum thread with holes is
worse than one without.

Supporting facts, both from the `yolodot` repo's own measurements and **not** re-verified here:
zero renewals have ever occurred on that chain (all 9,272 index entries are `kind == 0`, Store), and
the SDK wraps only one-shot `renew`, not `enable_auto_renew`.

## 4a. Preservation as a feature — the "keep this alive" screen

**Idea:** a screen listing content nearing expiry, where a user spends their own Bulletin quota to
renew it — including other people's content, and including the app's own bundle.

This turns the platform's least visible property (everything decays) into something visible, social
and actionable. It is also close to free architecturally, because the mechanism already exists:

- **Renewal is prompt-free** under a granted Bulletin allowance (§5). One tap, no signature.
- **Renewal charges the caller's quota**, not the storer's **[V]** — which *is* the donation
  mechanic. Nothing needs inventing.
- **Remaining quota is readable**: `checkAuthorization(address)` returns
  `{ authorized, remainingTransactions, remainingBytes, expiration }` **[V]**, so the UI can honestly
  show "you can save 7 more things."
- **The app's own bundle is Bulletin content** bound via a DotNS `contenthash`, so the same screen can
  renew Plaza itself. A user keeping the app alive for everyone else is a genuinely novel interaction.

### Verified: a third party CAN renew. Detail in [`pgas-deposits-and-renewal.md`](pgas-deposits-and-renewal.md).

`renew` does **not** require the origin to be the original storer **[V]**, established four
independent ways: its on-chain doc says only "`entry` identifies the data either by `(block, index)`
or by content hash" with no mention of storer or owner; `TransactionInfo` has **no account field at
all**, so a storer check is structurally impossible; there is no `NotStorer`-style variant among the
24 error cases; and the extrinsic bodies call only `ensure_authorized(origin)` and discard the caller.
**Renewal charges the caller's quota** **[V]** — the donation mechanic works as hoped.

**Use `force_renew`, not `renew`** **[V]**. `renew` is a *scheduler* that fires up to 14 days later and
admits only **one** preserver per content hash (`AutoRenewalAlreadyEnabled`, enforced at pool
admission) — so it cannot express "several people saved this." `force_renew` is synchronous,
unrestricted and repeatable by anyone. It is **not wrapped by the SDK**, so we encode the call
ourselves.

### The schema consequence — corrected

An earlier version of this section required recording `(block, index)` per head, on the belief that
`renew` was positional-only. **That was wrong.** `renew`'s `entry` is
`Enum{ Position{block,index} | ContentHash([u8;32]) }` and accepts a content hash directly; CID →
content hash is a pure client-side multihash parse. `TransactionByContentHash` also round-tripped
**5659/5659 with zero mismatches** **[V]**. So renewal needs nothing on chain beyond the CID.

**Record the store `block` alone, for a different reason: computing expiry.** Content expires at
`block + RetentionPeriod`, the chain's index entry is *deleted* at expiry, and a missed renewal is
unrecoverable — so a client needs the store block to know what is about to lapse. `index` is not
needed.

### An operator-funded model exists, unused

`store` and `force_renew` **prefer a preimage authorization** when one exists for that content hash —
"this allows anyone to store/renew pre-authorized content without consuming their own account
authorization" **[V]**. Plaza could pre-authorize the hashes it cares about and let anyone renew them
for free. **Zero preimage authorizations exist on the chain today** — all 255 are account-scoped.

### The hole in the donation mechanic — a renewal cannot update the author's row

Renewal charges the caller's quota, so a third party *can* renew. But a third party **cannot update the
author's head row** — that would be writing someone else's storage, which the deposit invariant
forbids (§3). So after a donor renews, the author's row still carries its original `storeBlock`, and a
client computing `storeBlock + RetentionPeriod` will show content as expiring when it has in fact been
saved. Found by the contract implementation, not by this document.

Two complementary fixes, and we want both:

- **The chain is the source of truth for expiry.** `TransactionByContentHash` maps a content hash to
  its *most recent* `(block, index)` **[V]**, so the real deadline is readable from the Bulletin chain
  rather than from our contract. Use this on the save screen, where accuracy matters.
- **`storeBlock` in the contract is a cheap hint**, good enough for list views where a per-item chain
  query would be too expensive, and knowingly stale after a third-party renewal.

### Attribution needs our own record

`renew` / `enable_auto_renew` emit `RenewalEnabled{who}` / `DataAutoRenewed{account}` and are
attributable, but **`force_renew` emits `Renewed{index, content_hash}` with no caller** **[V]**. So
"kept alive by 3 people" must come from the extrinsic signer, or from writing the save action to our
own contract.

### Limits to be honest about in the UI

- **Quota is small.** Per `yolodot`'s census, ~60% of authorizations grant 10 transactions / 4 MiB.
  So a donor can save on the order of ten items, not a library.
- **`AuthorizationPeriod` reportedly equals `RetentionPeriod`** (~14 days), so a donor's quota lapses
  on the same cadence as the content it saves.
- **Renewal is a one-shot scheduler** — it buys one more period and deregisters, so preservation is a
  recurring act, not a switch.
- **Failure is terminal.** The pallet's own comment on a failed renewal is "the data is gone." A UI
  that implies content is safe would be lying; it should show a deadline, not a checkmark.
- **Gated on [?]** whether a non-storer may renew at all. If only the original storer can, the screen
  degrades to "save *your* content" — still useful, much less interesting.

### Worth designing in

Renewals are on-chain transactions with a signer, so **who saved what is observable** — credit is
possible without any extra machinery. "Kept alive by 3 people" is a real, verifiable claim.

## 5. Signing and prompts — open, and blocking

There is **no auto-signing**: the deployed host discards the `AutoSigning` payload in its reply
handler, persists only `{bulletin, statementStore}`, and its four signing handlers reach an
unconditional modal. **[V]** — established in `yolodot/apps/plaza/src/lib/host-session.js:446-478`
by reading the deployed `dev-dot.li` bundle.

**Delegate keys cannot write Bulletin.** Only the user's own personhood-backed account can;
`authorizeAccount` is documented "sudo required on most networks" **[V]**, and in-host the route is
`requestResourceAllocation([{tag:'BulletinAllowance'}])` granted to a verified user's product
account — a delegate key has neither a product account nor a path to one.

**RESOLVED — a granted Bulletin allowance IS prompt-free.** **[V]** — read from the deployed host
bundle (`https://browse.dev-dot.li/assets/auth-*.js`), 2026-07-29. The `Allocated` response codec is:

```
Allocated = { StatementStoreAllowance: { slotAccountKey },
              BulletInAllowance:       { slotAccountKey },   // a KEY
              SmartContractAllowance:  void,                 // no key
              AutoSigning:             { productDerivationSecret, productRootPrivateKey } }
```

and the host persists, encrypted, `{ productId, resource: O({bulletin, statementStore}),
slotAccountKey }` with a `read(productId, tag) -> slotAccountKey` accessor.

So a Bulletin or statement-store allowance hands the host **a signing key that it keeps**, while
`SmartContractAllowance` carries none. The flattening discards payloads in the *product-facing reply*
while the host retains the bulletin/statementStore keys internally; AutoSigning has no host-side
storage slot, so its keys genuinely are lost.

> ### ⚠️ IMPORTANT QUALIFICATION — added after harness testing 2026-07-30
>
> **That the persisted key is used to sign Bulletin stores without a prompt is INFERENCE, not
> verified.** It is the inference the whole content-placement decision in §3 rests on, so the
> distinction matters.
>
> What the Playwright harness established **[V]**: on the *published* SDK contract,
> `AllocationOutcome` is a **plain string** — `S.Status("Allocated","Rejected","NotAvailable")` in
> `@parity/truapi@0.5.1`, `Enum({Allocated: _void, …})` in `@novasamatech/host-api@0.8.12`. **No key
> comes back to the product on either side.** That is consistent with the flattening above rather than
> contradicting it: the key exists and is persisted *host-side*, and the product never sees it. But it
> means nobody has observed the key being *used*.
>
> The harness cannot close this: its test host auto-signs, has no modal, and — decisive — **has no
> allowance-to-signing linkage at all**. Its allowance handler maps every request to `Allocated`
> without inspecting the tag. Granting `BulletinAllowance` before a signing call changes the signing
> count not at all.
>
> Also unresolved: whether the deployed `dev-dot.li` host and today's published SDK are even on the
> same protocol revision. The deployed bundle's `Allocated` is a nested per-resource union; the SDK's
> is a flat status. Most likely the host is ahead and flattens on the way out, but that is inference.

### A stronger basis for prompt-free Bulletin writes: the preimage route

The harness measured which host wire calls each operation actually makes, using `signingLog` — populated
by exactly the six handlers a real host gates behind a modal, so an entry is a faithful proxy for
"would prompt" **[V]**:

| Operation | signing handler calls |
|---|---|
| Bulletin store as a product-signed **extrinsic** | `["createTransaction"]` |
| Bulletin content via host **`preimage.submitPreimage`** | **`[]`** |
| Statement store `createProofAuthorized` + `submit` | **`[]`** |
| `Revive.call` as a product-signed extrinsic | `["createTransaction"]` |

**Two routes to Bulletin exist and only one touches signing.** The preimage route is prompt-free *by
construction* rather than by allowance — the host accepted the bytes and recorded the preimage
(`fromProduct: true`) with no signing request whatsoever. `StoreBuilder` also exposes `sendUnsigned()`
alongside `send()`, plausibly the `authorizePreimage` "anyone can store; no fees" path from §4a.

**This is a better foundation than the `slotAccountKey` inference** and should be the design's primary
route. It also explains the census oddity in §9: Parity's own `survey` app uses
`preimageManager.submit()`, which is exactly this path.

Note the contrast §5 predicts is **not visible in the call pattern** — a Bulletin extrinsic and a
`Revive.call` are both one `createTransaction`. If the deployed host prompts for one and not the other,
that difference lives entirely in host-side allowance lookup and is invisible from the product.

**The prompt table:**

| Operation | Prompts? | Why |
|---|---|---|
| Bulletin store (post body, image) | **no**, once allowance granted | host signs with the persisted `slotAccountKey` |
| Bulletin renew | **no**, same allowance | it is an ordinary Bulletin operation |
| Statement publish | **no**, once granted | same mechanism |
| Contract call, delegate-signed | **no** | local key signs its own tx; host uninvolved |
| Contract call, user-signed | **yes, always** | signing handler, no allowance consulted |
| The allowance grant itself | **yes, once** | this is the one deliberate modal |

Consequence: the unavoidable prompts are the allowance grant and `authorizeDelegate` — both one-off
onboarding steps. Everything on the hot path can be prompt-free. **This reverses an earlier
conclusion in this project that "every Bulletin write costs a modal", which was inherited from
`yolodot`'s decision 007 §6 without verification and is wrong.**

### ⚠️ The host signs native extrinsics, not Ethereum transactions

This is the constraint that most shapes the code and §5 previously omitted it. §8 records the
read-side half — `eth_getLogs` cannot see events from host-submitted contract calls, because the host
submits them as native `Revive` extrinsics — but **the write side is the same fact**: the
"contract call, user-signed" row **cannot be reached through `ethers` at all**. There is no
`ethers.Signer` for the host arm, and there cannot be one.

So a user-signed contract call needs a *prepared native transaction* (`@parity/product-sdk-tx`,
`@parity/product-sdk-contracts`), not an ethers call. Anyone planning an ethers-shaped host signer from
§5 alone will lose a day. The delegate arm is unaffected — it is a local secp256k1 key submitting
through the Ethereum RPC, which is exactly why it works.

### Every post is TWO writes with TWO different signers

"Delegate keys cannot write Bulletin" is stated above, but its corollary is easy to miss and the table
reads as though the rows were alternatives. They are not — **both are required per post**:

1. **The body** → Bulletin, signed by the host with the persisted `slotAccountKey`.
2. **The pointer** → the index contract, signed by the delegate.

Both are prompt-free, but they are different signers on different chains, and the failure modes differ
(§3's three-step split). A delegate cannot make a post by itself.

### ~~BLOCKING~~ RESOLVED: the `BulletInAllowance` spelling is harmless

An earlier revision escalated this to blocking on the theory that a mis-spelled tag would cause the
allowance grant to **silently no-op**. **That was wrong, and it fails in the safe direction** **[V]**,
established by the harness: passing the capital-I spelling throws **synchronously in the product,
inside the codec, before anything reaches the host** — `TypeError: inner[tag] is not a function`. An
unknown tag behaves identically. A mis-spelled allowance request cannot be silently rejected; it
crashes loudly at the call site.

Both published SDKs spell it `BulletinAllowance`, lowercase i. The capital-I spelling in the deployed
bundle is either a display string or a newer protocol revision; either way it cannot bite this way.

**RESOLVED — storage deposits ARE payable from PGAS, so no funding faucet is needed.** **[V]** —
detail in [`pgas-deposits-and-renewal.md`](pgas-deposits-and-renewal.md). This reverses `yolodot`
decision 007 §9.1 and removes `DelegateFaucet` from the plan.

Evidence: 21 live holds on Asset Hub are `pallet_revive` storage deposits denominated in PGAS
(`AssetsHolder.Holds`, asset `2000000000`, reason `Revive::StorageDepositReserve`); every one of those
accounts holds only the 0.01 PAS existential deposit in native and appears nowhere in
`NativeDepositOf`. A `ReviveApi_call` dry-run predictor — *(usable native ≥ deposit) OR (PGAS ≥
deposit)* — was **250/250 accurate**, and **128 accounts holding zero native PAS can allocate fresh
contract storage**. The boundary is exact: a `storage_deposit_limit` of 158,399,999 fails, 158,400,000
succeeds.

**Cost model [V]:** 0.00264 PAS-or-PGAS per new 32-byte slot (`DepositPerChildTrieItem` +
64 × `DepositPerByte`). A fresh head write with a 59-character CID costs 0.01584. **Only new slots are
charged** — overwrites are free, which is precisely what one-head-per-(registry, writer) exploits. One
PGAS claim (5 PGAS) funds ~315 fresh writes.

What misled the earlier analysis: `ContractInfo` exposes a single scalar deposit with no asset
dimension, and `PgasAllowance`'s one event is scoped strictly to *transaction fees* — neither is
evidence about deposits. The actual tell is `NativeDepositOf`'s own doc, "Receives the **native
portion** on refund", which only makes sense for a mixed-currency deposit.

**Residual native requirement [V]:** an unmapped `AccountId32` fails `AccountUnmapped`, and
`map_account` carries a **native** 0.20052 PAS hold that PGAS does not cover (3,502 such holds, none
in PGAS). 598 of 733 PGAS holders are `0xEE`-padded H160 accounts needing no mapping. **Prefer H160
callers** — which the delegate-key pattern produces natively. Whether the host's own sr25519 product
account needs mapping, and who pays the 0.2 PAS if so, is **[?]** and matters for onboarding.

**Unpayable deposits fail clean [V]:** the call reverts `StorageDepositNotEnoughFunds` — no debt, no
partial write. Existing storage is never re-charged, so a drained account can still overwrite what it
already owns.

## 6. Chat — the host cannot hold the transcript

The host **does** implement chat. Its deployed bundle registers `handleChatCreateRoom`,
`handleChatBotRegistration`, `handleChatListSubscribe`, `handleChatPostMessage`,
`handleChatActionSubscribe` and `renderChatCustomMessage`, adjacent to the signing handlers and
bound to real wire methods. **[V]** — `https://browse.dev-dot.li/assets/dist-*.js`, 2026-07-29.

But it exposes **exactly six** chat wire methods and none of them reads messages **[V]**:

```
host_chat_create_room     host_chat_register_bot      host_chat_post_message
host_chat_list_subscribe  host_chat_action_subscribe  product_chat_custom_message_render_subscribe
```

Three confirmations this is a real absence: (a) the host exposes reads in other domains
(`host_local_storage_read`, `host_account_get`, `host_get_legacy_accounts`), so the convention would
surface a chat read; (b) `isComplete`, the statement store's documented historical-backfill flag, is
absent from `HostChatActionSubscribeItem` — chat subscribe is live-only; (c) the host's IndexedDB
creates exactly four object stores — `chains`, `cids`, `notification_counters`,
`scheduled_notifications` — with **no message or transcript store**, so the host does not persist
messages itself.

**Conclusion:** a chat UI with scrollback cannot be built on the host API. Plaza keeps its own chat
UI and its own transcript (§2/§3). Host chat is an *additive reach surface* — register a bot, push
rich cards with action buttons into the chat the user already has open, receive slash commands.

There is also **no 1:1 DM primitive**: no recipient, no member list, no invite. `createRoom` takes
only `{roomId, name, icon}`, so a product cannot place a user in a room. **[V]**

## 7. What is dropped

- **Encrypted DMs, entirely.** Decided. Removes `DMConversation`, `DMRegistry`,
  `UserRegistry.sessionPublicKeys`, `useSessionKeys`, `utils/crypto.ts`, `utils/sessionKeys.ts`,
  `useDMConversation`, `useDMRegistry`, `DMList`, `DMConversationView`, `NewDMModal`. The largest
  single simplification available. The platform offers no substitute, so this is losing a feature,
  not delegating it.
- **`OnChainChat.sol`** — superseded, undeployed, ABI still shipped to the frontend.
- **`lib/Moderation.sol`** — entirely unused: nothing imports it, and `ChatChannel` inlines its own
  `owner`/`isAdmin`/`isAllowedPoster`. **[V]** Either adopt it deliberately in the registry policy
  work or delete it.
- **The MetaMask and standalone-wallet paths**, per the host-only decision.
- **No replay-of-current-code onto the new chain.** Explicitly rejected as wasted effort; go
  straight to host integration.

## 8. What survives unchanged

The React 19 / Vite 7 / Tailwind 4 component tree and the design work. `FollowRegistry` and the feed
it drives — `useFeed` takes `following` and fetches posts per followed address, so the follow graph
is load-bearing, not decorative **[V]**. And the **polling** read design, which is correct by
accident: `eth_getLogs` cannot see events from host-submitted contract calls, because the host
submits them as native `Revive` extrinsics that produce `Revive.ContractEmitted` in `System.Events`
and nothing in the ETH log index. Do not "modernise" polling into log subscriptions.

## 9. Corrections to prior documents

Recorded because both repos' docs are load-bearing and currently wrong in these places:

- **`MAX_CONTENT_LENGTH` is 40,000 bytes** on both `ForumThread` and `UserPosts`. `ForumThread`'s own
  docstring says 10,000; `contracts/CLAUDE.md` says 2,000; `yolodot`'s decision 007 says 2,000. All
  three are wrong. **[V]** At the measured `DepositPerByte` this is ~0.4 PAS of held deposit for one
  max-size post — 4–13× the estimate 007 reasoned from.
- **`yolodot/docs/platform/sdk-notes.md` §1 is stale and dangerous.** Its ⭐ `AutoSigning` section
  argues at length that the capability works, with three numbered consequences. It was superseded by
  the host-bundle investigation (§5) and never annotated. It is the file whose premise is "every
  claim here is tagged `[V]`".
- **That file also claims packages ship `src/` alongside `dist/`**, which is how its "not yet
  implemented" landmines were found. `@parity/truapi@0.5.1` ships **no `src/`** **[V]**, so the
  method is not uniformly available.
- **`authorizePreimage` is documented "anyone can store; no fees"** **[V]**, which partially
  rehabilitates a path 007 dismissed as "never the open path" on census evidence. Storing is open
  once a hash is authorized; the *grant* is what is gated — consistent with Parity's own `survey`
  app using `preimageManager.submit()`.
- **`docs.polkadot.com/apps/` documents a DIFFERENT product** **[V]** — `playground-cli` (`pg`),
  gateway `dot.li`, a third network ("summit"), and no Windows build (its installer exits on MSYS and
  tells you to use WSL). `yolodot`'s advice to "check it first in future" is therefore wrong. It *is*
  the better source for Bulletin retention/authorization and DotNS rules, where it is the only
  documentation that exists.
- **All three reference apps were alive on 2026-07-29** **[V]**, established by resolving each
  `contenthash` to a CID, parsing the deploy manifests (survey 2026-07-16, browse 07-21,
  plaza-social 07-28), and confirming the iframe `src` CID matched the on-chain CID and the bundle
  executed. Also confirmed: *every* hostname under `dev-dot.li` returns an identical 20,506-byte
  shell, including names never registered — so an HTTP 200 is never evidence an app is alive.
- The `@parity/product-sdk-cloud-storage` types carry a broken doc comment reading
  `\** \TODO: Come back to this (code docs might need update)` **[V]** — the SDK authors flag their
  own docs as possibly stale. Prefer chain and bundle evidence over SDK prose.

## 10. Open questions, in priority order

1. **Does a granted `BulletinAllowance` suppress prompts?** ~~Resolved — yes.~~ **Reopened as
   INFERENCE.** The host persists a `slotAccountKey`; nobody has observed it being used, and the
   Playwright harness structurally cannot (its test host has no allowance-to-signing linkage). §5.
   **However** the harness found a route that is prompt-free *by construction* — `preimage.submitPreimage`
   makes zero signing calls — which is a stronger foundation and should be the primary design route.
   Needs a real host or deployed app to settle the allowance question itself.
2. ~~Are revive storage deposits payable from PGAS?~~ **Resolved — yes.** §5. No faucet needed.
3. ~~Can a third party renew content it did not store?~~ **Resolved — yes, via `force_renew`.** §4a.

Still open, in priority order:

3a. **BLOCKING — the `BulletInAllowance` spelling.** **[?]** If the host matches on the capital-I
   spelling, the allowance grant silently no-ops and every Bulletin write reverts to prompting, with no
   visible symptom. This invalidates §5's prompt table if wrong. Being tested by the Playwright harness.
4. **Is a PGAS-funded storage deposit refunded in PGAS?** **[?]** If not, deposits are a one-way PGAS
   burn rather than a refundable hold, which changes the cost model materially. Needs a signature to
   settle.
5. **Has any third-party renewal ever actually happened?** No. All 9,551 Bulletin index entries are
   `Store`; **zero `Renew` has ever occurred on the chain** **[V]**. The mechanism is verified from the
   pallet, but one `force_renew` by a non-storer should be executed before building on it. Costs quota
   only.
6. **Does the host's sr25519 product account need `map_account`, and who pays the 0.2 native PAS?**
   **[?]** Onboarding-critical — PGAS does not cover it. §5.
7. **Retention policy**, given that preservation is now demonstrably possible, plus the first-hole
   truncation property in §4. A product decision.
8. Whether `survey.dot` goes dark on schedule. All three reference apps were alive 2026-07-29 (§9).

**Encouraging datum for §4a:** 1,389 of 5,659 live Bulletin items — **25%** — expire within a day
**[V]**. A "save this content" screen has an immediate, real corpus rather than a hypothetical one.

Note on method: questions 2 and 3 were delegated to background agents that failed repeatedly on a
platform-wide `529 Overloaded` incident, not on the substance of the tasks. Question 1 was resolved
inline by the bundle-reading technique documented in §5 and §6, which is reliable and cheap; the
remaining two need SCALE-encoded chain probes, which is why they were delegated.
