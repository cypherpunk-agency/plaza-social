# STATUS — read this first

Short by design. The long reasoning is in [`architecture.md`](architecture.md); the traps are in
[`gotchas.md`](gotchas.md). **Last updated 2026-07-30.**

## Live right now

| What | Where |
|---|---|
| App | **https://plaza-social.dev-dot.li** — `plaza-social.dot` (`.dot.li` serves it too) |
| Bundle CID | `bafybeid4p3kquzrr57yuycuplhokmcbuuunrxbjcxbuja6vhllbfvzkz3e` — a **CAR file**, fetchable whole, NOT pathable (2026-07-30). |
| Deploy | `npx @polkadot-community-foundation/polkadot-app-deploy@latest frontend/dist plaza-social.dot --env devnet --mnemonic "$MNEMONIC"` |
| `UserRegistry` | `0xfD00289e765414C0281EFC35335b6453F055FBD7` = `@plaza-social/user-registry` v0 |
| `PostRegistry` | `0xF6daC4BC4e721c5C84504A5Bfe033AE63722f8c9` |
| `Voting` | `0x948c71E7134E82c8d71e1bAD781F5BD4B96A14C0` |
| `FollowRegistry` | `0x96A3274Fa3696bbF5F8e1D8B58455300B9b7032E` |
| Chain | Products Devnet, chainId **420420417**, ETH RPC `https://paseo-assethub-rpc.laissez-faire.trade` |
| Deployer | `5Fk6mNEA…P1qP5R` / `0x82A06d…B345` — **sr25519**, ~4900 PAS |

⚠️ **Use the `@polkadot-community-foundation/*` CLIs, never `@parity/*`.** Both scopes publish a `pad`
at the same version; the `@parity` one cannot deploy and fails with a convincing but fictitious
Bulletin authorization error. Cost an hour. See gotchas.

## What works, verified on a real device

- **Anonymous reading**, everywhere, needing nothing — contracts via `eth_call`, bodies via gateways.
- **All four contracts deployed.** `node contracts/scripts/verify-deployment.mjs`. Contract tests
  **136 passing, 0 failing**.
- **Arm 1 — host-signed contract writes.** A profile was created on chain from the phone, with the
  product account as `msg.sender`. `lib/host/contracts.ts` → `HostBackend.writeContract` →
  `createContractFromClient(...).tx()`.
- **Forum reads** — `PostRegistry.getHeadsPaged` + `walkChain` over Bulletin.
- **Profile-feed reads** — `PostRegistry.headOf(FEED_REGISTRY, user)` + `walkChain`.
- **Reply reads and writes are wired** — a thread's replies are their own open registry,
  `keccak256("thread:" + parentCid)` (`frontend/src/lib/registry.ts`), read with `getHeadsPaged` +
  `walkChain` and written through `usePublisher` with the board as `HeadSet.group`. **[I]** — the
  path is identical to the thread write that is **[V]** on a real device, and it was exercised
  end-to-end against the fake backend (validation, encode, Bulletin write, then the fake's
  deliberate `writeContract` refusal). **Not yet published from a phone**, so the on-chain half of
  the reply write is inference, not verification. Reads run against the live chain.
  ⛔ **Replies are FLAT.** The wire format has no parent pointer, so nesting is not representable;
  `parentReplyIndex`/`depth`/`children` and the reply-to-a-reply control were removed rather than
  left to fail. Threading, if wanted, is a nested registry — a product decision, not a missing
  function.

- ⭐ **CONTENT CREATION WORKS. Proven on a phone 2026-07-30** — two threads published to
  `FORUM_REGISTRY`, bodies on Bulletin, pointers on chain, read back on a different machine. The
  second extends the first by `prev`, so the backwards walk is confirmed on real data too.
- ⭐ **The Bulletin preimage channel carries a real write.** Settled by the same act; it was the last
  unconfirmed half of the write path. `CloudStorageClient` remains unreachable on an `rpc-gateway`
  host, so the fallback is not a fallback in practice — it is the path.
- **The pointer is host-signed (`setHead`), not delegate-signed (`setHeadFor`).** So expect one signing
  prompt per post. Correct until `authorizeDelegate` is wired; the delegate is currently unauthorised
  *and* unfunded, which is what produced `code 1012`.

## What does NOT work

- **Chat messages cannot be created** — they need the same publisher, but `useChannel` still calls a
  deleted contract (below), so there is nothing to hang it on yet. Replies no longer belong on this
  list; see above.
- **Channels/chat are un-migrated** — `useChannelRegistry` and `useChannel` still call deleted
  contracts and produce `require(false)` reverts.
- **Editing is not wired.** A Bulletin object cannot change, so an edit publishes a replacement — and
  what that should do to the existing replies and vote tally is an undecided product question, not a
  missing function.
- **"+ New Channel" offers an impossible action** — creating a room is no longer a deployment. An open
  room is `keccak256(name)`; a moderated one is `PostRegistry.claimRegistry(salt, policy)`.
