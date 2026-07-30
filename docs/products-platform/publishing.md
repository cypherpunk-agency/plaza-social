# Publishing an app on the Polkadot Products Devnet

**All checks in this file were run on 2026-07-29** unless a different date is stated.
Machine: Windows 11, Node v22.22.0, npm global prefix `C:\Users\tommi\AppData\Roaming\npm`.

Every claim is tagged **VERIFIED** (I ran the command / read the source / observed the
response), **INFERENCE** (derived from evidence, not directly observed), or **UNKNOWN**.
Nothing that spends, registers, publishes, or signs was executed. All chain interaction was
read-only.

> **Read this first: there are two different toolchains and three different gateways.**
> This document is about the **Products Devnet** (`--env devnet`, gateway `dev-dot.li`),
> documented at `docs.polkadotcommunity.foundation`. `docs.polkadot.com/apps/` documents a
> *different* pipeline (`playground` / `pg` CLI, gateway `dot.li`) on a different network.
> They are not interchangeable. See [§8](#8-the-two-toolchains-do-not-mix).

---

## 1. The pipeline, end to end

**VERIFIED — architecture** — `https://docs.polkadotcommunity.foundation/architecture/app-delivery/`
(fetched via the MkDocs search index `search/search_index.json`, 2026-07-29):

> "The CLI merkleizes the build directory into a content-addressed DAG-PB archive, chunks it
> (~2 MiB) and uploads the blocks to Bulletin via `TransactionStorage.store_with_cid_config`,
> then writes the resulting root CID as an ENS-style `contenthash` (`0xe301` + CIDv1) into the
> DotNS `ContentResolver` on Asset Hub."

| Stage | Tool | Chain touched | Evidence |
|---|---|---|---|
| Build static bundle | your bundler (`vite build` → `dist/`) | none | VERIFIED: all 4 live devnet bundles I inspected carry `"framework": "vite"` in their deploy manifest |
| Merkleize + upload blocks | `pad <dir> <name>.dot --env devnet` | **Bulletin (para 1010)** | VERIFIED (docs above) |
| Register the name (if not owned) | `pad` implicitly, or `dotns register domain` | **Asset Hub (para 1000)**, PolkaVM contracts | VERIFIED |
| Bind name → CID (`contenthash`) | `pad`, or `dotns content set` | **Asset Hub (1000)** | VERIFIED |
| Optional directory listing | `pad --publish` → `Publisher.publish(label)` | **Asset Hub (1000)** | VERIFIED — see §2 |
| Serve | `https://<label>.dev-dot.li` gateway, or `<label>.dot` in the Polkadot app | reads Asset Hub + Bulletin/IPFS client-side | VERIFIED — see §5 |

**VERIFIED — the contenthash format.** `dotns content view plaza-social --env devnet --json`:

```json
{"domain":"plaza-social.dot",
 "contenthash":"0xe301017012207dfc65a48ab86e37528638c13d46ab26e590d7a06aa1a7af9f98cc04743d54ee",
 "cid":"bafybeid57rs2jcvyny3vfbryye6unkzg4winpidkugt27h4yzqchipku5y"}
```

**VERIFIED — the tools, current versions (npm, 2026-07-29).** `npm view <pkg> version time.modified`:

| Bin | Package | npm `latest` | Published |
|---|---|---|---|
| `dotns` | `@polkadot-community-foundation/dotns-cli` | **0.8.1** | 2026-07-28 |
| `pad`, `pad-bootstrap` | `@polkadot-community-foundation/polkadot-app-deploy` | **0.13.1** | 2026-07-20 |
| `cdm` | `@polkadot-community-foundation/cdm-cli` | **0.8.26** | 2026-07-17 |
| — | `@parity/product-sdk` (umbrella) | **0.19.1** | 2026-07-21 |

**The CLIs also exist under `@parity/` — AND THEY ARE NOT INTERCHANGEABLE.** `@parity/dotns-cli` is
also at `0.8.1` and `@parity/polkadot-app-deploy` is also at `0.13.1`; the latter declares
`repository: git+https://github.com/paritytech/polkadot-app-deploy.git`. Versions and release dates
track exactly, and tarball shasums differ.

⛔ ~~**INFERENCE:** these are the same builds under two scopes.~~ **FALSIFIED [V] 2026-07-30 — and
acting on this inference cost an hour.** `@parity/polkadot-app-deploy@0.13.1` **cannot deploy**: it
refuses on every derived Bulletin pool account with *"not authorized (or its authorization expired) …
no longer self-authorizes on the Bulletin chain"*. `@polkadot-community-foundation/…@0.13.1` deployed
the identical bundle with the identical mnemonic minutes later, first attempt. Matching version numbers
prove nothing about behaviour.

Two symptoms that distinguish them, worth knowing because the failure mode is so misleading:
- The `@parity` build prints `https://<name>.dot.li`; the community-foundation build prints
  `https://<name>.dev-dot.li`. Both hostnames serve the app, so the difference reads as cosmetic.
- The `@parity` build's failure names chain state (`pool account … is not authorized`), which invites
  you to debug Bulletin authorization. `dotns bulletin status` will happily confirm your own account
  IS authorized, which makes the wrong story more convincing rather than less.

**Always install/run the `@polkadot-community-foundation/*` names.** That is what the devnet docs
install and what the other project uses successfully several times a day.

### 1.1 The minimal happy path (bash / Git Bash)

```bash
node --version                                    # must be 22+ (see §7)

npm i -g @polkadot-community-foundation/dotns-cli \
         @polkadot-community-foundation/polkadot-app-deploy

export MNEMONIC="…"            # pad reads MNEMONIC
export DOTNS_MNEMONIC="$MNEMONIC"   # dotns reads DOTNS_MNEMONIC
dotns account address                             # → SS58. Fund THIS.
# 👤 faucet (captcha)              — §2.2
# 👤 Bulletin storage auth OR CLI  — §2.3
dotns account map --env devnet                    # map SS58 → EVM (once)
dotns bulletin status <SS58> --env devnet --json   # confirm authorized:true, expired:false
npm run build                                     # → dist/
pad ./dist my-cool-app.dot --env devnet --mnemonic "$MNEMONIC"
dotns content view my-cool-app --env devnet        # confirm the CID
```

**Windows/PowerShell:** `--mnemonic "$MNEMONIC"` is *bash*. In PowerShell `$MNEMONIC` expands as a
PowerShell variable, not an env var, and silently becomes `--mnemonic ""`. Use `"$env:MNEMONIC"`, or
better omit the flag and let the CLIs read the environment. (Carried over from the prior notes;
**not re-tested here** — UNKNOWN whether still true, but the mechanism is a shell property, not a
CLI property, so it holds.)

### 1.2 Manual / debugging path

**VERIFIED** — `dotns bulletin upload --help`, `dotns content set` exist, so the two halves of a
`pad` deploy can be run separately:

```bash
dotns bulletin upload ./dist --env devnet --print-contenthash   # → CID
dotns content set my-cool-app <cid> --env devnet
```

`upload` flags (VERIFIED from `--help`): `--bulletin-rpc`, `--chunk-size <bytes>` (default
`2097152`, clamped 256 KB–2 MB), `--max-retries <n>` (default 5, cap 20), `--force-chunked`,
`--concurrency <n>` (default 16, max 64), `--print-contenthash`, `--resume`, `--profile-upload`,
`--profile-output`, `--no-history`, `--cache`, `--json`, `--reporter <auto|interactive|stream|quiet>`.

### 1.3 `pad` flags that matter (VERIFIED, `pad --help`, v0.13.1)

| Flag | Behaviour |
|---|---|
| `--env <id>` | **Default `paseo-next-v2`.** Valid: `paseo-next-v2`, `devnet`. Drives *both* the Bulletin RPC and the Asset Hub RPC. |
| `--mnemonic "…"` | DotNS owner mnemonic, or `MNEMONIC` env var. Also the account that uploads. |
| `--derivation-path "…"` | Substrate path applied to `--mnemonic`, e.g. `//deploy/3` |
| `--publish` / `--unpublish` / `--fail-on-publish-error` | Directory listing; see §2.5. `--publish` failure is **non-fatal, exit 0** by default. |
| `--js-merkle` | Pure-JS merkleization; no IPFS Kubo binary needed |
| `--input-car <path>` / `--dump-car[=<path>]` | Deploy a prebuilt CAR / save the pre-upload CAR |
| `--config <path>` | Path to `polkadot-app-deploy.config.{ts,js,mjs}`; default walks up from `<build-dir>`. When found, deploy **also** writes manifest + executable text records on `<domain>` and its `app`/`widget`/`worker` subnames. |
| `--password "…"` | Encrypts the SPA; users are prompted to decrypt |
| `--pool-size N` | Pool accounts, default 10 |
| `--no-transfer-to-signedin-user` | Sign every DotNS tx with the mobile session instead of the default worker flow |
| `--contract <KEY>=<addr>` | Override a `DOTNS_*` address (repeatable) |
| `--environment-file <path>` | JSON deep-merged over bundled `environments.json`; **"values are not validated against chain"** |
| `--gh-pages-mirror` | Push the CAR to `gh-pages` at `bulletin/<domain>.dot.car` |

Subcommands (VERIFIED): `pad login` / `logout` / `whoami` / `transfer <domain.dot>`. A second
binary `pad-bootstrap` ships in the same package.

**VERIFIED** — `pad --list-environments`:

```
ID             Name             Network  Bulletin?  Description
paseo-next-v2  Paseo Next v2    testnet  yes        Next iteration of the Paseo Next testnet
devnet         Products Devnet  testnet  yes        Paseo system chains (Asset Hub 1000 / People 1004 / Bulletin 1010)
```

### 1.4 Endpoints and contract addresses (VERIFIED)

From the `environments.json` bundled with the installed `pad` 0.13.1
(`…\npm\node_modules\@polkadot-community-foundation\polkadot-app-deploy\assets\environments.json`),
`devnet` entry:

- Asset Hub (1000): `wss://asset-hub-paseo-rpc.n.dwellir.com`, `wss://sys.turboflakes.io/asset-hub-paseo`
- People (1004): `wss://people-paseo.rotko.net`, `wss://rpc.interweb-it.com/people-paseo`, `wss://people-paseo.gatotech.network`
- Bulletin (1010): `wss://bulletin-paseo.tservices.es:8443`, `wss://bullet.sik.rocks`
- IPFS gateway: `https://devnet-ipfs.api.polkadotcommunity.foundation`
- `registerStorageDeposit: 2000000000000`, `nativeToEthRatio: 100000000`
- `PUBLISHER: 0xaab42efbe8ea4d4228c3a11e973f94c17b9a0f2c` ← **see §2.5**
- `DOTNS_REGISTRY: 0x527b08a640b527a3dae0C4BE04D7344E430B6E50`,
  `DOTNS_CONTENT_RESOLVER: 0x326bdE29315199c814B1c58b431D84D16EA5cE41`,
  `POP_RULES: 0x2181a14081fF2D4477BAA8FB1aEB4C9c44F5F2b0`,
  `DOTNS_NAME_ESCROW: 0xfEdBe7a7F32017F6bCAA3109bE2EaC7D59E319E5` (full list in that file)

**VERIFIED** — `docs.polkadotcommunity.foundation/reference/networks/`: EVM chain id `420420417`;
native token PAS, 10 decimals; ETH JSON-RPC for contract tooling:
`https://paseo-assethub-rpc.laissez-faire.trade`. Second Bulletin IPFS gateway:
`https://bulletin-kubo.tservices.es:9443`.

---

## 2. Human vs. automatable

| Step | Who | Blocker |
|---|---|---|
| Generate a signing account | **automatable** | none |
| Fund it with PAS | **👤 human** | reCAPTCHA |
| Map SS58 → EVM | **automatable** | none |
| Bulletin storage authorization | **automatable on devnet** (was believed human-only) | see §2.3 |
| Register a 9+ char `.dot` name | **automatable** | none |
| Build + upload + bind | **automatable** | none |
| Proof of personhood | **👤 human, phone required** | biometric flow in the Polkadot app; no CLI path |
| List in Browse (`--publish`) | **👤 human prerequisite** | requires personhood (above) |

### 2.1 The account

**VERIFIED** — `docs.polkadotcommunity.foundation/guides/register-a-dot-name/`, the throwaway-account
recipe, works with only the crypto bundled in `dotns-cli`:

```bash
export MNEMONIC="$(NODE_PATH="$(npm root -g)/@polkadot-community-foundation/dotns-cli/node_modules" \
  node -e 'const c=require("@polkadot/util-crypto");c.cryptoWaitReady().then(()=>console.log(c.mnemonicGenerate()))')"
export DOTNS_MNEMONIC="$MNEMONIC"
dotns account address
```

**VERIFIED — sharp trap, and it is worse than "the CLI has no key".** With no
`DOTNS_MNEMONIC`/`DOTNS_KEY_URI` and no keystore, `dotns` signs as a **shared public account**.
Exact string from the installed `dotns` 0.8.0 `dist/cli.js`:

> `Warning: no account configured, signing with the shared public dev account that anyone can control. Set DOTNS_MNEMONIC / DOTNS_KEY_URI or run 'dotns auth set'.`

I saw that account in every read-only run I made today: `5DfhGyQdFobKM8NsWvEeAKk5EQQgYe9AydgJ7rMB6E1EqRzV`
/ `0x35cdb23ff7fc86e8dccd577ca309bfea9c978d20`. **A name registered while unconfigured is not
yours — anyone can transfer it away.**

The alternative is the encrypted keystore: `dotns auth set` (interactive) or
`DOTNS_KEYSTORE_PASSWORD=… dotns auth set --mnemonic "…" --account my-app`. Keystore default path
`%USERPROFILE%\.dotns\keystore` (`DOTNS_KEYSTORE_PATH`). **`dotns auth` has nothing to do with
Bulletin authorization** — it never touches a chain.

### 2.2 Faucet — 👤 human, captcha (VERIFIED)

Read live off `https://faucet.polkadot.io/paseo?parachain=1000` on 2026-07-29. Its own FAQ, quoted:

> "You will receive 5000 PAS per request."
> "You can request tokens every 24h! If you request PAS for one account, you can't request more for another parachain in that period."
> "To request funds, simply enter your Paseo wallet address, fill the captcha, and hit 'Submit'."

So: **5000 PAS**, **one request per account per 24 h across all parachains**, **captcha ⇒ not
automatable**. The pre-fill link works: `/paseo?address=<SS58>&parachain=1000` (and `?embed=true`
for an iframe layout). Paste the **SS58**, not an EVM `0x…`.

**Fund Asset Hub (1000) first** — it pays for names, mapping, publishing. People (1004) is only for
CASH / usernames / personhood.

⚠️ **VERIFIED** (`reference/networks/`, PCF docs): the faucet also lists **Asset Hub Next (1500)**
and **People Next (1502)**. Those are a different network — "Funds sent there will not appear on
this Devnet, and the balance you are waiting for will never arrive."

### 2.3 Bulletin storage authorization — **NOT necessarily a human step**

**VERIFIED — Bulletin is authorization-gated, not fee-gated.**
`docs.polkadot.com/reference/apps/infrastructure/bulletin-chain/authorization/`:

> "The Bulletin Chain has no token balance for storage. You cannot 'pay for storage' the way you pay
> a transaction fee on a typical chain. Instead, every account that wants to write to Bulletin needs
> an explicit authorization: an on-chain record that grants a quota of transactions and bytes, with
> an expiration block."

An authorization records **remaining transactions**, **remaining bytes**, and an **expiration
block**; unused capacity is *not* refunded at expiry.

**VERIFIED — the account that signs is the account that uploads.** PCF
`architecture/storage/`: "The account that signs an upload is the account that spends the quota — so
that is the account to authorize." `pad` never self-authorizes.

**⚠️ CORRECTION to the prior notes and to yolodot's `CLAUDE.md`.** The prior notes list Bulletin
authorization as a human-only step. **PCF docs now document a CLI path**
(`guides/build-and-publish/#get-storage-authorization`, quoted):

> "`dotns` can also grant the authorization directly, signed by the shared devnet authorizer:
> `dotns bulletin authorize <your-ss58-address> --transactions 1000 --bytes 104857600 --env devnet`
> This delegates from a shared authorizer budget, so request only what you need — 1000 transactions
> / 100 MiB comfortably covers a typical app, and raising `--transactions` / `--bytes` past the
> shared budget fails with `InsufficientAuthorizerBudget`."

**VERIFIED** that the command exists with those flags (`dotns bulletin authorize --help`), and that
its own defaults are much larger than the docs' suggestion: `--transactions` default **1000000**,
`--bytes` default **1073741824** (1 GiB). Also present: `--force`.
**UNKNOWN — I did not run it** (it signs a transaction), so I cannot confirm the shared authorizer
still has budget. Treat "automatable" as **likely but unproven**; keep the console path as fallback.

Sibling commands (VERIFIED, `dotns bulletin --help`): `refresh` — "Refresh (extend the expiration
of) a Bulletin account authorization"; `status`; `history`/`list`; `history:remove`;
`history:clear`; `verify <cid>`.

