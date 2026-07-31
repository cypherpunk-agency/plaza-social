# STATUS — read this first

Short by design. The long reasoning is in [`architecture.md`](architecture.md); the traps are in
[`gotchas.md`](gotchas.md). **Last updated 2026-07-30.**

## Live right now

| What | Where |
|---|---|
| App | **https://plaza-social.dev-dot.li** — `plaza-social.dot` (`.dot.li` serves it too) |
| Bundle CID | `bafybeibnvl7qnwv7r3q4skp4pru7q3ztcnc6evng3cib3syc6qfeqkfe2q` — a **CAR file**, fetchable whole, NOT pathable (2026-07-31). |
| Source | `github.com/Tomen/plaza`, branch `claude/polkadot-products-sdk-review-b2cff4` |
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
  **[V] They are no longer reachable from the UI (2026-07-30).** The whole Channels surface was
  unwired: the sidebar section, the chat view (`ChannelHeader`/`ChatFeed`/`MessageInput`), the
  participant panel, the moderation modal, and "+ New Channel". `ViewMode` no longer has a
  `'channels'` member, so nothing can route there — verified in the fake backend that a persisted
  `viewMode: 'channels'` and a `?channel=0x…` deep link both land on the forum, with the stale param
  dropped from the address bar. **No files were deleted**: `useChannel`, `useChannelRegistry`,
  `ChatFeed`, `MessageInput`, `ChannelHeader`, `ChannelModerationModal`, `UserListPanel` and
  `CreateChannelModal` all remain on disk, unreferenced, as the starting point for the migration.
- **Editing is not wired.** A Bulletin object cannot change, so an edit publishes a replacement — and
  what that should do to the existing replies and vote tally is an undecided product question, not a
  missing function.
- ~~**"+ New Channel" offers an impossible action**~~ **[V] Removed 2026-07-30, along with the rest of
  the Channels UI.** It called `deployUnlistedChannel` on the deleted `ChannelRegistry`, but the
  deeper problem was conceptual: creating a room is not a deployment. An open room is
  `keccak256(name)`; a moderated one is `PostRegistry.claimRegistry(salt, policy)`. There is nothing
  per-room to deploy, so there was no version of that button that could have worked. **[?] What
  replaces it is undecided** — joining a room by name needs no transaction at all, so the affordance
  may not be a "create" button in any form.
- **Owner-only calls still on the delegate path** — `setDisplayName`, `setBio`,
  `transferProfileOwnership`, `authorizeDelegate`. They will hit the same unfunded-delegate failure
  `createProfile` did (`code 1012`); move each to `writeContract`.

## Next actions, in order

1. ~~**Forum deep links are POSITIONAL and therefore wrong.**~~ **[V] Done for THREADS, 2026-07-31.**
   `?cid=<threadCid>` is the thread deep link; `?thread=N` is still parsed so published links keep
   working but is **never written** — `ForumView` resolves the position against the loaded page and
   the URL rewrites itself to `?cid=`. `cid` wins when both are present; a malformed `?thread=`
   selects nothing rather than what `parseInt` would guess. Parse/project pair and its tests:
   `frontend/src/lib/threadLink.ts`. Verified in the fake backend at 375px and 1280px+: `?cid=`
   round-trips, `?thread=1` upgrades itself, browser Back re-derives from the URL.
   Shipped with it: the forum is now **master–detail** (list only below `xl`, two panes at/above it)
   with body text capped at `max-w-[70ch]`, and a **COPY LINK** control that emits
   `https://plaza-social.dot/?cid=…` — `.dot`, so the link routes *inside* the container.
   ⚠️ **[?] Never exercised inside a real host.** `Clipboard` is a host device permission and a
   missing one fails silently, so `lib/clipboard.ts` writes and reads back and can report
   `copied` / `unverified` / `failed`. On a desktop browser the write **[V]** resolves under a real
   click but the read-back is skipped (querying it would prompt the user), so the honest outcome
   there is `unverified`. **Nobody has yet pressed COPY LINK on a phone.**
   ⛔ **`?post=N` on the profile feed is STILL POSITIONAL.** Same bug, same fix, not done —
   `UserPost` already carries `cid`, but `PostDetailView`/`useUserPosts` belong to another change.
2. ⭐ **Take the app to a phone and exercise the four things only a device can settle.** Everything
   below this line in the write column is `[I]`, and one session with the app open converts most of
   it. In priority order:
   - **Send one CASH tip.** The whole path above the host boundary is tested; the host call has never
     run. If it fails, suspect the unexplained *"Protected asset access requires value-transfer
     authorization"* on pUSD **before** suspecting a malformed call — that is written into the code.
   - **Publish one reply.** The last `[I]` in the write column; identical to the thread write that is
     `[V]`, but never actually on chain.
   - **Press COPY LINK.** `Clipboard` is a host device permission and a missing one fails silently.
     `lib/clipboard.ts` reports `copied`/`unverified`/`failed`; find out which one a phone gives.
   - **Look at the app.** No agent has ever *seen* it — the Browser pane does not composite frames, so
     every layout and colour claim in this repo is numeric inference. Contrast, spacing and the new
     focus ring are unreviewed by eyes.

3. **Move the remaining owner-only calls to `writeContract`** — start with `authorizeDelegate`, since
   "SET UP POSTING KEY" is offered in the UI and would fail today. That is also what removes the
   per-post signing prompt: with a live delegation, `usePublisher`'s `writeHead` switches to
   `setHeadFor(author, …)` and nothing else changes.