- **Owner-only calls still on the delegate path** — `setDisplayName`, `setBio`,
  `transferProfileOwnership`, `authorizeDelegate`. They will hit the same unfunded-delegate failure
  `createProfile` did (`code 1012`); move each to `writeContract`.

## Next actions, in order

1. **Deep links are POSITIONAL and therefore wrong.** `?thread=0` means "the newest thread", not a
   particular one, so a shared link silently retargets the moment anyone posts. Every item now carries
   its `cid` (see `types/contracts.ts`), so this is a small change to `?cid=` — and it is the last
   place the deleted contracts' positional identity is still load-bearing.
2. **Move the remaining owner-only calls to `writeContract`** — start with `authorizeDelegate`, since
   "SET UP POSTING KEY" is offered in the UI and would fail today. That is also what removes the
   per-post signing prompt: with a live delegation, `usePublisher`'s `writeHead` switches to
   `setHeadFor(author, …)` and nothing else changes.
3. **Migrate `useChannelRegistry` / `useChannel`** the way `useForumThread`, `useUserPosts` and
   `useReplies` were: heads from `PostRegistry` for a `bytes32` registry id, then `walkChain`.
   Replace "+ New Channel" with claiming a registry id. A room id is `openRegistryId("room:<name>")`
   from `frontend/src/lib/registry.ts` — do not compute one anywhere else.
   ⭐ **Publish one reply from a phone** while you are in there: the reply write path is wired and
   fake-tested but has never touched the chain, so it is the last **[I]** in the write column.
4. **Adopt the app-side personhood check** — `PeopleLite.LitePeople[account]` on the Individuality
   chain. Real one-human-one-account, and much stronger than `hasProfile`, which gates nothing.
5. Delete the dead ABIs (`ChatChannel`, `ChannelRegistry`, `ForumThread`, `Replies`, `UserPosts`) once
   their consumers are gone.

## Settled — do not re-litigate

- **Contract dependency wiring: option A.** The three satellites pin `UserRegistry` as a compile-time
  `constant` and take no constructor arguments, because cdm hard-codes empty constructor calldata
  (`data = new Uint8Array(0)`, read from source). Pinning is also the correct semantics: resolving the
  CDM name at call time follows the *latest* version, and cdm's salt includes the version, so a
  redeploy lands on empty storage and would silently invalidate every delegation. Pin is to **v0**;
  `deployments.json` must agree; grep `PLAZA-USER-REGISTRY-ADDRESS`.
- **Personhood: the app can check it, Solidity cannot.** `PeopleLite.LitePeople` is keyed by account
  and has 151 entries. The Asset Hub precompile resolves through `AccountToAlias`, empty in all three
  places it exists, so it returns 0 for everyone — a gate on it would reject everybody. `Voting` keeps
  `hasProfile`. Reproduce: `node contracts/scripts/probe-personhood.mjs`.
- **Bulletin writes need the preimage fallback.** A host in `rpc-gateway` chain-backend mode answers
  `featureSupported({Chain})` from a three-element list — relay, Asset Hub, People — that never
  contains a Bulletin chain, so `CloudStorageClient` fails for *every* Bulletin genesis. A
  devnet→paseo fallback cannot help; the preimage channel bypasses the chain bridge entirely.
- **Deploys are not rate-limited by personhood.** The "1/day Lite, 5/day Full" claim applies to
  `pad --publish` (the Browse listing), not to a deploy. Several deploys an hour work fine.

## Questions still unanswered

1. Does a granted `BulletinAllowance` actually suppress prompts? **Inference only.**
2. Is a PGAS-funded storage deposit refunded in PGAS, or a one-way burn?
3. **No third-party Bulletin renewal has ever happened on this chain.** Do one `force_renew` by a
   non-storer before building the preservation screen on it.
4. Does the host's own product account need `map_account` (0.2 PAS **native**, not PGAS)?
5. **What else does the Individuality chain give us?** `ProofOfInk`, `MobRule` (a dispute/jury system
   with credits and payouts), `Members`, `Honour`, `Score`. `MobRule` looks directly relevant to
   moderation, which §7 currently solves with a per-registry admin.
6. Preimage-written content has **no `(block, index)` receipt** and Bulletin `renew` is positional —
   so how is it renewed at all? This may make the preservation screen impossible for that path.
7. All four `*_asset_hub_metadata` chunks (~3.4 MB) ship in the bundle even though two are
   unreachable. Something pulls the whole preset table in; not yet traced.

## Human-only steps

- **Personhood on the phone.** Gates PGAS minting, `pad --publish`, and short domain names — and it is
  what would put an account into `PeopleLite.LitePeople`, making the app-side check meaningful for us.
  It does **not** by itself unblock the contract-side check.
- Faucet top-ups: `faucet.polkadot.io`, **SS58** address, 5000 PAS / 24 h, captcha.