**Console path (👤 human, wallet signature).** VERIFIED live:

- Console: `https://paritytech.github.io/polkadot-bulletin-chain/`
- Authorizations: `…/polkadot-bulletin-chain/authorizations`
- Storage Faucet tab: `…/polkadot-bulletin-chain/authorizations?tab=faucet`
- Renew: `…/polkadot-bulletin-chain/renew`

⚠️ **CORRECTION to `docs.polkadot.com`.** Its
`/apps/get-started/get-testnet-tokens/` links to the authorizations page, and that URL returns
**HTTP 404** to a plain `curl` (verified: `http=404 bytes=544`, body is the GitHub Pages SPA
fallback carrying `<title>Bulletin Chain Console</title>`). It renders correctly in a browser. Do
not conclude the page is gone from a 404.

⚠️ **VERIFIED — the Console defaults to the WRONG network.** Its network id table (read from
`…/polkadot-bulletin-chain/assets/index-BAKDixVi.js`) contains
`"products-devnet":{id:"products-devnet",name:"Products Devnet",endpoints:["wss://bullet.tunastaking.eu","wss://bullet.sik.rocks"]…}`
alongside `"paseo-next-v2"`, and the module-level default is `` Kx=`paseo-next-v2` ``. Loading the
Console fresh shows **"Bulletin Paseo Next v2"**. You must switch to **Products Devnet** before
authorizing anything, or you grant a quota on a chain you are not deploying to.