4. **Two accessibility/layout defects that undo work already done.** Both are small and both hit the
   primary surface:
   - ⛔ **The sidebar is a fixed `w-64` with no responsive behaviour.** Measured at 375×812 it takes
     **176px of 375** — 47% of a phone screen, leaving thread titles 196px. The forum was just capped
     to a readable measure and this undoes it. A drawer behind the existing `☰` is the fix.
   - ⛔ **Thread titles are `<h3 onClick>`** (`ThreadCard.tsx:122`, `:145`) — no tab stop, no
     Enter/Space, announced as static text. This is the app's primary navigation affordance and it is
     unreachable by keyboard. Make it a `<button type="button" className="text-left …">`.
   - Minor, same class: `App.tsx:564` and `:585` settings buttons have no hover class at all.
5. **Migrate `useChannelRegistry` / `useChannel`** the way `useForumThread`, `useUserPosts` and
   `useReplies` were: heads from `PostRegistry` for a `bytes32` registry id, then `walkChain`.
   A room id is `openRegistryId("room:<name>")` from `frontend/src/lib/registry.ts` — do not compute
   one anywhere else. **This is now a re-wiring job, not a repair**: the hooks and components are
   intact but no longer imported anywhere, so restoring chat means migrating them and putting the
   nav entry back in `Sidebar.tsx` plus a `'channels'` member back on `ViewMode`. Note there is no
   "create a room" step to restore — an open room needs no transaction.
   ⭐ **Publish one reply from a phone** while you are in there: the reply write path is wired and
   fake-tested but has never touched the chain, so it is the last **[I]** in the write column.
6. **`?post=N` on the profile feed is still POSITIONAL** — the same bug `?thread=N` had, unfixed.
   `UserPost` already carries `cid`, and `lib/threadLink.ts` is the pattern to copy. Pairs naturally
   with **optional titles on profile posts**: a titled post is a `thread` announcement written into
   `FEED_REGISTRY` pointing at a `post` body, which needs no wire-format change and gives
   cross-posting for free (N announcements, one body).
7. **Adopt the app-side personhood check** — `PeopleLite.LitePeople[account]` on the Individuality
   chain. Real one-human-one-account, and much stronger than `hasProfile`, which gates nothing.
   ⚠️ It was **151** entries when first measured and **157** on 2026-07-30 — it drifts; re-read it,
   never quote the number.
8. Delete the dead ABIs (`ChatChannel`, `ChannelRegistry`, `ForumThread`, `Replies`, `UserPosts`) once
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
- **CASH is Coinage; `payment.*` is how you spend it.** Both RFC-0006 requests are keyed on
  `CoinPaymentPurseId`, so `requestPayment` is the *account-addressed view of the same CASH purse* —
  not a substitution of pUSD for CASH. `coinPayment` (RFC-0017) is the bearer/merchant surface and
  cannot serve a tip: the payee must be present to mint a receivable, delivery rides the
  personhood-gated statement store, and no host implements it (zero handlers in the reference bundle,
  none wrapped by `product-sdk-host`). pUSD (asset **50000413**, 6dp) is only the denomination.
- **Two money units, and mixing them is a 10⁴ error.** RFC-0006 `Balance` is `u128` **plancks**;
  RFC-0017 `CoinPaymentBalance` is `u32` **cents**. Confirmed against Parity's own `w3spay` on a real
  host: `plancks = cents × 10^(6−2)`. And `pallet-coinage` sets `UnderlyingAssetUnit = 10⁴`, so
  **sub-cent amounts cannot exist as coins** — the UI takes 2 decimals, not 6.
- **`Revive.AutoMap = true`, so nobody calls `map_account`.** It is a runtime **constant** — reading
  it as *storage* returns `null`, which looks exactly like `false`. `Revive.OriginalAccount` (4236
  entries) is the H160→AccountId32 route. ⛔ **Never derive one.** `h160ToSs58()` was measured against
  the real user and yields a *different* account; tipping it destroys the funds. Resolve, or refuse.
- **Colour utilities must be declared in `@theme static`, not a hand-written list.** Tailwind only
  generates variants for colours it knows about. The old `:root` + manual-utility approach meant
  `hover:text-primary-400` (22 uses), `focus:border-primary-400` (18) and ~5 other heavily-used
  classes **did not exist in the built CSS at all** — which is why orange controls had no highlight
  while the red DELETE beside them did. See `frontend/CLAUDE.md` § Interaction states.

## Questions still unanswered

1. Does a granted `BulletinAllowance` actually suppress prompts? **Inference only.**
2. Is a PGAS-funded storage deposit refunded in PGAS, or a one-way burn?
3. **No third-party Bulletin renewal has ever happened on this chain.** Do one `force_renew` by a
   non-storer before building the preservation screen on it.
4. ~~Does the host's own product account need `map_account`?~~ **[V] ANSWERED — no.**
   `Revive.AutoMap = true`; mapping is automatic on first use and the 0.20052 PAS hold is moot.
9. **What grants "value-transfer authorization" on pUSD?** Of 661 assets on Asset Hub, **50000413 is
   the only protected one** — every value method on its precompile reverts with that string while
   USDC and PGAS controls answer fine. It is not the `from` address, and the phrase appears nowhere
   in any `@parity` package. Whether `requestPayment` bypasses or wraps it is unproven. **If a real
   tip fails on a device, this is the first suspect, not a malformed call.**
10. **Does the host settle `requestPayment` as a Coinage transfer or a plain pUSD transfer?** Parity's
    own two references contradict each other.
11. **Does the production Polkadot app implement RFC-0006 at all?** The reference test host ships
    exactly four payment handlers and the public iOS bridge agrees, but the Android app is
    closed-source. Strong `[I]`, not `[V]`. There is no feature probe — the `Feature` union is only
    `{tag:'Chain'}` — so a phone is the only way to know.
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
