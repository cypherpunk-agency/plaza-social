# CLAUDE.md

Guidance for Claude Code working in this repository.

## ⚠️ READ THESE FIRST

Plaza is mid-migration onto the **Polkadot Products platform**. Much of the older documentation in this
repo describes the pre-migration app and is wrong. These four files are current and authoritative:

| File | Read it for |
|---|---|
| **[`docs/products-platform/STATUS.md`](docs/products-platform/STATUS.md)** | **Start here.** What is live, what is broken, the open decision, next actions. Short. |
| [`docs/products-platform/gotchas.md`](docs/products-platform/gotchas.md) | Addresses, constants, and ~25 traps that fail *silently*. Check before debugging anything. |
| [`docs/products-platform/architecture.md`](docs/products-platform/architecture.md) | The design and **why** — content model, where state lives, retention, signing. Every non-obvious choice traces to a section here. |
| [`docs/products-platform/publishing.md`](docs/products-platform/publishing.md) · [`pgas-deposits-and-renewal.md`](docs/products-platform/pgas-deposits-and-renewal.md) | Deep verified references on the deploy pipeline and on PGAS/deposits/renewal. |

Claims in those files are tagged **[V]** verified / **[I]** inference / **[?]** unknown, with method and
date. **Keep that convention** — a stale `[V]` is worse than a `[?]`, and this project has been bitten by
exactly that (see gotchas § *Documents that are wrong*).

Related repo: `D:\Code\web3\yolodot` — a separate set of experiments on the same platform. Excellent
source of working reference code and measurements, but **several of its `[V]` claims are stale**; verify
before relying on them.

## What Plaza is now

A static bundle published to Bulletin, bound to a `.dot` domain, running **inside the Polkadot host
container**. Post bodies are immutable Bulletin objects chained backwards by `prev`; the only mutable
state is a head pointer per (registry, writer) held on chain.

**The host container is the only surface.** There is no MetaMask path and no standalone wallet — both
were deleted. Anonymous reading still works inside the host.

**Live:** https://plaza-social.dot.li · chainId `420420417` · **all four contracts deployed**
(addresses in STATUS.md and `contracts/deployments.json`).

**Host-signed contract writes work** — a profile was created on chain from the phone (2026-07-30).
**Content creation works, proven on a phone.** The two-signature write — body → Bulletin, then
pointer → `PostRegistry` — lives in `frontend/src/lib/publish.ts`; threads, profile posts and replies
are on it. Voting, forum master–detail, `?cid=` deep links and CASH tipping are wired.

**What is still `[I]` rather than `[V]`** is anything whose last mile needs a device: the reply write
has never touched the chain, no CASH tip has ever run against a real host, COPY LINK has never been
pressed on a phone, and **nobody has ever looked at the app** — the Browser pane does not composite
frames, so every visual claim here is numeric inference. Chat is un-migrated and unwired from the UI.
See STATUS.md before assuming a feature works.

## Quick start

### Contracts (`contracts/`)
```bash
npm test              # 136 tests, plain solc on the in-process EVM
npm run build:cdm     # PolkaVM build via resolc (this is what cdm deploys)
npm run deploy:devnet -- --suri "$SEED_PHRASE"   # cdm deploy, -n devnet
node scripts/verify-deployment.mjs    # what is ACTUALLY on chain
node scripts/probe-personhood.mjs     # why personhood cannot gate a write
```
⚠️ **`cdm deploy` redeploys everything it finds, at new addresses, as new versions** — there is no
unchanged-code skip and no subset flag. Do not run it casually; it will orphan live instances along
with their storage. To deploy a subset, move the rest out of `contracts/` for that one command.
There are **two Hardhat configs on purpose**: `hardhat.config.cjs` (PolkaVM/resolc, for cdm) and
`hardhat.evm.config.js` (plain solc, tests only). They must keep separate artifact directories.
**Never deploy with `hardhat run --network`** — the funded account is sr25519 and cannot sign an
Ethereum transaction. See gotchas.

### Frontend (`frontend/`)
```bash
npm run dev                    # Vite dev server
npm run build                  # tsc -b && vite build
npm run test:lib               # 91 data-layer tests, zero dependencies
npm run test:host              # Playwright against a real Spektr host
```
**The SDK throws outside a host container**, so local development runs against the fake backend:
`?backend=fake&caps=write` is the scenario that matters most. Use it because the loop is fast — **not**
because publishing is scarce: the "1/day" rate limit this file used to assert was falsified on
2026-07-30 (two deploys, 20 minutes apart). See gotchas § Publishing.

## Contract set

```
UserRegistry     profiles, links, delegation with expiry     0xfD00289e…F055FBD7   v0, PINNED
PostRegistry     head pointer per (registry, writer)         0xF6daC4BC…3722f8c9
Voting           tallies keyed by CID                        0x948c71E7…B96A14C0
FollowRegistry   follow graph, enumerable both ways          0x96A3274F…B9b7032E
```