**Pre-flight, automatable (VERIFIED, run today):**

```bash
dotns bulletin status <SS58> --env devnet --json
```

Real outputs, 2026-07-29:

```json
{"address":"5Fk6mNEAQtRFDpQd35SfrDGBGAsjukrPXct1eobjjEP1qP5R","rpc":"wss://bulletin-paseo.tservices.es:8443",
 "authorized":true,"expired":false,"transactions":100,"bytes":"10485760","expiresAt":"2026-08-07T22:26:37.454Z"}
{"address":"5Fk8FBTqBpAyBReZPse2wn8Lf4ADzdNVAsrGoNMSTxKedN8f","rpc":"wss://bulletin-paseo.tservices.es:8443",
 "authorized":true,"expired":true,"transactions":1501000,"bytes":"12387483648","expiresAt":"2026-07-29T14:49:38.832Z"}
```

The second account is the owner of `survey.dot` and `browse.dot`; its authorization **expired
earlier today** and both apps still serve fine. **VERIFIED consequence: an expired authorization
blocks new writes only — it does not take a published app down.** Corroborated by PCF
`architecture/storage/`: "Content that was already stored is unaffected; the limit is on new
writes."

### 2.4 Proof of personhood — 👤 human, phone (VERIFIED)

`docs.polkadot.com/reference/apps/infrastructure/dotns/poprules-pricing/` describes two tiers:
**PoP Full** ("the user completes the full biometric verification flow in the Polkadot App") and
**PoP Lite** (third-party attestation, bounded by governance). PCF `guides/list-in-browse/`:
"proof of personhood, which is obtained in the Polkadot app on a device — **there is no CLI path to
a tier**."

**VERIFIED** — `dotns pop info --env devnet` reads the status precompile and reported
`status: none / whitelisted: no` for the shared read-only account.

Also **VERIFIED** and worth knowing (`poprules-pricing`):

> "dotNS reads PoP tier from a status the user sets themselves. On-chain verification against the
> People Chain is a forthcoming integration; until that ships, treat the tier check as cooperative,
> not adversarial."

### 2.5 Listing in Browse (`--publish`) — ⚠️ prior notes are WRONG here

The prior `deploy-runbook.md` says:

> "### ⚠️ `--publish` does not work on devnet … On `--env devnet` this **cannot work** … Getting
> listed in Browse on devnet is, as far as we can tell, not currently possible."

That reasoning came from `pad --help`, which does still say (VERIFIED, v0.13.1):

> "Only takes effect on envs with a deployed Publisher (currently: `paseo-next-v2`)."

**The help text is stale. Three independent VERIFIED lines of evidence:**

1. `pad`'s own bundled `environments.json` gives `devnet` a non-zero
   `PUBLISHER: 0xaab42efbe8ea4d4228c3a11e973f94c17b9a0f2c`.
2. `pad`'s gate is **not an env allowlist**. From the installed `dist/chunk-7W5KOX5X.js`:
   ```js
   const publisher = preflight._contracts?.PUBLISHER;
   const zeroAddr = "0x0000000000000000000000000000000000000000";
   if (!publisher || publisher === zeroAddr) {
     console.log(`   Publish: not supported on this environment — will be skipped`);
   } else { … "isPublished" … }
   ```
   Since devnet carries an address, the publish path runs.
3. The live `browse.dot` bundle *itself* targets that contract on devnet. Extracted from the CAR at
   its current CID: a devnet network record containing
   `PUBLISHER:[{version:"2.1.0",address:"0xaab42efbe8ea4d4228c3a11e973f94c17b9a0f2c"}]`, and an
   enumerator `async listPublishedLabelhashes(){ for(const{address:r} of this.network.PUBLISHER){…} }`.

**The real blocker is personhood, not the environment.** PCF `guides/list-in-browse/`, quoted:

> "`pad --publish --env devnet` calls `Publisher.publish`, and the contract is live on the Devnet.
> But publishing is gated on-chain: you must own the `.dot` label and hold proof of personhood …
> Without one, the publish step reports `NoPersonhood`."

Gates and their reverts (VERIFIED from that page):

| Requirement | Revert |
|---|---|
| You own the `.dot` label | `NotOwner` |
| You hold personhood (Lite or Full) | `NoPersonhood` |
| Under your tier's cap — Lite 1/day, Full 5/day, rolling 24 h | `RateLimitExceeded` |

> ⚠️ **THESE GATES APPLY TO `pad --publish` — THE BROWSE DIRECTORY LISTING. NOT TO A DEPLOY.**
> Added 2026-07-30 after this table was misread as a cap on deploying. **Two full deploys
> (`pad frontend/dist plaza-social.dot --env devnet`) succeeded ~20 minutes apart** on an account with
> **personhood status 0**, both finalising on chain (blocks 11599710, 11600873). So a deploy is neither
> personhood-gated nor 1/day. Every doc that said otherwise has been corrected; the mistake propagated
> into four files and into advice given to the user, so keep the two operations verbally distinct:
> **deploy** = upload a bundle + set the DotNS contenthash; **publish** = list it in Browse.