A chat room, a board, a thread and a profile feed are all just `bytes32` registry ids inside the one
`PostRegistry`. There is nothing per-room or per-thread to deploy.

**The other three pin `UserRegistry` as a compile-time `constant` and take no constructor arguments**,
because cdm hard-codes empty constructor calldata. That is also the right semantics: resolving the CDM
name at call time would follow the *latest* version and a redeploy lands on empty storage, silently
invalidating every delegation. To change the pin, grep `PLAZA-USER-REGISTRY-ADDRESS`, edit all three,
recompile, redeploy — and keep `deployments.json` in agreement.

**Deleted:** `ChatChannel`, `ChannelRegistry`, `DMConversation`, `DMRegistry`, `OnChainChat`,
`lib/Moderation`, `posts/{ForumThread,UserPosts,Replies}`.

## ⛔ The SDK path is the only path

**If the platform provides a capability, use it and build nothing beside it.** No second
implementation, no HTTP substitute, no "fallback in case the SDK is unavailable" — an unavailable SDK
capability is an error to **surface**, not a branch to route around. The word "fallback" is the tell
that you are about to break this.

Learned twice on 2026-07-31: post bodies were read over public IPFS gateways (which made the host
prompt the user to approve an external origin) when `CloudStorageClient.fetchBytes`/`fetchJson` read
them through the host itself; and the first proposed fix — "prefer the SDK, fall back to gateways" —
was the same bug again. **"Anonymous reading, everywhere, needing nothing" means no wallet and no
sign-in. It does not mean no host.** Local development uses the fake backend (`?backend=fake`), never
a resurrected HTTP path. Full detail and the current audit list: gotchas.md § *THE SDK PATH IS THE
ONLY PATH*.

## Core concepts

**Storage does not accumulate.** One head per (registry, writer); the deposit is paid once and reused
forever. The thousandth message in a room costs no new storage. Do not add per-post arrays — that is the
mistake this design replaced.

**Delegation, and its one hard rule.** A locally-derived key signs contract writes prompt-free. Every
delegated call **names its principal** (`setHeadFor`, `followFor`, `voteFor`) and the callee checks
`canActAs`. There is no reverse lookup from a delegate to an owner, because a delegate address is only
unique per owner and guessing would misattribute a post.

**Two signers per post, both prompt-free.** The body goes to Bulletin signed by the host; the pointer
goes to the contract signed by the delegate. A delegate cannot write Bulletin at all.

**Moderation cannot mean deletion.** Freeing storage refunds whoever freed it, so a moderated delete
would hand an admin the writer's deposit. Moderation is a write gate plus a hide flag; if content must
actually go, the mechanism is Bulletin retention — stop renewing it.

**Encrypted DMs are gone.** The platform offers no 1:1 messaging primitive, so the feature was dropped
rather than delegated. `sessionPublicKeys` and the whole ECDH layer went with it.

**Personhood: the app can check it, Solidity cannot.** Personhood lives on the **Individuality /
People chain**, not Asset Hub — reach it zero-config as `getChainAPI("devnet").individuality`
(`wss://people-paseo.rotko.net`). `PeopleLite.LitePeople` is keyed by plain account and has 151
entries, so **an app-side personhood gate works today and we should use it**. Full personhood is not
account-resolvable yet, so never require it. What does *not* work is the Asset Hub precompile a
contract would have to call: it resolves through `AccountToAlias`, empty everywhere, so it returns 0
for everyone — hence `Voting` gates on `hasProfile`. Run `contracts/scripts/probe-personhood.mjs`
before re-proposing anything here.

## Older documentation — treat with suspicion

`frontend/docs/user-flow.md` and `frontend/docs/STYLE_GUIDE.md` still document DM flows and wallet modes
that no longer exist. `contracts/CLAUDE.md` is **stale in its Commands and Configuration sections**
(`deploy:polkadot`, chainId 420420422, "stock Hardhat + solc") — its per-contract detail is current.
`frontend/CLAUDE.md` has been updated for the migration.

## Important notes

- Contract ABIs are hand-copied to `frontend/src/contracts/` after contract changes.
- `deployments.json` lives in `contracts/` and is copied to `frontend/public/`.
- Secrets are in `contracts/.env` (gitignored): `SEED_PHRASE`, `DOTNS_MNEMONIC`. Never print or commit.
- **Always pass `--env devnet` to `pad` and `-n devnet` to `cdm`.** Both default elsewhere, and the wrong
  default succeeds silently on the wrong network.
- ⚠️ **The CLIs are `@polkadot-community-foundation/*`, NOT `@parity/*`.** Both scopes publish a `pad`
  with the same version number; the `@parity` one cannot deploy and fails with a convincing-looking
  Bulletin authorization error. Deploy command that works:

  ```bash
  npx @polkadot-community-foundation/polkadot-app-deploy@latest frontend/dist plaza-social.dot --env devnet --mnemonic "$MNEMONIC"
  ```