Also VERIFIED from that page: **publishing is idempotent** ("re-running it on an already-listed
label refreshes the publisher and timestamp in place"); the `Publisher` contract stores only "a
labelhash, the publisher address, and a timestamp" — Browse's card content comes from the DotNS
`manifest` text record `pad` writes when it finds a product config; and **unpublish needs only
ownership**, no personhood, no rate limit:

```bash
pad --unpublish my-app.dot --env devnet
```

**Practical bottom line, unchanged in effect but for a different reason:** a headless CLI-only
account cannot get into Browse. But do not tell people the environment lacks a Publisher — it has
one, and a personhood-holding account can list. Pass `--fail-on-publish-error` if you want the
`NoPersonhood` revert to actually fail your deploy instead of exiting 0 with a warning.

---

## 3. Costs

**VERIFIED — the 10 PAS for a name is a HELD DEPOSIT, not a fee.** This is the single most
consequential refinement to the prior notes, which tabulated "Domain registration | **10 PAS**"
without saying deposit or fee.

`dotns escrow --help` (v0.8.0): *"Manage **NoStatus deposits** and the refund-on-leave ledger"*.
Subcommands: `status <name>`, `balance`, `positions`, `release <name>` ("Approve the escrow and
surrender the NFT to start the refund cooldown"), `withdraw <name>` ("Move a released deposit onto
the pull-payment ledger (after cooldown)"), `claim-withdrawal`, `refunds`.

`dotns escrow status hellodotworld --env devnet`, run 2026-07-29:

```
  recipient: 0x82A06d576eEDC077F3dE3Fe350767D9d068Ab345
  amount:    10 PAS
  released:  false
  claimed:   false
  status:    held
```

Same result for `plaza-social`. For `survey` and `browse` (6-char labels): *"no release position
recorded for this name"* — consistent with those sitting in a personhood/governance free tier.

| Item | Cost | Token | Kind | Evidence |
|---|---|---|---|---|
| Faucet grant | — | 5000 PAS in | — | VERIFIED, faucet FAQ |
| SS58→EVM mapping | ~0 | PAS | fee | INFERENCE: prior notes recorded 0 PAS, "already mapped at account creation, `dotns account map` was a no-op". `environments.json` sets `autoAccountMapping: true` for devnet (VERIFIED), which supports it. |
| `.dot` registration, 9+ char stem, NoStatus account | **10 PAS** | PAS | **refundable deposit, held in escrow** | **VERIFIED** (escrow status above) + PCF docs show the CLI printing `price: 10 PAS` |
| `.dot` registration, 6–8 char stem with personhood | **Free** | — | — | VERIFIED (pricing ladder, §4) |
| Bulletin upload | **0** | — | quota, not tokens | VERIFIED: "authorization-based rather than fee-based … does not pay devnet tokens for each bundle" |
| Publish tx fees (`store`, `setContenthash`, `publish`) | small | PAS | fee | INFERENCE: prior notes measured **~0.4 PAS** total for a 2.6 KB bundle on 2026-07-24. Not re-measured. |
| `--publish` listing | tx fee only | PAS | fee | INFERENCE |
| Renewing a Bulletin record | 1 transaction from your quota; **bytes not re-counted** | — | quota | VERIFIED, `…/bulletin-chain/renewal/` |

**Total for one live app: ~10.4 PAS of 5000, of which 10 PAS is recoverable** (INFERENCE on the
0.4; VERIFIED on the 10 being a deposit). Funding is not the constraint. **The 24 h faucet cooldown
is.**

⚠️ **The published pricing formula does not describe devnet.**
`docs.polkadot.com/…/dotns/poprules-pricing/` gives `startingPrice × (15 − nameLength)` DOT for
9–14 char names. `hellodotworld` (13 chars) and `plaza-social` (12 chars) are both held at exactly
**10 PAS**. A length-dependent formula would produce different amounts. **VERIFIED discrepancy.**
**INFERENCE:** devnet's deployed `PopRules` uses a flat NoStatus deposit (matching the escrow
command's own wording, "NoStatus deposits") rather than the documented ladder. Do not budget from
the formula; read the price the CLI prints before the reveal step.

---

## 4. Domain rules

### 4.1 Length gating — the "9+ characters" claim is VERIFIED, with two refinements

`docs.polkadotcommunity.foundation/guides/register-a-dot-name/`, quoted:

> "The public commit-reveal path enforces a minimum label length of three characters, and labels are
> classified by their **stem** (the label with trailing digits stripped):
> - Reserved — stems of five characters or fewer are gated and cannot be claimed through the open path.
> - Personhood-gated — six-to-eight-character stems require proof of personhood (a 'lite' tier for a
>   stem plus exactly two digits, a 'full' tier for no digits).
> - Open — stems of nine characters or more register without a personhood check."

`docs.polkadot.com/apps/deploy-your-app/` agrees, keyed on "the base name (the part before any
optional two-digit suffix)": ≥9 "Open to everyone — deploys with no personhood check"; 6–8 "Requires
Proof of Personhood on this network"; ≤5 "Reserved".

**Refinement 1 — it is the *stem*, not the label.** Trailing digits are stripped. `myapp57` has a
5-char stem and is *reserved*, not open. The prior notes say "stem" in `deploy-runbook.md` but
`CLAUDE.md` says "`.dot` name stems must be 9+ characters", which is right; just make sure nobody
reads it as "label length".

**Refinement 2 — ≤5 is reserved outright, not merely personhood-gated.** The prior notes' phrasing
("Shorter names trigger a personhood check") understates it: no amount of personhood gets you a
5-char name through the open path; that requires governance.

**Refinement 3 — the full ladder is more granular than either short summary**, and the two official
sites disagree with each other. `poprules-pricing` (VERIFIED quote):

| Name format | Who can register | Deposit |
|---|---|---|
| ≤5 chars | Governance only | — |
| 6–8, no numeric suffix | PoP Full | Free |
| 6–8 + 2-digit suffix | PoP Lite or Full | Free |
| 9–14, no numeric suffix | **PoP Full** | Free |
| 9–14 + 2-digit suffix | Anyone | `startingPrice × (15 − nameLength)` DOT |
| 15+ | Anyone | `startingPrice / 2` DOT |

⚠️ That table says a 9–14 char name **without** a numeric suffix needs PoP Full — which would make
`hellodotworld` (13, no suffix) and `plaza-social` (12, no suffix) unregisterable by a NoStatus
account. **Both exist and are held at 10 PAS. VERIFIED contradiction between the pricing table and
deployed devnet behaviour.** The devnet behaviour matches the simpler "9+ stem = open, pay a
deposit" rule. Trust the deployed chain, and trust the tier line the CLI prints.

**VERIFIED, PCF docs:** *"There is no way to check a label's tier before committing to it, so count
the stem yourself."* The CLI does print it right before the paying step:

```
  name tier:  NoStatus
  your tier:  NoStatus
  message:    Available to all
  price:      10 PAS
```

### 4.2 Registration mechanics (VERIFIED, `dotns register domain --help`)

Commit–reveal: commit a hashed intent, wait out `minCommitmentAge`, reveal and pay. Takes minutes.
Flags: `-n, --name <label>` (no `.dot` suffix), `-r, --reverse`, `-g, --governance`,
`-o, --owner <address>` (caller pays "price + `transferFloor` friction"; owner gets the NFT;
mutually exclusive with `--transfer`/`--reverse`/`--governance`), `--transfer` + `--to <dest>`,
`--cb, --commitment-buffer <seconds>` (default 6, `DOTNS_COMMITMENT_BUFFER`), `--retry <count>`,
`--json`. Recovery: `dotns register list` → `dotns register retry <name>` → `dotns register clear`.

**Registration is optional if you deploy with the account that will hold the name** — VERIFIED, PCF
`guides/build-and-publish/`: "`pad` registers the name for you during deploy if your signing account
does not already own it."

### 4.3 Who owns a name

**VERIFIED** — PCF `guides/register-a-dot-name/`: *"Owning a name means owning an **ERC-721 token**;
binding it to an app means writing an IPFS content hash into its resolver."* Registry state lives in
contract state on **Asset Hub**, not People or Bulletin
(`docs.polkadot.com/…/dotns/name-mechanism/`). Namehash is **ENS-compatible** (keccak, recursive).

Live owners, `dotns lookup oo <label> --env devnet --json`, 2026-07-29:

```
survey        0xF8d186c352e2ea0B9C02c211525A20DdcB8CD2dD / 5Fk8FBTqBpAyBReZPse2wn8Lf4ADzdNVAsrGoNMSTxKedN8f
browse        0xF8d186c352e2ea0B9C02c211525A20DdcB8CD2dD / 5Fk8FBTqBpAyBReZPse2wn8Lf4ADzdNVAsrGoNMSTxKedN8f
plaza-social  0x82A06d576eEDC077F3dE3Fe350767D9d068Ab345 / 5Fk6mNEAQtRFDpQd35SfrDGBGAsjukrPXct1eobjjEP1qP5R
hellodotworld 0x82A06d576eEDC077F3dE3Fe350767D9d068Ab345 / 5Fk6mNEAQtRFDpQd35SfrDGBGAsjukrPXct1eobjjEP1qP5R
```

Transfer: `dotns lookup transfer <label> --to <addr-or-label> --env devnet`, or `pad transfer
<domain.dot> [--to <0xH160>]`. Delegation without transfer: `dotns delegate set <name> <delegate>`.
Reverse/primary record: `dotns primary set <name>`.

### 4.4 Updates and versions

**VERIFIED — a new version is a `contenthash` update; the name never changes.**
`docs.polkadot.com/…/name-mechanism/`: *"The `contenthash` is what changes when a Product publishes a
new version: the name stays the same, the `contenthash` updates to point at the new CID."*

**VERIFIED — redeploys are incremental and carry an explicit version chain.** Each deploy root is a
manifest; I fetched and parsed the live ones. Shape (v3):

```
version, previous_contenthash, deployed_at, framework, files{path→{cid,type,size}},
stableBlockOrder[], blocks[], chunks{cid→{size,deployed_at}}
```

Files are typed **`stable`** (content-hashed assets) or **`volatile`** (`index.html` and friends).
Live figures, 2026-07-29:

| name | `deployed_at` | files | bytes | stable/volatile |
|---|---|---|---|---|
| `survey` | 2026-07-16T16:38:31Z | 6 | 1,540,095 | 3 / 3 |
| `browse` | 2026-07-21T14:00:29Z | 28 | 4,427,033 | 23 / 5 |
| `plaza-social` | 2026-07-28T20:55:48Z | 51 | 6,931,008 | 40 / 11 |
| `hellodotworld` | 2026-07-24T18:55:29Z | 3 | ~5.6 KB | — |

**Rollback is possible in principle**: walk `previous_contenthash` and `dotns content set <name>
<old-cid>`. I VERIFIED that older roots are still fetchable — see §6.

Read a deployed manifest back (VERIFIED, works today):

```bash
curl -s "https://devnet-ipfs.api.polkadotcommunity.foundation/ipfs/<root-cid>/"
```

⚠️ **VERIFIED — individual leaf CIDs are NOT separately retrievable from that gateway.** Fetching
the three `index.html` leaf CIDs directly returned **HTTP 504** each time. Only the root is
announced; the CAR the root fetch returns contains the leaf blocks inline. The prior notes said
"often not separately retrievable" — today it was consistently *not*.

---

## 5. What the host serves, and how

### 5.1 Two origins (VERIFIED live in a browser, 2026-07-29)

Opening `https://plaza-social.dev-dot.li/board?x=1#/chat` produced an outer document titled
`plaza-social.dot` at that exact URL, containing:

```
iframe src = https://plaza-social.app.dev-dot.li/board?x=1
             &cid=bafybeid57rs2jcvyny3vfbryye6unkzg4winpidkugt27h4yzqchipku5y
             &v=3&chainBackend=smoldot-shared-worker&network=devnet#/chat
     sandbox = allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-popups
iframe src = https://host.dev-dot.li/?mode=shared-worker&network=devnet
```

**Path, query and hash are forwarded verbatim** into the sandbox origin, with `cid`, `v`,
`chainBackend` and `network` appended. So inside your app, `location.pathname` / `.search` /
`.hash` are what the visitor typed. That is the whole deep-linking mechanism, and it is enough.

⚠️ **Update to the prior notes**: the appended params are now **four** (`cid`, `v=3`,
`chainBackend=smoldot-shared-worker`, `network`), not two. Do not parse positionally.

**VERIFIED — the sandbox origin refuses to be an entry point.** Navigating directly to
`https://plaza-social.app.dev-dot.li/` renders, verbatim:

> "Sandbox URL not supported
> Open this dApp through https://dev-dot.li — the sandbox origin (plaza-social.app.dev-dot.li) is not a standalone entry point."

Your app's `location.origin` is the `.app.` subdomain, never the host the user typed.

### 5.2 A path can never 404 (VERIFIED, two layers)

**Layer 1, nginx.** Every path on the sandbox origin returns the same **1,730-byte** loader
document. Verified: `/` and `/board?x=1` on `plaza-social.app.dev-dot.li` returned identical bodies
(md5 `da622e8b06bb7c7e01a076f1ccf5b198`), `<title>Polkadot Web</title>`.

**Layer 2, service worker.** I fetched `https://plaza-social.app.dev-dot.li/app-sw.js` (9,774 bytes)
and read its resolver. Deminified:

```js
function N(pathname, mode) {
  let n = pathname.startsWith(_) ? pathname.slice(_.length)
        : pathname.startsWith(g) ? pathname.slice(g.length)
        : pathname.slice(1);
  n = decodeURIComponent(n);
  let r = M(n);                                   // exact match in the archive file map
  if (r === void 0 && !hasExtension(n)) {
    let e = n === "" ? "index.html" : n + "/index.html";
    if (r = M(e), …) …                            // then p/index.html
    if (r === void 0 && n !== "") { let e = n + "index.html"; r = M(e); … }
  }
  if (r === void 0 && (n === "" || n === "/")) r = M("index.html");
  if (r !== void 0) { … }
  if (mode === "navigate") {                      // last resort for extensionless navigations
    let e = M("index.html");
    if (!hasExtension(n) && e !== void 0) return L(e, "text/html");
  }
  return null;
}
```

So: exact → `p/index.html` → `p + "index.html"` → root `index.html` for navigations. **Universal SPA
fallback, for free. Ship a root `index.html`.**

### 5.3 Does a stock Vite build work, or is `base` needed?

**INFERENCE (from source, not observed live): a stock Vite build with the default `base: "/"`
should work.** Two facts from `app-sw.js`:

- `g = self.location.pathname.replace(/(?:src\/)?app-sw\.[jt]s$/,"")`; the SW is served at
  `/app-sw.js`, so **`g === "/"`** and `_ === "/dotli-app/"`.
- The fetch handler restricts the `/dotli-app/` prefix **only for navigations**:
  `if (e.request.mode === "navigate" && !t.pathname.startsWith(_)) return;`. Subresource requests
  on any same-origin path fall through to `N()`, where `pathname.startsWith("/")` is always true, so
  the leading slash is stripped and `/assets/index.js` is looked up as `assets/index.js`.

**⚠️ The prior notes state this as fact ("a stock Vite build needs no `base` config"). It is not
established by any live example — and every live example contradicts the *practice*.** I extracted
`index.html` from the CAR of all four apps. Every one uses **relative** asset URLs:

| app | index.html asset refs | `<base>` tag |
|---|---|---|
| `survey` | `src="./assets/index-DeRXmpws.js"`, `href="./assets/index-_h-Ouya4.css"` | none |
| `browse` | `src="./assets/main-CuCFWBwI.js"` | none |
| `plaza-social` | `src="./assets/index-CZ0_CSRi.js"` | none |
| `hellodotworld` (yolodot's own) | `src="./assets/index-MT9iurvk.js"` | none |

And `paritytech/dotli-starter`'s `vite.config.mjs` (fetched from `main`, 2026-07-29) sets it
explicitly:

```js
export default defineConfig({ root: "src", base: "./",
  build: { modulePreload: false, outDir: "../dist", emptyOutDir: true } });
```

**Recommendation: set `base: "./"` anyway.** It is what the reference starter does, what all four
deployed apps do, and it removes dependence on an undocumented SW behaviour. Note `dotli-starter`
also sets `modulePreload: false`.

**VERIFIED — the SW injects a base and then hides it.** From `app-sw.js`:

```js
function L(bytes, mime) {
  let n = decode(bytes), r = _.slice(0,-1);   // "/dotli-app"
  let i = `<script>if(location.pathname.startsWith('${r}')){history.replaceState(null,'',
           (location.pathname.slice(${r.length})||'/')+location.search+location.hash)}</script>`;
  n = n.replace("<head>", `<head><base href="${_}">${i}`);
  …
}
```

So served documents get `<base href="/dotli-app/">` plus a `history.replaceState` that strips the
prefix back off the visible URL.

**Consequence (INFERENCE, consistent with layer 1 above): a genuinely multi-page bundle navigates
fine inside the frame, but a hard reload of `/about` renders the root `index.html`, because entry
always goes through nginx. Build SPAs, not multi-page bundles.**

### 5.4 The address bar does not follow in-app navigation — VERIFIED

Observed on both `survey` and `plaza-social`: the outer document's `location.href` stayed exactly
where I entered (`https://survey.dev-dot.li/`, `https://plaza-social.dev-dot.li/board?x=1#/chat`)
while the app booted and ran inside the frame. There is no URL-sync channel: the app is cross-origin
from the shell.

**Nuance the prior notes missed: the *title* does sync.** Loading `https://browse.dev-dot.li/`
changed the outer `document.title` from the shell default
("Polkadot - The decentralized web, in your browser") to **"Browse"**. So *some* app→shell channel
exists, but it does not carry the URL.

**What this means for shareable links:**

1. **Read the URL on boot and route on it.** Deep links arrive intact; nothing else is needed to
   receive them.
2. **Never tell a user to copy the address bar.** They will get the URL they arrived with, not the
   view they are looking at. Provide an explicit "copy link" affordance that your app builds from
   its own state: `https://<name>.dev-dot.li/#/board/t-abc`.
3. **Hash and path both survive entry.** Keep routing logic in one place so it is cheap to change.
4. **Ship a root `index.html` and stay single-document.**

⚠️ **This is observed behaviour of a specific gateway build, not a documented contract.** Grepping
the full PCF MkDocs search index (271 indexed sections, 2026-07-29) finds no page about routing,
deep links, or `pathname`. A gateway rebuild could change any of §5.2–5.4 without anyone calling it
a breaking change. Keep routing shallow.

**UNKNOWN — the phone and desktop containers.** Whether the native webview forwards a path the way
the web shell does is untested; it needs a device. The docs' framing ("the in-app browser addresses
dApps by `.dot` domain rather than by URL") suggests it may not.

### 5.5 What the gateway shows before the app loads (VERIFIED)

The shell is a client-side resolver, not a server. It preconnects to `host.dot.li`,
`paseo-bulletin-collator-node-{0,1}.parity-testnet.parity.io`,
`paseo-bulletin-rpc-node-{0,1}.polkadot.io`, `paseo-ipfs.polkadot.io`, `sys.ibp.network`; keeps an
IndexedDB named `dotli` (v2) and one named `dotli-sw` (archives store); and shows a trust panel:

> "HOW WAS THIS SITE LOADED? / **Verified** — More secure, checked by your light client. /
> **Trusted** — Served by an external RPC provider."

Mid-load it reports progress like `63% Walking dag-pb via bitswap…`. `browse.dot` additionally
triggered a warning — *"Direct Chain Access — This app uses a direct chain connection instead of the
recommended host API."* Both `survey` and `plaza-social` raised *"Permission Request … Sign and
submit on-chain transactions on your behalf"* (I did not answer it).

**There is no login gate.** Reading and browsing work before sign-in
(`docs.polkadot.com/…/polkadot-web/visiting/`: "Reading chain state, browsing the Product's UI, and
interacting with anything that does not require signing all work before sign-in").

---

## 6. Retention — a published bundle DOES expire

**⚠️ The prior notes say nothing about retention. This is their largest gap.**

**VERIFIED — the on-chain constant.** Bulletin Chain Console, network switched to **Products
Devnet** (`wss://bullet.tunastaking.eu`, runtime `bulletin-paseo`, spec `2003001`, block #286,284),
2026-07-29:

```
Ephemeral (RetentionPeriod: 201,600)   TRANSACTIONS 9,546   BYTES 1.23 GB
Permanent                              TRANSACTIONS 0       BYTES 0 B   of 1 TB
Authorizations  Users (256)  BYTES 47.24 GB
```

The same constant reads `201,600` on Bulletin Paseo Next v2. **INFERENCE: 201,600 blocks × 6 s =
1,209,600 s = exactly 14 days**, which matches `docs.polkadot.com/…/bulletin-chain/renewal/`:

> "The chain doesn't promise to keep bytes forever; it promises to keep them for a default period
> (about two weeks), after which the storage record expires and the bytes can be evicted from the
> collator network unless the record is renewed."

Note there is a **Permanent** storage class on devnet, currently unused (0 transactions).
**UNKNOWN** how to target it from `pad` or `dotns bulletin upload` — neither exposes a flag for it.

**VERIFIED — what keeps a bundle alive is a renewal transaction, and neither CLI can send one.**
From the renewal page: a renewal "extends the expiration block of an existing storage record", does
**not** change the CID, costs one transaction from the uploader's authorization quota, and does not
re-count bytes. Schedule it *before* expiry, not at it.

I grepped both installed CLIs for renewal support:

- `dotns bulletin refresh` exists but its help is explicit: *"Refresh (extend the expiration of) a
  Bulletin account **authorization**"* — that is the quota, not the stored data.
- `pad`'s only `renew`/`expir` strings concern login sessions ("Session signing allowance has
  expired (~2-3 days after login). Run `pad login` to renew.") and commit–reveal commitments.
- `dotns`'s other `renew` hits are from a bundled libp2p TLS certificate library.

**The only renewal surface I found is the Console: `https://paritytech.github.io/polkadot-bulletin-chain/renew`
("Renew Storage").** That is a 👤 human, wallet-signed step. **VERIFIED that the page exists;
UNKNOWN what it takes as input and whether it can renew a whole DAG root in one call.**

**Practical implication:** on the Products Devnet an app you publish and forget goes dark in roughly
two weeks. The cheap, automatable workaround is **re-deploying**: `pad` skips unchanged blocks, so a
no-op redeploy is fast and writes fresh storage records. **INFERENCE** — not tested — but consistent
with the incremental-upload design and the `chunks{cid→{deployed_at}}` structure in the manifest.

⚠️ **The two doc sites conflict on tone here.** PCF `architecture/storage/` says only "Content that
was already stored is unaffected; the limit is on new writes" (true of *authorization* expiry) and
never mentions the retention window. `docs.polkadot.com` documents the window and eviction, itself
flagged "Provisional": "The exact default retention window, the renewal grace period (if any)
between expiration and eviction, and any batch-renewal primitives … are still being finalized."
Treat 14 days as a planning number, not a guarantee.

### 6.1 Are the reference apps currently serving?

**A 200 from the gateway proves nothing.** VERIFIED: every hostname under `dev-dot.li` returns the
identical **20,506-byte** shell. I fetched seven, including a name that has certainly never been
registered:

```
survey.dev-dot.li                    200  20506  md5 c9abd82bd496ee52bfaba79c8633a48e
browse.dev-dot.li                    200  20506  md5 c9abd82bd496ee52bfaba79c8633a48e
plaza-social.dev-dot.li              200  20506  md5 c9abd82bd496ee52bfaba79c8633a48e
hellodotworld.dev-dot.li             200  20506  md5 c9abd82bd496ee52bfaba79c8633a48e
nonexistent-app-xyz123.dev-dot.li    200  20506  md5 c9abd82bd496ee52bfaba79c8633a48e   ← never registered
dev-dot.li                           200  20506  md5 c9abd82bd496ee52bfaba79c8633a48e
dot.li                               200  20106  (different shell — different network)
```

**What you CAN establish from outside**, three independent checks:

```bash
# 1. does the name resolve to a contenthash on devnet Asset Hub?
dotns content view <label> --env devnet --json
# 2. is that CID actually retrievable?
dotns bulletin verify <cid> --env devnet --json
# 3. do the bytes parse as a deploy manifest with a sane deployed_at?
curl -s "https://devnet-ipfs.api.polkadotcommunity.foundation/ipfs/<cid>/"
```

**Results, all three checks, 2026-07-29 ~21:00–23:15 UTC+2:**

| app | contenthash resolves | CID retrievable | `deployed_at` | app actually booted in-browser |
|---|---|---|---|---|
| `survey.dev-dot.li` | ✅ `bafybeie3sxni3t47ztcitjnggfiaiqpoquzsj6u2um4pucgrm2lwz3ffuy` | ✅ 200, 1,544,538 B | 2026-07-16T16:38:31Z | ✅ title → `survey.dot`, app rendered a permission request |
| `browse.dev-dot.li` | ✅ `bafybeigdof6hgoqmf7ycfucfxlb3zr6xeozrxpgjjjmma7d64bsht4xwda` | ✅ 200, 4,443,113 B | 2026-07-21T14:00:29Z | ✅ title → `Browse`, app rendered |
| `plaza-social.dev-dot.li` | ✅ `bafybeid57rs2jcvyny3vfbryye6unkzg4winpidkugt27h4yzqchipku5y` | ✅ 200, 6,956,944 B | 2026-07-28T20:55:48Z | ✅ title → `plaza-social.dot`, app rendered |

**VERIFIED: all three reference apps are alive** — not merely "the gateway answers", but the
`contenthash` resolves, the bytes are served, and the bundle actually executes inside the sandbox
(the CID in the iframe `src` matched the CID from `dotns content view` in each case).

`dotns bulletin verify` on each CID: **"P2P verification failed, falling back to gateways"**, then
resolvable on `devnet-ipfs.api.polkadotcommunity.foundation`, `dweb.link` and `w3s.link`; **not**
resolvable on `cloudflare-ipfs.com` ("fetch failed"). So the Bulletin peer-to-peer path did not work
from here for any CID — INFERENCE: local network/WebRTC limitation, not an app problem, but worth
knowing that the P2P path is not something to rely on from a dev box.

`https://paseo-ipfs.polkadot.io/ipfs/<cid>` returned **connection failure (`http=000`)** for all
three — expected, that is the other network's gateway.

**What you CANNOT establish from outside:** whether the app *works* (I did not sign in or exercise
any flow), whether its contracts/back-end state are intact, and whether the bundle would still be
retrievable after the collator cache turns over.

**Retention probe (VERIFIED, and the most interesting single result):** I walked each app's
`previous_contenthash` chain and fetched every hop.

```
survey        hop0 2026-07-16T16:38:31Z  200 1,544,538   hop1 200 575 (pre-v3 format, no manifest)
plaza-social  hop0 2026-07-28T20:55:48Z  200 6,956,944
              hop1 2026-07-28T20:45:23Z  200 6,956,709
              hop2 2026-07-28T20:26:30Z  200 6,956,227
              hop3 2026-07-28T15:29:39Z  200 6,928,892
              hop4 2026-07-28T13:24:11Z  200 6,927,336
              hop5 2026-07-27T14:05:04Z  200 6,915,829
hellodotworld hop0 2026-07-24T18:55:29Z  200 5,717      (no previous — first deploy)
```

**Every historical root I could reach is still retrievable.** The oldest live content is `survey`'s
current root at **13 days**, just inside the 14-day window; the oldest superseded root I could date
is 2 days old. **So I could neither confirm nor refute eviction: nothing in reach is old enough.**
That `survey` at 13 days still serves is consistent with the window; it is not evidence against it.

---

## 7. State of the tooling, and where the prior notes are now stale

### 7.1 Version drift

| Package | Prior notes (2026-07-24) | npm `latest` (2026-07-29) | Installed here |
|---|---|---|---|
| `dotns-cli` | 0.8.0 | **0.8.1** (published 2026-07-28) | 0.8.0 — **stale** |
| `polkadot-app-deploy` | 0.13.1 | 0.13.1 | 0.13.1 ✅ |
| `cdm-cli` | 0.8.26 | 0.8.26 | 0.8.26 ✅ |

**VERIFIED — `dotns` 0.8.1 is a patch, not a surface change.** I fetched
`unpkg.com/@polkadot-community-foundation/dotns-cli@0.8.1/dist/cli.js` (10,674,226 B) and compared
against the installed 0.8.0 (10,672,372 B): a **1,854-byte** difference. Extracting every
`.command("…")` from 0.8.1 yields exactly the command set 0.8.0's `--help` prints
(`account`/`auth`/`register`/`lookup`/`content`/`text`/`bulletin`/`store`/`escrow`/`delegate`/`primary`/`pop`
and their subcommands). No CHANGELOG is published (404 on unpkg). Its `package.json` declares
`engines: {bun: ">=1.2.6"}` and **no node engine** — the "Node 22+" requirement is a docs claim, not
enforced by npm.

Other current versions (VERIFIED, npm 2026-07-29): `@parity/product-sdk` 0.19.1,
`@parity/product-sdk-host` 0.14.1, `@parity/product-sdk-signer` 0.11.1,
`@novasamatech/host-api` 0.9.0, `polkadot-api` 2.2.1.

⚠️ **`dotli-starter` is stale on dependencies too** (last push 2026-06-13, last substantive commit
2026-06-10, VERIFIED via GitHub API). Its `package.json` pins `@parity/product-sdk-host@^0.7.0`
(current 0.14.1) and `@parity/product-sdk-signer@^0.6.1` (current 0.11.1), and it does not use the
`@parity/product-sdk` umbrella at all. Its *`vite.config.mjs` is still the best single piece of
evidence in the repo* (§5.3); its dependency set is not. The prior notes' warning that it is "stale
on the deploy path specifically" is **VERIFIED and if anything understated** — the repo contains no
deploy tooling whatsoever (`.gitignore`, `LICENSE`, `README.md`, `docs/`, `package.json`,
`package-lock.json`, `src/`, `vite.config.mjs`).

### 7.2 Where the prior notes are WRONG

1. **`--publish` on devnet.** "Cannot work" / "not currently possible" → **wrong reasoning, and the
   conclusion is right only by accident.** The Publisher contract *is* deployed on devnet, `pad`
   gates on address-presence not env name, and `browse.dot` reads it on devnet. The real gate is
   **personhood**. See §2.5.

2. **`CLAUDE.md`: "A typo in `--env` is silent."** True for `dotns`, **FALSE for `pad`.** VERIFIED
   both ways today:
   - `dotns lookup oo survey --env bogus-typo --json` → answered normally, no complaint. No
     validation. (The `Env:` banner is the only confirmation you hit the right chain.)
   - `pad <dir> zz-nonexistent-label.dot --env bogus-typo` →
     `Deployment failed (not retryable): Unknown environment 'bogus-typo'. Valid: paseo-next-v2, devnet.`
     Confirmed in source: `` `Unknown environment '${envId}'. Valid: ${valid}.${suffix}` `` and
     `` console.error(`Error: unknown environment '${flags.env}'. Valid: ${valid}.`) ``.
   The **`pad` default-env** warning (`paseo-next-v2`, not `devnet`) is **VERIFIED and still the
   most important trap** — that one *is* silent, because `paseo-next-v2` is a valid id.

3. **"A stock Vite build needs no `base` config."** Stated as fact; it is an **INFERENCE** from
   reading the service worker, and **no deployed app tests it** — all four use `base: "./"`, as does
   `dotli-starter`. See §5.3.

4. **Bulletin authorization as human-only** (`CLAUDE.md` "Human-only steps"). PCF docs now document
   `dotns bulletin authorize … --env devnet` signed by a shared devnet authorizer. Unproven but
   documented; do not assert it needs a human. See §2.3.

5. **"Domain registration | 10 PAS"** presented as a cost. It is a **refundable deposit held in
   escrow** with a documented release/withdraw/claim path. See §3.

6. **"The platform docs say effectively nothing" about routing/serving** — the *routing* gap is
   still real (0 hits for deep-link/routing in the 271-section PCF index), but the broader claim that
   the docs are thin is out of date. PCF now has `guides/list-in-browse/`, a full
   `guides/build-and-publish/`, `guides/register-a-dot-name/`, `reference/networks/`,
   `reference/packages/`, `architecture/app-delivery/` and `architecture/storage/`, several of which
   contain material the prior notes present as hard-won discoveries (Node 22+, the `--env` default
   mismatch, per-account Bulletin auth, `cdm`'s stale `--help`).

7. **The sandbox origin's static response.** Prior notes: "visiting it directly returns 'Sandbox URL
   not supported'". The **static HTML is a normal HTTP 200, 1,730 bytes, `<title>Polkadot Web</title>`**;
   the refusal message is rendered by JS at runtime. Correct in effect, wrong if you test with
   `curl`.

8. **Missing entirely: retention.** See §6. An app you publish and forget has a ~2-week clock on it.

9. **The gateway iframe query string** now carries `v` and `chainBackend` in addition to `cid` and
   `network`. See §5.1.

### 7.3 Still-unverified claims carried forward from the prior notes

Marked **UNKNOWN** — I did not re-test these, and they are not in the critical path of this document:

- Node 20 breaks `pad`/`cdm` at startup (docs assert it; not testable here without downgrading).
- `cdm` has a `devnet` preset despite stale `--help`; `cdm` is broken on Windows (`spawn npx ENOENT`).
  Note PCF `reference/packages/` now corroborates the first: "`cdm`'s own `--help` also lists its
  presets from a stale set that omits `devnet`; the preset is valid regardless." (VERIFIED as a
  docs statement.)
- `resolc` ships as a WASM binary inside `@parity/resolc`, so contracts need no Rust toolchain.
- `pad` prints "Previous deploy did not exit cleanly. Continuing." on a first-ever run — actually
  **VERIFIED incidentally**: my `--env bogus-typo` probe printed exactly that line first.
- The ~0.4 PAS publish fee figure.

---

## 8. The two toolchains do not mix

⚠️ **The prior project under-used `docs.polkadot.com/apps/`, and the reason it looks like a better
source is that it documents a different product.** Read this before following any command from it.

**VERIFIED** — `docs.polkadot.com/apps/quick-start-cli/` and `/apps/deploy-your-app/` (fetched as
raw Markdown; append `.md` to any page URL, e.g.
`https://docs.polkadot.com/apps/deploy-your-app.md` — note **no** trailing slash, `…/deploy-your-app/.md`
404s):

- The tool is **`playground-cli`**, bins `playground` and `pg`, installed by
  `curl -fsSL https://raw.githubusercontent.com/paritytech/playground-cli/main/install.sh | bash`.
- Commands: `pg init` (pairs with the phone signer via QR), `pg build`, `pg deploy`
  (`--signer dev|phone`, `--domain`), `pg mod`, `pg logout`, `pg update`.
- Result URLs are **`https://<name>.dot.li`**, and the deploy summary line reads
  `playground deploy · myproject57.dot · paseo next v2 v0.34.7`.
- `pg deploy` aborts if the process exceeds **4 GB RSS**; diagnose with `DOT_MEMORY_TRACE=1`
  `DOT_DEPLOY_VERBOSE=1`.
- Directory app is **`playground.dot`**, opened in Polkadot Desktop — not `browse.dot`.

**Three reasons not to reach for it on this project:**

1. **VERIFIED — `playground-cli` has no Windows build and its installer refuses to run.** Release
   `v0.45.0` (2026-06-23, latest) ships exactly four assets: `dot-darwin-arm64`, `dot-darwin-x64`,
   `dot-linux-arm64`, `dot-linux-x64`. `install.sh` line 26:
   `MINGW*|MSYS*|CYGWIN*) echo "Windows is not supported natively. Install WSL (…) and re-run this command inside it."; exit 1`.
2. **VERIFIED — `dot.li` is a third network.** The live `browse.dot` bundle enumerates four network
   configs by web domain: `paseo.li` / `paseoli.dev`, `testnet.li` (previewnet), **`dot.li`**
   (`ipfsGateway: https://summit-ipfs.polkadot.io`, `ASSETHUB_RPCS: ["wss://summit-asset-hub-rpc.polkadot.io"]`
   — internally "summit"), and **`dev-dot.li`** (Products Devnet). `dot.li` is not the Products
   Devnet gateway.
3. **`docs.polkadot.com` is itself stale and internally inconsistent.** Its pages carry
   `last_updated: 2026-06-29`. It targets `playground-cli 0.27.1` (latest release is **v0.45.0**)
   and `@parity/dotns-cli 0.6.2` (npm latest is **0.8.1**), and its own CLI reference table lists
   every flag as `_Pending_` under a "Provisional" banner. `/apps/deploy-your-app/` shows a deploy
   whose banner says `paseo next v2` but whose result URL is `…dot.li`.

**Where `docs.polkadot.com` IS the better source** (and the prior project should have used it):
`/reference/apps/infrastructure/bulletin-chain/{authorization,renewal,chunked-upload,cross-chain}/`,
`/reference/apps/infrastructure/dotns/{name-mechanism,poprules-pricing,architecture,transfer}/`,
`/reference/apps/hosts/polkadot-web/{visiting,shield-states,host-api}/`, and the whole
`/reference/apps/protocol/truapi/` tree. Those are conceptual/protocol references that apply to both
pipelines, and they are the only place the retention window is documented at all.

---

## 9. Quick reference — read-only commands used to produce this document

Every one of these is safe to run; none signs a state-changing transaction.

```bash
dotns content view <label> --env devnet --json          # name → contenthash + CID
dotns lookup oo <label> --env devnet --json             # owner (EVM + SS58)
dotns lookup name <label> --env devnet                  # full record
dotns escrow status <label> --env devnet                # deposit held / released / claimed
dotns bulletin status <SS58> --env devnet --json        # authorization quota + expiresAt
dotns bulletin verify <cid> --env devnet --json         # is the CID resolvable, and where
dotns pop info --env devnet                             # personhood status
dotns register list --env devnet                        # cached commit-reveal state
pad --list-environments                                 # valid --env ids
curl -s "https://devnet-ipfs.api.polkadotcommunity.foundation/ipfs/<cid>/"   # deploy manifest (CAR)
npm view @polkadot-community-foundation/dotns-cli version time.modified
```

The Bulletin Console's dashboard is the only place I found the `RetentionPeriod` value; switch its
network selector to **Products Devnet** first (it defaults to Bulletin Paseo Next v2).

---

## 10. Open questions

| Question | Status |
|---|---|
| Does `dotns bulletin authorize` actually work end-to-end on devnet today (shared authorizer budget)? | UNKNOWN — command exists, not run |
| Exactly what does `…/polkadot-bulletin-chain/renew` take, and can it renew a whole DAG root? | UNKNOWN |
| Can `pad` or `dotns` target the **Permanent** storage class? | UNKNOWN — no flag found in either |
| Is a no-op `pad` redeploy sufficient to reset the retention clock? | INFERENCE only — untested |
| Does the devnet `Publisher` at `0xaab4…0f2c` have code deployed? | UNKNOWN — my `Revive.ContractInfoOf` storage-key derivation returned `null` for a known-good contract too, so the probe was invalid. Strong circumstantial evidence in §2.5. |
| Does the phone / desktop container forward path+query+hash like the web shell? | UNKNOWN — needs a device |
| What actually changed in `dotns` 0.8.1? | UNKNOWN — no changelog published; command surface unchanged, 1.8 KB diff |
| Is 201,600 blocks exactly 14 days (i.e. is Bulletin 6 s/block)? | INFERENCE — arithmetic matches the docs' "about two weeks"; block time not measured |
| Does a `base: "/"` Vite build really serve correctly? | INFERENCE from `app-sw.js`; no live example exists |
