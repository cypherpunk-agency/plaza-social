# Gotchas — addresses, constants and hard-won facts

## ⛔⛔ THE SDK PATH IS THE ONLY PATH. DO NOT BUILD ALTERNATIVES.

**This is the governing rule of this repo and it outranks every convenience below.** Stated by the
user, 2026-07-31, verbatim:

> *"The SDK path is the only path to read data from the bulletin chain. You don't create alternative
> paths like you did. We removed the alternative paths."*

If the platform provides a capability, Plaza uses **that**, and nothing else. No second
implementation, no HTTP substitute, no "fallback in case the SDK is unavailable". **An unavailable
SDK capability is an error to surface, not a branch to route around.**

⚠️ **The tell that you are about to break this rule is the word "fallback".** It always sounds like
robustness. It is not: every alternative path is a second thing to keep correct, a second thing that
can silently serve stale or wrong data, and — inside the host container — usually **an external
origin the user gets prompted to approve.**

**How this was learned, twice, both times by shipping the mistake:**

- **[V] 2026-07-31 — IPFS gateways.** Every post body, profile and reply was fetched over public IPFS
  gateways (`lib/gateways.ts`, `GATEWAYS[0]` = `devnet-ipfs.api.polkadotcommunity.foundation`). On a
  real phone the host correctly prompted the user to approve that external origin. Meanwhile
  `@parity/product-sdk-cloud-storage`'s `CloudStorageClient` has **`fetchBytes`** and **`fetchJson`**,
  which retrieve through the **host preimage lookup subscription** — no HTTP, no prompt, and they
  handle chunked DAG-PB manifest CIDs. We were already using the same client's `store()` for writes
  and had simply never used its read side. The gateway machinery was **deleted**, not demoted.
- **[V] 2026-07-31 — the fallback I then proposed.** Told to fix the above, the first design was
  "prefer the SDK, fall back to gateways". That is the same bug wearing a hat: it keeps the prompt as
  the normal case whenever the SDK client does not open, and it rebuilds precisely what the migration
  had removed. It was caught by the user, not by review.

⚠️ **The bad inference that produced it, so nobody repeats it:** STATUS.md says *"Anonymous reading,
everywhere, needing nothing"*, which reads like a promise of an out-of-host HTTP route. **It is not.**
Anonymous reading happens **inside the host** — root `CLAUDE.md` is explicit that the host container
is the only surface, and that the MetaMask path and the standalone wallet were both *deleted* rather
than kept as options. "Needing nothing" means needing no wallet and no sign-in, not needing no host.

**For local development the seam is the fake backend** (`?backend=fake`), never a resurrected HTTP
path. If the fake lacks something, extend `lib/host/fake.ts`.

⚠️ **This rule is not self-enforcing and the codebase has more of these.** An audit is under way
covering, at least: contract **reads** going through `ethers` against a public RPC while writes go
through the SDK; the Bulletin chain fallback in `session.ts`; the two write signing arms; and stubs
that return plausible values without doing the work (`authorizeDelegate`). Before adding any path,
ask what SDK method you are declining to use, and write the answer down.

## Working in this repo with several agents at once

⛔ **NEVER run `git stash`, `git checkout --`, `git restore`, `git reset` or `git clean`.** On
2026-07-30 one agent ran `git stash` to get a clean lint baseline and reverted **every** agent's
uncommitted work — ~29k lines — to HEAD. Its own conclusion is the right one: *there was no reason to
want a clean tree.* The deeper fix is that the tree should never be far from its last commit; commit
early and often.

⚠️ **A `Read` result is not durable across a tool call.** Re-read any shared file immediately before
editing it. A vanished edit looks exactly like a bad `old_string` match, which sends you debugging
the wrong thing.

⚠️ **You cannot tell which agents are running from the filesystem.** Transcript files are unflushed —
size and mtime are identical for a finished agent and a live one. **Completion notifications are the
only reliable signal.** Do not assert an agent is done from a timestamp; that mistake was made and
caught here.

⚠️ **Nobody has ever *seen* this app.** `computer{action:"screenshot"}` fails — the Browser pane does
not composite frames. Every layout, colour and contrast claim in this repo is numeric inference from
`getBoundingClientRect` / `getComputedStyle` / `scrollWidth`. Say so when you report; do not write
"looks right".

> ## How to not waste a day here
>
> Every expensive mistake in this project so far has had the same shape: **a confident conclusion drawn
> from one observation, about a system with more than one moving part.** In order of how much time each
> cost:
>
> 1. **Check the package name before believing an error.** `@parity/polkadot-app-deploy` and
>    `@polkadot-community-foundation/polkadot-app-deploy` are different tools with the same binary name
>    and the same version number. The wrong one produced a detailed, plausible error about Bulletin
>    authorization that sent me debugging chain state for an hour. An error naming chain state is not
>    evidence about the chain until the tool producing it is known-good.
> 2. **Diff against the working sibling FIRST.** `D:\Code\web3\yolodot` does most of this successfully.
>    Two turns went into theorising about which Bulletin chains a host supports; a single comparison
>    pass found the answer (they have a preimage fallback, we did not) along with proof that versions,
>    permissions and genesis hashes were all identical.
> 3. **Read the type before passing the argument.** Two consecutive bugs — `client.descriptors?.assetHub`
>    (does not exist → `Invalid value used as weak map key`) and a guessed `walkChain` entry shape —
>    were both one `.d.ts` read away.
> 4. **A missing key looks exactly like a missing deployment.** `DEFAULT_NETWORK` pointed at a network
>    absent from `deployments.json`, so every address was `undefined` and every screen said "contract
>    not deployed" — for the entire migration, while the contracts were live.
> 5. **Distrust `[V]` tags, including your own.** Several in these files were falsified within a day of
>    being written. A stale `[V]` is worse than an honest `[?]`.


Everything here cost real time to establish, and most of it fails **silently** — which is why it is
written down. Each item says how it was verified and when.

Companions: [`STATUS.md`](STATUS.md) (where we are), [`architecture.md`](architecture.md) (why the
design is what it is), plus two deep references written by subagents:
[`publishing.md`](publishing.md) and [`pgas-deposits-and-renewal.md`](pgas-deposits-and-renewal.md).

---

## Addresses and constants

```
Chain             Products Devnet, EIP-155 chainId 420420417
ETH JSON-RPC      https://paseo-assethub-rpc.laissez-faire.trade
Substrate RPC     https://asset-hub-paseo-rpc.n.dwellir.com     (DISJOINT from the above:
                  eth_* only works on the first, chain_*/state_* only on the second)
Bulletin — TWO CHAINS, AND A HOST BUILD MAY SUPPORT ONLY ONE  [V] 2026-07-30
  CloudStorageNetworks.devnet  0xe101f0fa4627d29a257645e02be86d80378fea1a2bf8fa6a918d150ebc760a59
                               "Bulletin Paseo"      wss://bulletin-paseo.tservices.es:8443
  CloudStorageNetworks.paseo   0x8cfe6717dc4becfda2e13c488a1e2061ff2dfee96e7d031157f72d36716c0a22
                               "Paseo Bulletin Next" wss://paseo-bulletin-next-rpc.polkadot.io
  Both SDK constants are CORRECT and both chains are live — checked via chain_getBlockHash(0).
  A real phone host REJECTED the devnet one:
    ChainNotSupportedError: Chain 0xe101f0fa… is not supported by the current host.
  That is NOT genesis drift; the host build simply had the other chain enabled. Because canWrite
  hangs off the Bulletin client, one unsupported chain silently turns a fully signed-in session
  read-only. session.ts now tries the configured chain then FALLS BACK to the other, and records
  which one won — that also decides which gateway can serve the content back.

Personhood precompile   0x000000000000000000000000000000000a010000
  selector              0x886af133 = personhoodStatus(address,bytes32)
  returns               (uint8 status, bytes32 contextAlias)   0=none 1=lite 2=full
  context               "pop:polkadot.network/people-lite" | "pop:polkadot.network/people     "
                        (ASCII, space-padded to 32 bytes — NOT bytes32(0); see §Personhood)
  ⛔ returns 0 for EVERY address today. Unusable as a contract gate. See §Personhood.

CDM registry            0x59b0245778917af55224e5f8fb55f7f8d452619f
Multicall3              0x0C206218c5949c00e51825364a7C3A17d9909ef6

Our contracts, all deployed 2026-07-30 (verify: node contracts/scripts/verify-deployment.mjs)
  UserRegistry          0xfD00289e765414C0281EFC35335b6453F055FBD7   v0 — PINNED by the other three
  PostRegistry          0xF6daC4BC4e721c5C84504A5Bfe033AE63722f8c9
  Voting                0x948c71E7134E82c8d71e1bAD781F5BD4B96A14C0
  FollowRegistry        0x96A3274Fa3696bbF5F8e1D8B58455300B9b7032E

Bulletin RetentionPeriod   201,600 blocks  (~14.07 d at 6.03 s, ~15.06 d at 6.457 s — use BLOCKS)
Revive DepositPerByte              100,000 planck
Revive DepositPerChildTrieItem  20,000,000 planck
Storage cost                0.00264 PAS-or-PGAS per new 32-byte slot; overwrites are FREE
```

## Secrets

`contracts/.env` holds `SEED_PHRASE` and `DOTNS_MNEMONIC`, copied from `D:\Code\web3\yolodot\.env`
(where the variable is called `MNEMONIC`). Covered by the root `.gitignore`. **Never print it, never
commit it.** Hardhat reads `SEED_PHRASE`; `pad` reads `MNEMONIC`; `dotns` reads `DOTNS_MNEMONIC`;
`cdm` takes `--suri` on the command line only.

**The funded account is sr25519 and cannot sign Ethereum transactions.** Its `0x82A06d…B345` is a
pallet-revive *mapping* from an `AccountId32`, not a secp256k1 keypair — no ethers wallet can ever sign
as it. Every ETH derivation path of the mnemonic holds **zero**. Verified 2026-07-30 across
`m/44'/60'/0'/0/{0,1,2}`, `m/44'/60'/1'/0/0`, `m/44'/60'/0'/0'/0`, `m/0'/0`, `m/0`.
**Consequence: deployment goes through `cdm`, never `hardhat run --network`.**

---

## ⛔⛔ THE ACCOUNT IS PER-WALLET-ROOT, NOT PER-DEVICE AND NOT PER-PERSON

Asked on **2026-07-31**, after the user opened Plaza on a desktop and on a phone, signed in as
themselves both times, and saw **two different profiles at two different addresses**.

Reproduce with `node contracts/scripts/probe-product-account.mjs` (add `--link` for the exhaustive
parent search, ~110 s).

### The one-line answer

**[V] No, the product account is not per-device. The derivation takes three inputs and none of them
is a device.** It also is *not* per-person: nothing in it touches personhood. It is a pure function
of the **root account the wallet presents**, so two devices agree if and only if they present the
same root account.

From `@parity/product-sdk-keys@0.3.16` `dist/index.js`, read verbatim:

```js
function deriveProductAccountPublicKey(parentPublicKey, productId, derivationIndex) {
  const junctions = ["product", productId, String(derivationIndex)];
  return junctions.reduce(
    (pubkey, junction) => HDKD.publicSoft(pubkey, createChainCode(junction)),
    parentPublicKey
  );
}
```

sr25519 **public** soft derivation. No device id, no install id, no session key, no salt, no
randomness, no clock. Its own doc comment says it is "mirrored byte-for-byte by polkadot-desktop"
and "conceptually by polkadot-app-android-v2", and that it works on the parent *public* key alone
precisely so that a host, a CLI or any external client computes the same address the phone computes
privately. **A platform that intended per-device accounts would not have shipped that function.**

The wallet side is a host call, not something the app can influence:
`SignerManager.connect()` → `HostProvider.tryConnect()` → `accountsProvider.getProductAccount(dotNsIdentifier, derivationIndex)`
(`ACCOUNT_GET_ACCOUNT`, opcode 22/23; request is `{ productAccountId: { dotNsIdentifier, derivationIndex } }`,
response is `{ account: { publicKey } }`). The host holds the parent key and returns the derived
public key.

**[V] Parity documents the intended multi-device behaviour and it agrees**
(<https://docs.polkadotcommunity.foundation/guides/create-account/>): account creation "generates a
fresh key pair on the device", and for desktop — *"the desktop app holds no keys of its own—it is a
companion that pairs with your phone, and signing stays on the phone."* A correctly paired desktop
therefore derives from the **phone's** root and must produce the **same** address.

### So what did the user actually hit?

**[I] Two different root accounts.** Given the same bundle (same `dappName`, so the same
`dotNsIdentifier`), the only free variable left is the parent public key. Ranked:

1. **The desktop is not paired to that phone** — it is running its own locally created account, or a
   pairing to a different account/phone. This is the boring, likely one and it is user-checkable.
2. **The phone holds more than one account** and a different one was selected/paired.
3. **[?] The two hosts disagree about `dotNsIdentifier`** — see the next subsection. This one is
   ours, not theirs, and it is the only candidate that is *our* bug.

**The diagnostic to run on the devices, in this order:**

- **Compare the usernames, not the addresses.** The Polkadot app shows a username
  (`Resources.UsernameOwnerOf`, e.g. `name.01`). *Same username on both* → one identity, two roots →
  a pairing problem, fixable by re-pairing desktop to the phone. *Different usernames* → genuinely
  two identities and two Lite-personhood registrations; the platform cannot merge them.
- Then check whether the desktop app was ever paired by QR at all, or was set up standalone.

### ⚠️ OUR OWN LANDMINE: we ask for `plaza.dot`, we are deployed as `plaza-social.dot`

`App.tsx` passes `APP_NAME = 'plaza'` as `dappName`. `product-sdk-signer`'s
`productIdentifierFromDappName` appends `.dot` to anything that is not already `.dot` and is not a
localhost form, so **the wire carries `plaza.dot`** — a name Plaza does not own. The product is
published as `plaza-social.dot`.

`productId` is the second junction, so it *is* the identity. Alice's two accounts, from the probe:

```
plaza.dot        idx 0 → 5FeyyzMgN5jYYnFnXZWerDmPSdqbnMBrv1EKAFMyKRVZvvaS
plaza-social.dot idx 0 → 5DfG1Ev9dgWTnjuxtD8SekDTvo4uin8DWjeEk8CMbYA7bgUp
```

Two accounts, one human, one wallet — from a six-character difference in a string nobody looks at.

**[?] It has not been demonstrated that this caused the reported split**, and it should not have: the
same bundle runs on both devices, so both ask for `plaza.dot`. But it becomes a cause the moment any
host stops honouring the requested identifier and substitutes the one it actually loaded — and the
protocol has a `DomainNotValid` error variant on `HostAccountGetError` ("Domain identifier is
invalid"), so hosts are *expected* to validate this. ⛔ **Do not "fix" this by changing `APP_NAME`
to `plaza-social`.** That silently moves every user to a new address and orphans the one profile and
the two threads already on chain. It is a migration, not a rename, and it needs deciding, not doing.

### ⭐ [I] The browser host and the phone agreed — which is the positive evidence

The only writer on `keccak("forum")` is `0x18773c30d65de35027ac8cd19e98c0ddb9c44ef9` →
`5EJ3VTQLFVGHh2nrwpD9VyAFhYhhKnHxRTfGsGifFS4sx2rz`, i.e. the account that published the two threads
from the **phone** on 2026-07-30. That is the same account this file already records as the product
account of the **failing browser-over-SSO session** on 2026-07-31. If both readings are right, one
human on two surfaces got **one** account, and per-device is falsified empirically as well as by
construction. Tagged `[I]` only because the browser-session reading and the forum-writer reading may
share a source; a diagnostics screenshot from the browser session would make it `[V]`.

The mechanism is visible in the live host bundle. `browse.dev-dot.li/assets/auth-BuYgQyky.js`
(2026-07-31) stores an SSO session as:

```
{ id, localAccount, remoteAccount, rootAccountId, identityAccountId,
  identityChatPublicKey, ssoEncPubKey, rootEntropySource, deviceEncPubKey }
```

The phone sends `rootAccountId` **and** `rootEntropySource` across at pairing, so the browser derives
product accounts — and RFC-0007 `deriveEntropy` — from the *phone's* root, not from anything local.
`localAccount` is only the browser's random statement-store account. Note also
`AutoSigning` resource allocation returns `{ productDerivationSecret, productRootPrivateKey }`: the
phone hands the *private* root over for prompt-free signing. Nothing here is device-scoped.

### ⛔ A product account CANNOT be linked back to a personhood identity

**[V] The root account does not appear on chain, so the link cannot be recovered.** The probe takes
the product account `5EJ3VTQ…` and searches for a parent among **every** AccountId32 that has ever
touched revive on this chain — 4260 of them, a superset that contains all 159
`PeopleLite.LitePeople` accounts — across 6 candidate product ids × 2 indices. **51120 derivations,
zero hits.** sr25519 soft derivation is one-way per parent, so an exhaustive search over every
plausible parent is the only attack available and it fails.

Concretely, the account model has three layers and only the middle one is on chain:

| | Where it lives | On chain? | Stable across devices? |
|---|---|---|---|
| **root account** | wallet (phone) | **no** | yes, if the same wallet/pairing |
| **identity account** | wallet, registered on the People chain | yes — `PeopleLite.LitePeople`, `Resources.UsernameOwnerOf` | one per *registration*, see below |
| **product account** | derived per `(root, productId, index)` | yes — `Revive.OriginalAccount` | yes, if the same root |

`rootAccountId` and `identityAccountId` are **separate fields** in the SSO handshake. They are not
the same account, and no on-chain storage relates them. This settles the `[?]` that STATUS.md
carried: *"the product account is neither a `LitePerson` nor a `Person`"* is **not** evidence about
the user's personhood, and it never can be — a product account is structurally incapable of being a
personhood entry.

### The one identity route that DOES work — and its limit

**[V]** `getUserId()` → `{ primaryUsername }` (a host call, `HostGetUserIdResponse`, triggers an
identity-permission prompt) → `Resources.UsernameOwnerOf[username]` on the People chain → the
identity AccountId32 → `PeopleLite.LitePeople[account]`. Measured 2026-07-31: **159 usernames, 159
distinct owners, 159/159 owners are LitePeople.** All read-only and host-independent.

⚠️ **[V] But a username is not a unique human.** Five stems are registered more than once, each to a
different account and a different Lite-personhood entry: `kiuber.01/.02/.03`, `claudebot.02/.03/.17`,
`florentina.01/.02`, `wuyuxi.01/.02`, `itsianagain.01/.02`. Lite personhood is device-attested —
every one of the 159 `LitePeople` entries has `method: { type: "UniqueDevice" }` — so **a human who
registers on a second device becomes a second "person" with a second identity account and a second
numbered username.** Per-device identity is real on this platform; it just lives one layer *above*
the product account, in personhood, not in the derivation.

### What this means for Plaza, concretely

If a user ends up with two roots, they get two of everything and **nothing in the current design
reconciles them**: `UserRegistry.createProfile` records `msg.sender`; `PostRegistry` keys heads on
`(registry, writer)`; `FollowRegistry` keys the graph on the writer; `Voting` tallies per voter;
a CASH tip pays a resolved address. Two profiles, two post histories, two follow graphs, two vote
weights, and a tip that reaches only one of them.

**[?] There is no platform account-linking call.** Nothing in `@parity/truapi`'s account domain
(`ACCOUNT_GET_ACCOUNT`, `ACCOUNT_GET_ACCOUNT_ALIAS`, `ACCOUNT_CREATE_ACCOUNT_PROOF`,
`ACCOUNT_GET_LEGACY_ACCOUNTS`) merges, links or migrates accounts. **The honest answer is that the
platform does not solve this**, because it does not consider it a problem: the intended topology is
one root on the phone and every other surface a paired companion.

Two things we *could* do, neither of them yet decided:

- **`UserRegistry.transferProfileOwnership` / `authorizeDelegate` / `canActAs` already exist** and
  are the only in-repo tool for "these two addresses are the same person". `authorizeDelegate` lets
  root B write as root A, which merges the *future*. It does not merge the past, and it costs a
  signature from the losing account — which the user may no longer be able to produce.
- **Anchor the profile on the identity, not the product account.** `getUserId().primaryUsername` is
  device-independent per registration and resolvable to an account. That is a content-model change,
  not a patch — and the username-stem collisions above mean it is *not* a one-human key either.

⛔ **Do not implement either without deciding first.** And ⛔ **do not paper over it by deriving an
AccountId32 from an H160** — `Revive.OriginalAccount` is the only sound reverse route, `h160ToSs58()`
yields a different real account, and tipping it destroys funds.

---

## Personhood — an APP can check it; a CONTRACT cannot

Reproduce everything below with `node contracts/scripts/probe-personhood.mjs`.

**Separate the two questions, because conflating them produced a wrong conclusion once already:**

| Question | Answer | How |
|---|---|---|
| "Is this account a person?" asked by **the app** | **YES, works today** | People chain, `PeopleLite.LitePeople[account]` — **151 entries**. Zero-config via `getChainAPI("devnet").individuality`. |
| "Is `msg.sender` a person?" asked by **Solidity** | **No** | Needs the Asset Hub precompile, which needs an alias binding. `AccountToAlias` is empty in all three places it exists. |

Personhood lives on the **Individuality / People chain**, not on Asset Hub — Asset Hub only holds a
`MembersSubscriber` subscription to the People chain's member rings. The SDK abstracts this: `devnet`
and `paseo` both ship a live `individuality` descriptor (`@parity/product-sdk-chain-client`; only
`polkadot`/`kusama` are documented as "not yet live"). Devnet's endpoint is
`wss://people-paseo.rotko.net`.

Pallets there: `People`, `PeopleLite`, `ProofOfInk`, `DummyDim`, `MobRule`, `Members`, `Honour`.

- **`PeopleLite.LitePeople` is keyed by plain account address** and has **151 entries** — verified
  2026-07-30 by a positive lookup on a real account and a negative on Alice. This is the read to gate
  UI on.
- **Full personhood is NOT account-addressable yet.** `People.People` has 41 entries but is keyed by
  *personal id*, and `People.AccountToPersonalId` has **0 entries**. So "lite counts" is not merely a
  fairness argument here — lite is the only tier you can currently resolve from an account.
- The `41` matches yolodot's "41 full" exactly; lite has grown from their 94 to 151.

### The Asset Hub precompile, and why it is the wrong tool

**It is real and live.** Address `0x…0a010000`, selector `0x886af133` =
`personhoodStatus(address,bytes32)`. Not in the docs, the descriptors, or any `@parity/product-sdk-*`
package; `yolodot/docs/platform/sdk-notes.md` §5c records it as `[?]` while
`yolodot/apps/plaza/src/lib/personhood.js` has had the address all along.

**And it returns 0 for every address tested.** [V] 2026-07-30 — because the account→alias binding it
resolves through does not exist yet, anywhere:

- `AliasAccounts.AccountToAlias` on Asset Hub: **0 entries**. Also `People.AccountToAlias` and
  `PeopleLite.AccountToAlias` on the People chain: **0 entries** each.
- Binding is a user action — `set_alias_account(proof, collection, ring_index, ring_revision, context,
  proof_valid_at)` carries a ring-VRF proof; an app cannot do it for you.
- Asset Hub's version needs `AliasAccounts.AliasFee`, which is **unset** (`None`; the pallet declares
  an `AliasFeeUnset` error), so nobody *can* bind there right now regardless.
- Meanwhile `Pgas.ClaimedGasAliases` has **23 entries** — real people minting PGAS. Personhood is
  proven per-extrinsic by an alias, never by an account a contract could look up.

⚠️ The `0` is a correct answer to a question nobody has enabled, **not** evidence that personhood is
unavailable. Use the People chain instead (table above).

**⚠️ The `context` argument is not free-form, and passing zeros is why this looked like a dead
precompile.** The valid contexts are the keys of `MembersSubscriber.RingCollectionStates`, and they
are ASCII space-padded to exactly 32 bytes:

```
"pop:polkadot.network/people-lite"   (32 chars exactly)
"pop:polkadot.network/people     "   (27 chars + 5 spaces)
```

`yolodot/apps/plaza/src/lib/personhood.js` defaults `context` to `bytes32(0)`, which names no ring at
all. Both real contexts still return 0 — so the conclusion stands — but any future probe must use
these, or a 0 proves nothing.

**Consequences:**
- `Voting` keeps `hasProfile` **as its on-chain gate**, because a precompile gate would reject 100% of
  users including us. That is a limitation of Solidity's reach, not of personhood.
- **The app should gate on real personhood** via `PeopleLite.LitePeople[account]` — that is a genuine
  one-human-one-account check and much stronger than `hasProfile`, which gates nothing (profiles are
  free and unlimited). Belt and braces: app enforces personhood, contract enforces attribution.
- **LITE COUNTS. NEVER REQUIRE FULL.** 151 lite versus 41 full, and full is not even resolvable from
  an account (`People.AccountToPersonalId` is empty). There is no defensible reason to require it.
- `contextAlias` is a per-context pseudonym — the same human yields a different alias per app, giving
  sybil resistance *and* anonymity. Worth adopting for the contract the day `AccountToAlias` fills up.
- Re-run the probe before trusting any of this. The moment `AccountToAlias` has entries, the
  contract-side conclusion is stale.

**A note on how this was got wrong.** The first pass tested only the Asset Hub precompile, saw 0
everywhere, and wrote up "personhood cannot be checked" — a claim about the platform inferred from one
API on one chain. The tell was visible and ignored: the frontend bundle contains
`devnet_individuality_metadata` chunks, i.e. the SDK ships a People-chain client. When a capability
seems absent, check whether you looked on the right chain before concluding the platform lacks it.

---

## Contract toolchain

**`cdm deploy` cannot pass constructor arguments.** [V] from source 2026-07-30, cdm-cli 0.8.26:
`ContractDeployer.dryRunDeploy` builds `Revive.instantiate_with_code({… data, salt})` after
`const data = new Uint8Array(0);` — the calldata is hard-coded empty and no flag reaches it. A contract
with `constructor(address x)` receives `address(0)` and reverts, surfacing as `Revive.ContractReverted`
on "AssetHub deploy+register chunk" with **all** contracts in the chunk marked failed regardless of
which one broke. yolodot never hit this because `PlazaHeads` and `Guestbook` take no constructor args.

Our fix: the three satellites pin `UserRegistry` as a `constant` and take no constructor arguments.
Grep `PLAZA-USER-REGISTRY-ADDRESS`. Each constructor reverts `UserRegistryNotDeployed` if that address
holds no code, so a wrong-network deploy dies at deploy time rather than at first delegated write.

**`cdm deploy` ALWAYS redeploys, at a NEW address, as a NEW version.** The salt is
`computeDeploySalt(cdmPackage, version, scope)` and the version comes from
`queryRegistryVersionCounts`, so every run bumps it and lands somewhere else. `getOnChainCode` exists
in the source but **is never called** — there is no unchanged-code skip. Two consequences: re-running
a deploy silently orphans the previous instance *with its storage*, and it will do that to
`UserRegistry` even when the source has not changed. To deploy a subset, move the others out of
`contracts/` first (a dot-directory like `contracts/.isolate/` is not scanned); there is no filter
flag, and cdm deploys every contract it detects.

**`.cdm/solidity/<scope>/<name>.sol` is NOT a reliable address record.** It is regenerated on every
build, and a contract that was not part of *this* build comes back as a local stub with
`ADDRESS = 0x0000…0000`. Observed 2026-07-30: `user-registry.sol` was zeroed by a deploy that excluded
it, while the contract was live on chain the whole time. `deployments.json` plus
`scripts/verify-deployment.mjs` are the record; `.cdm/` is build output.

**`networks.hardhat.polkadot: true` is what switches the compiler to resolc.** Requiring
`@parity/hardhat-polkadot` alone is NOT enough: the build succeeds and silently emits **EVM** bytecode,
and cdm then says "hardhat build did not produce deployable bytecode" — which points nowhere near the
cause. Check the magic bytes: PolkaVM starts `0x50564d00` (`PVM\0`), EVM starts `0x60…`.

**The two builds need separate output directories.** EVM → `artifacts-evm`/`cache-evm`; PolkaVM → the
defaults. Sharing them means the two overwrite each other and a deploy picks up the wrong bytecode.

**The PolkaVM config is `hardhat.config.cjs`, not `.ts`.** `contracts/package.json` is
`"type": "module"`; Hardhat 2 loads a TS config through ts-node as CommonJS and rejects it with HH19.
Plain `.cjs` needs no ts-node — worth having, because **ts-node 10.9 cannot read TypeScript 7's compiler
API** and fails as `Cannot read properties of undefined (reading 'fileExists')`, which reads exactly
like a missing tsconfig and is not.

**No Rust needed.** `resolc` ships as a WASM binary inside `@parity/resolc`, pulled in transitively.
`cdm setup --check` reporting `rustup ✖` is about the `cargo pvm-contract` route. Ignore it.

**cdm deploys everything under `contracts/`.** That is the guard against deploying probes — keep
anything undeployable outside that directory. We use `contracts/.isolate/` for contracts that are not
ready.

**Solc parses `@scope/name` inside a NatSpec comment as a documentation tag.** Writing
`` `@plaza-social/user-registry` `` in prose above a state variable fails the build with
`DocstringParsingError: Documentation tag @plaza-social/user-registry` not valid for public state
variables`, which reads like a problem with the variable and is not. Drop the `@` in prose; only the
real `@custom:cdm` line should have one.

**Names claim themselves on first publish.** `@plaza-social/user-registry` was unowned and registered
automatically. Decision 005 says the signer must own the name and never explains how ownership is
acquired — because nothing is needed. Contract **code size is not a constraint** either: 73.8 KB
deployed fine, above yolodot's proven 56,507 bytes.

**`cdm` is broken on Windows** — it calls `spawn("npx", …)` without `shell: true`. Use the shim at
`contracts/tools/cdm.mjs` (copied from yolodot). Pass-through on Linux/macOS.

---

## Publishing

**Always pass `--env devnet` to `pad`.** Its default is `paseo-next-v2`, which is a *valid* id — so
omitting the flag deploys to the wrong network and looks completely successful. `dotns` defaults the
other way and silently ignores an unknown `--env` entirely.

**Vite needs `base: './'`.** The bundle is served from a CID path inside a sandboxed iframe, so absolute
asset URLs 404 with no reachable console.

**~~Publishing is rate-limited by personhood: 1/day Lite, 5/day Full.~~ FALSIFIED — do not plan around
this.** [V] 2026-07-30: **two full `pad` deploys succeeded ~20 minutes apart** on the same account, both
finalising on chain (blocks 11599710 and 11600873). Whatever the limit is, "one publish a day" is not
it, and treating it as a blocker wasted real time — including telling the user a fix could not go live.
`publishing.md` §351 records a `RateLimitExceeded` error existing in the pallet with those numbers; that
may apply to `pad --publish` (the Browse directory listing, separately personhood-gated, fails
non-fatally exiting 0) rather than to a deploy. **Actual deploy cap: `[?]` — just try it.**

**Domain cost is a refundable 10 PAS deposit, not a fee** (`dotns escrow status` shows
`status: held`). A 9+ character stem avoids a personhood check on the name.

**An HTTP 200 from the host domain proves nothing.** [V] 2026-07-30: `plaza-social.dot.li` and
`plaza-social.dev-dot.li` both return the identical **20,506-byte** host shell — as does every hostname
under those domains, including names never registered. Both domains are live; `pad` now prints
`.dot.li`.

**⚠️ THE PUBLISHED CID IS A CAR FILE, NOT A UNIXFS DIRECTORY.** [V] 2026-07-30, and this invalidates the
verification recipe that used to be written here. `GET /ipfs/<cid>` returns **7,571,187 bytes** of
`application/octet-stream` beginning `a2 65 72 6f 6f 74 73…` — CBOR `{roots, version}`, a CAR v1 header.
So:

- **Fetching the CID root works** on both `ipfs.io` and the devnet gateway, and its size is a real check.
- **Pathing into it does NOT.** `<cid>/index.html` and `<cid>/deployments.json` both 404 with
  `no link named … under <cid>`. This is expected, not a broken deploy — it is why the host's loading
  screen says "Walking dag-pb via bitswap": it unpacks the CAR itself.
- ~~"fetch the CID from a gateway" to check individual files~~ — impossible. Do not conclude from a 404
  on a file path that the publish failed.

**To verify a deploy:** (1) `dotns content view <name> --json` and compare the CID to what `pad`
printed; (2) `grep` the strings you changed in the exact `dist/` you uploaded — that is what proves the
new code is in the bundle; (3) load it in the host and read the UI.

**Neither `pad` nor `dotns` can renew stored data.** `dotns bulletin refresh` renews the
*authorization*, not the record. `CloudStorageClient.renew()` in the SDK is the only programmatic path.

## ⚠️⚠️ THERE ARE TWO `pad` PACKAGES. USE THE COMMUNITY FOUNDATION ONE.

```
✅ @polkadot-community-foundation/polkadot-app-deploy    ← THIS ONE. Works.
❌ @parity/polkadot-app-deploy                            ← different package, same `pad` binary name,
                                                            also versioned 0.13.1
```

Same for the others — the working toolchain is **all** `@polkadot-community-foundation`:
`dotns-cli`, `polkadot-app-deploy`, `cdm-cli`.

**[V] 2026-07-30.** The `@parity` package refuses to deploy with an error that reads like real chain
state and is not:

```
Deployment failed: Bulletin storage account pool account 0 (5DDa6Wx3...) is not authorized
(or its authorization expired). polkadot-app-deploy no longer self-authorizes on the Bulletin
chain — request authorization for this account from the chain's authorizer.
```

That message sent a whole investigation down a hole: pool-account derivation, `--pool-size 1`, byte
quotas, `dotns bulletin status/refresh`, and a written-up "finding" that deploys are gated by Bulletin
authorization per derived pool account. **All of it was an artefact of the wrong package.** The
community-foundation package deployed the identical bundle with the same mnemonic minutes later,
first try.

**The tell I ignored:** the `@parity` package prints `https://<name>.dot.li`, the community-foundation
one prints `https://<name>.dev-dot.li`. When the URL a tool reports stops matching the URL in your own
notes and screenshots, that is a different tool — not a platform change. I instead "corrected" the docs
to say `.dot.li`. Both hostnames do serve the app (identical 20,506-byte shell), which is why the
mismatch looked harmless.

**Rule this earns:** an error naming chain state is not evidence about the chain until the tool
producing it is the one known to work. Check the package name first.

---

## Tests and scripts

**`hardhat_setCode` does not clear storage, and a pinned address is the same address every test.**
The three satellites are only deployable in a test once `UserRegistry`'s code sits at the pinned
address, which `test/helpers/pinnedUserRegistry.js` arranges — but profiles created in one test were
still there in the next, so `createProfile` reverted with `ProfileExists` and looked like a contract
bug. The helper now calls `hardhat_reset` first. Test-state leakage of this kind is only possible
*because* the address is fixed.

Mirroring code is sound here only because **`UserRegistry` has no constructor**, so runtime code plus
empty storage is indistinguishable from a fresh deploy. If it ever gains constructor state the helper
becomes a lie that passes.

**`import.meta.url === \`file://${process.argv[1]}\`` is always false on Windows** — `file:///D:/…`
versus `file://D:/…`. A script guarded that way exits 0 with no output, which is indistinguishable
from "ran fine, found nothing". Cost 10 minutes on the personhood probe.

## ⭐ Bulletin writes: the CloudStorage route can be UNREACHABLE, and the fallback is the real path

**[V] 2026-07-30, on a real phone, with every other step green.** The single most expensive finding of
the migration, and it was sitting in yolodot's code the whole time.

`CloudStorageClient` reaches Bulletin through the host's chain bridge, which first asks
`system.featureSupported({ tag: 'Chain', value: { genesisHash } })`. **A host in `rpc-gateway`
chain-backend mode answers that from a three-element list — relay, Asset Hub, People — that never
contains a Bulletin chain.** So `ChainNotSupportedError` comes back for *every* Bulletin genesis:

```
devnet: ChainNotSupportedError: Chain 0xe101f0fa… is not supported by the current host.
paseo:  ChainNotSupportedError: Chain 0x8cfe6717… is not supported by the current host.
```

The mode is sticky in `localStorage['dotli:chain-backend']`, and legacy values
(`rpc`/`gateway`/`centralized`/`ipfs-gateway`) migrate onto `rpc-gateway` permanently. In that mode the
host reaches Bulletin over a direct WebSocket that bypasses its own bridge — which is why the host works
and the product does not.

**⛔ A devnet→paseo fallback CANNOT fix this** — that was our first attempt, and it failed on both
chains, because both are absent from the same list. Two wrong chains are not a fallback.

**The fix: fall back to the host preimage channel.** `getPreimageManager()` from
`@parity/product-sdk-host` goes through the TruAPI bridge (`client.preimage.submit`) and touches no
chain client, no genesis hash and no support probe. yolodot has had this since its first commit:

```
try { await storage.store(bytes).send() }        // primary
catch { await preimages.submit(bytes) }          // the path that actually carries the bytes
```

Consequences to design around:
- **`submit` returns a hex preimage key, NOT a CID.** Compute the CID locally first with
  `calculateCid(bytes)` (a pure re-export of `@parity/bulletin-sdk`; no chain client).
- **No `(blockNumber, extrinsicIndex)` receipt**, and Bulletin `renew` is positional — so content
  written this way is the hardest on the chain to keep alive. The renewal TODO is unsatisfiable here.
- **A per-write "Submit Preimage" dialog is unconditional** — no grant suppresses it.
- `canWrite` must be `(!!storage || !!preimages) && canChain`. Requiring `storage` told users who could
  post that posting was off.

**⚠️ `PreimageSubmit` MUST be requested.** Both repos carried a comment saying it is never read by the
host and must not be requested — inherited from yolodot, and **refuted by yolodot's own later audit**:
the TruAPI sandbox gates `remote_preimage_submit` on it, one layer above where the host bundle was
originally grepped. Corrected in `diagnostics.ts` and `session.ts`.

**What ruled everything else out** (so nobody re-runs it): all `@parity/*` package versions are
**identical** across the two repos, `product-sdk-cloud-storage` and `product-sdk-host` are byte-identical
installs, the permission set is identical, the resource-allocation tags are identical, and yolodot passes
**the same genesis hash our phone rejected**. There is no magic hash and no version drift. The only
difference was the fallback.

**Method note:** two turns were spent theorising about chain support, pool accounts and quotas. The
answer came from diffing against the working repo in one pass. When a sibling project does the same thing
successfully, compare the code before investigating the platform.

## Host-signed contract writes (arm 1)

**Owner-only calls must NOT be signed by the delegate**, for two independent reasons — profile creation
hits both, and the second one hides the first:

- **Attribution.** `UserRegistry.createProfile` records `msg.sender` as the owner, so a delegate-signed
  call creates a profile owned by a throwaway per-device key. There is deliberately no
  `createProfileFor`.
- **Funding.** The delegate is a locally derived H160 that nobody funds — balance `0.0`, nonce `0`
  [V] 2026-07-30. Sending from it produces:

  ```
  could not coalesce error { "code": 1012, "message": "Transaction is temporarily banned" }
  ```

  The node rejects the unpayable transaction and the txpool then **bans its hash**, so a retry fails
  differently and more mysteriously than "no money". `1012` here means unfunded sender, not a ban you
  did something to earn.

**Asset Hub IS reachable through the host bridge even when Bulletin is not** — an `rpc-gateway`-mode
host supports relay + Asset Hub + People. So contract writes work through the host chain client while
Bulletin writes need the preimage fallback. Those two facts look contradictory in the diagnostics panel
and are not.

**⚠️ The chain descriptor is a SEPARATE IMPORT, not a property of the client.** `ChainClient` exposes
`.raw.<name>` and the typed API; there is no `.descriptors`. Passing `client.descriptors?.assetHub`
hands `undefined` to `createContractFromClient`, which uses it as a WeakMap key:

```
Invalid value used as weak map key
```

That message names nothing and points nowhere near the cause. Import
`@parity/product-sdk-descriptors/<env>-asset-hub` and guard the value before passing it on.

**Prefer `createChainClient({ chains: { assetHub } })` over `getChainAPI(env)`.** The preset table
behind `getChainAPI` statically references polkadot/kusama/paseo metadata and emits a ~880 kB chunk per
network into a bundle that gets **uploaded to Bulletin**. (Note: importing
`@parity/product-sdk-chain-client` at all appears to pull the whole preset table in regardless — all
four `*_asset_hub_metadata` chunks are present in our build and predate this code. Unsolved `[?]`.)

**⭐ ARM 1 WORKS. [V] 2026-07-30** — a profile was created on chain from the phone, host-signed, with
the product account as `msg.sender`. First real contract write through the host.

**⚠️ ALWAYS POLL AFTER A HOST-SIGNED WRITE. One read is not enough, and the failure is silent.** The
host submits and settles at best-block, but the app reads through a **separate public RPC** that can
trail the block the host just saw. An immediate re-read therefore returns the OLD state: the profile
existed on chain while `getProfile().exists` was still false, so the "set up your profile" banner stayed
up over a visible profile, and the create form never switched to its edit view — which reads as "the
write silently did nothing". Events are no help here: `eth_getLogs` cannot see host-submitted contract
calls at all, so polling the view function is the correct mechanism, not a workaround. Give up quietly
after a timeout — the write already succeeded, and the next natural refresh will show it.

## ⭐ "Submit failed, no allowance set for account" is a DEAD PHONE LINK, not a contract problem

**[V] 2026-07-31**, read out of the live host bundle `https://browse.dev-dot.li/assets/auth-BuYgQyky.js`
(find it by grepping the served `index-*.js` for `auth-`).

Seen on a real device as a reply that would not post:

```
TxError: createTransaction failed: HostFailure: Submit failed, no allowance set for account
```

Every word of that string points at the contract call, and every word is misleading. **It is a
STATEMENT-STORE rejection.** Two independent readings agree:

- The host builds the sentence from `{tag:'rejected', reason:'noAllowance'}` — one of a family with
  `noProof`, `badProof`, `encodingTooLarge`, `accountFull`, `storeFull`, `expiryTooLow`. Nothing in that
  family concerns contracts, gas, PGAS or `pallet-revive`.
- On the **web** host, the browser reaches the paired **phone** over an SSO-v2 channel *whose transport
  is the statement store*. `createTransaction`, `signRaw`, `getRingVrfAlias` **and
  `requestResourceAllocation`** all funnel through one `c.request(...)` → `submitRequestMessage` →
  `prover.generateMessageProof(...).andThen(statementStore.submitStatement)`.

So the write did not fail on chain — **it never reached a chain.** The signing request could not be
shipped to the phone.

**This explains the body-survives / pointer-fails asymmetry**, which otherwise looks like a bug in
`publish.ts`. The Bulletin preimage path does not use that channel at all (the SSO chunk contains no
preimage handler) and is signed with a `slotAccountKey` the browser holds locally. So the post body
stores fine and only the pointer write dies. A user sees a post that vanished; the data is safe.

⚠️ **Consequences for anything you might try:**

- **Re-asking for an allowance cannot help.** `requestResourceAllocation` travels the *same dead
  channel*. Reaching for a shorter claim TTL in `allowance.ts` is treating the wrong illness.
- **`SmartContractAllowance` is INERT on this host.** Its persisted record is
  `{productId, resource: O({bulletin, statementStore}), slotAccountKey}` and its tag mapper has exactly
  two cases (`bulletin → BulletInAllowance`, `statementStore → StatementStoreAllowance`). There is no
  smart-contract case and no host-side slot for one. We still request it; it buys nothing here.
- `value: 0` (the derivation index) **is** correct — every product-account path in the SDK defaults to
  `derivationIndex = 0` — and is irrelevant to this failure.
- ~~**The only remedy is signing in again.**~~ ⛔ **FALSE. Retracted the next day — read the section
  below before acting on anything above.** We shipped that sentence into the app's error copy and it
  cannot work.

## ⛔ …and the remedy we shipped for it was WRONG: the statement-store allowance is PERSONHOOD-GATED

**[V] 2026-07-31**, one day after the section above, prompted by the user hitting the identical error
**three more times on a fresh build across three different actions** — authorise-posting-key, a
profile blog post, and a reply. "The session went stale" cannot explain a failure that is total.

This section does not contradict the one above. Everything above about *where* the failure happens is
correct. What was wrong was the next question, which nobody asked: **what grants a statement-store
allowance in the first place?**

### The chain says: only a person can have one

`statement_submit` is served by the **Individuality / People chain** — `wss://people-paseo.rotko.net`
answers `statement_submit`, `statement_subscribeStatement`, `statement_unsubscribeStatement`
(**[V]** `rpc_methods`, 2026-07-31). That runtime has **no `Statement` pallet** and no
balance-derived allowance. Allowances live in `Resources`, and exactly two calls create one:

| call | origin it demands |
|---|---|
| `Resources.set_statement_store_account(period, seq, target_account)` | `Origin::StmtStoreAlias`, produced by the `AsResources` **`RegisterStatementStoreAllowance(proof, seq, collection)`** transaction extension *"after proof validation"* |
| `Resources.set_friend_request_statement_account_for_sequence(...)` | `Origin::FriendRequestAlias`, from `RegisterFriendRequestWithProof` |

`collection` is `MembershipCollection::{People | LitePeople}` and `proof` is an **anonymous ring-VRF
membership proof**. That is personhood, and there is no other door.

Measured on chain the same day (`node contracts/scripts/probe-statement-allowance.mjs`):

```
StmtStoreSlotsPerPeriod        20     <- a full person may authorize 20 accounts per DAY
LiteStmtStoreSlotsPerPeriod    10     <- a lite person, 10
StmtStoreGraceWindow           172800 <- 2 days, then the OCW sweeps the entry
Resources.StatementStoreAllowances: 106 entries
  period 20663 (-2 d)  52     period 20664 (-1 d)  33     period 20665 (TODAY)  21
PeopleLite.LitePeople  158 entries      People.AccountToPersonalId  0 entries
```

Every live allowance sits in today, yesterday or the day before — exactly the grace window. **An
allowance is a daily slot, not a session property.** No cache TTL in `allowance.ts` has any bearing on
it.

### Why signing in again cannot possibly help

**[V]** from `auth-BuYgQyky.js`. The pairing handshake `Bl({...})` is **read-only on the browser
side**: it computes a QR payload from a locally generated `DeviceIdentity`
(`statementAccountSeed = crypto.getRandomValues(32)`), then only `subscribeStatements` + polls
`queryStatements`. **The phone writes the handshake statement; the browser writes nothing.**

Three things follow, and they match the reported symptom exactly:

1. **Login always appears to succeed**, allowance or not — it never submits a statement, so it never
   touches the gate.
2. **The first browser→phone request is the first statement the browser ever submits.** That is
   `createTransaction` / `signRaw` / `getRingVrfAlias` / `requestResourceAllocation`. So *every*
   action fails, identically, immediately after a "successful" sign-in.
3. **A fresh pairing makes it worse, not better**: the browser mints a *new* random statement account
   which needs its own `set_statement_store_account`, i.e. its own personhood proof and its own daily
   slot.

### What this account looks like

The product account `0x18773c30d65de35027ac8cd19e98c0ddb9c44ef9` → `5EJ3VTQ…` (via
`Revive.OriginalAccount`, **never derived**) is **neither a `LitePerson` nor a full `Person`** —
checked 2026-07-31 against 158 `LitePeople` entries.

⚠️ **[V] 2026-07-31 — that is not evidence about the user's status AT ALL, and it never can be.**
Upgraded from `[?]`: see § *THE ACCOUNT IS PER-WALLET-ROOT*. A product account is
`publicSoft(rootPublicKey, ["product", productId, index])`; personhood is registered against the
*identity* account, a different key that the SSO handshake carries in a different field
(`rootAccountId` vs `identityAccountId`), and there is no on-chain map between them. An exhaustive
search for a parent of `5EJ3VTQ…` over all 4260 revive-mapped accounts (which include all 159
`LitePeople`) × 6 product ids × 2 indices found **nothing** — `node contracts/scripts/probe-product-account.mjs --link`.
**Never write "the user has no personhood" on the strength of this read.** What is `[V]` is that
*this* account is in neither collection — which is expected of every product account — and that
personhood is the only route to an allowance.

### ⭐ The split that matters most, and it is still `[?]`

- On **2026-07-30 22:22** a profile was created on chain and two threads published, from a phone.
- On **2026-07-31** every host-signed contract write failed with `noAllowance`.

The most likely reading is that the first ran in the **native Polkadot app container** — where the
host *is* the device, signing is local, and no SSO channel and no statement store are involved — while
the second ran in a **browser paired to a phone over SSO**, which is the only surface the failure
above can occur on. If that is the split, **"Arm 1 — host-signed contract writes work" is true of the
native container and has never been demonstrated in the browser host**, and much of the write column
in STATUS.md is scoped more narrowly than it reads.

**[?] Nobody has confirmed which surface either session was.** It cannot be settled from a
development machine — it needs someone to open Plaza *inside the Polkadot app* and post. That is now
the single highest-value device test in the repo.

### What the app does about it

`frontend/src/lib/host/errors.ts`: the code is `no_statement_allowance` (**renamed from
`stale_session`**, which encoded the wrong diagnosis in the one place people look). The copy no longer
says "sign in again"; it says open Plaza inside the Polkadot app, offers personhood as the second
route, and explicitly disowns re-login. `isAllowanceFailure` still returns true so
`allowance.invalidate()` runs, but that is **bookkeeping** — it stops the diagnostics panel claiming a
grant we do not have, and fixes nothing.

⛔ **There is no app-side fix, and do not invent one.** A delegate key is not an escape route: the
pointer write is host-signed, and the derived delegate H160 is unfunded with nonce 0. Wiring
`authorizeDelegate` on a browser host just adds a fourth thing that fails identically.

**[?] Still open:**
- Whether the **native container** has this failure mode. Everything traced above is
  `browse.dev-dot.li`'s SSO channel. Do not assume it generalises.
- Whether the phone, for a user who *does* hold personhood, calls `set_statement_store_account` for
  the browser's statement account at pairing time. It is the only mechanism that fits and the QR
  payload carries exactly the account it would need — but it is `[I]`, read off the browser half of a
  two-party protocol.
- Whether a working browser session therefore dies at a **period boundary** (a day). If it does, that
  and not a lapsed session is what a returning user hits.

## Frontend / SDK traps

**⛔⛔ A PROP DEFAULT WRITTEN AS `= []` IS A RENDER LOOP IF IT REACHES A DEP ARRAY.** [V] 2026-08-01.
This froze the whole app on the phone, and it presented as *"when I open the profile screen I cannot
click on anything"* — which reads like a stuck modal or an invisible overlay. It was neither. There
was nothing on top of the page; the main thread was simply never free.

```tsx
function ProfileView({ links: propLinks = [] }) {        // ⛔ new array EVERY render
  useEffect(() => {
    getLinks(addr).then(setLinks)                        // ⛔ .map() → new array → new state
  }, [addr, getLinks, propLinks])                        // ⛔ deps differ every render
}
```

Three ordinary-looking lines close the circle: the default is a fresh identity per render, so the
deps always differ, so the effect always runs, so `setLinks` schedules the next render. `App.tsx`
never passed `links`, so the default fired every time and nobody noticed for months.

**The rate depends on whether the read does I/O, and the dangerous case is the one that does not:**

| State | Effect runs | What it is |
|---|---|---|
| Chain reader present | ~10/s, forever | a permanent chain-read stream at the host bridge |
| **No chain reader yet** — `getReadContract()` → `null`, so the read resolves with **no I/O** | **~5,300/s** (44,862 in the first seconds, measured on a desktop) | the freeze |

**A cold host start spends its first seconds without a reader**, which is exactly when the user lands
on a screen. And hooks run before early returns, so `ProfileView`'s `if (!provider) return <Connecting/>`
does not stop it — the "connecting" placeholder was looping underneath.

Rules:
- **Hoist the default to a module constant** (`const NO_LINKS: Link[] = []`). A default that is a
  literal is the bug; a default that is a constant cannot be.
- ⛔ **Do NOT fix it by shortening the dep array.** That silences the loop and quietly breaks the
  prop, and the next person to restore the dep for `react-hooks/exhaustive-deps` re-creates the freeze.
- **`react-hooks/exhaustive-deps` will never warn about this** — the deps are exhaustive. It is
  *stability*, not completeness, and no lint rule in this repo checks it.
- **The DOM tells you nothing.** A re-render producing identical output commits zero mutations, so a
  `MutationObserver` sees a still page. A `setTimeout(0)` lag probe also stayed at 6 ms, because the
  loop yields through microtasks. **Count the effect runs** — a two-line `window.__x = (window.__x ?? 0) + 1`
  instrument, then reload, is what actually distinguishes 3 from 44,862.

Swept 2026-08-01: `ProfileView` was the only instance. `Sidebar`'s `following = []` looks identical
and is safe — `App` always passes it and it is `useState` (stable), and `getDisplayName` is
`useCallback(…, [])`. That is the check to repeat: **does anything ever leave the prop undefined, and
is what gets passed stable?**

**`contract.getAddress()` is an ethers v6 built-in** that silently shadows a same-named ABI function and
returns the contract's *own* address. Use `contract.getFunction("getAddress(string)")`. Same family as
the `HeadRef.movedAt` trap: a decoded struct is a `Result` (an Array subclass), so `ref.at` resolves to
`Array.prototype.at` and hands you a **function** with no error.

**`Number(params.get(x))` is `0` for a missing param**, and `0` is finite — so a `Number.isFinite`
guard silently turns every numeric default into zero. Check `=== null` first.

**`isInsideContainer()` is async**; `isInsideContainerSync()` is the sync one. A plain ternary on the
async version is always truthy.

**Two different `Result` types in one SDK.** `@parity/result` (`{ok, value|error}`, branch on `.ok`) for
the `product-sdk-*` functions, and **neverthrow** `ResultAsync` (`.match(ok, err)`) for
`AccountsProvider` methods.

**`require.resolve` fails on the ESM-only `@parity/*` packages even when installed.** A Vite plugin used
that check to decide whether to stub them, so it never stood down and **shadowed the real SDK** — the
app built, deployed, and would have refused to sign. The tell was a 0.34 kB chunk where the SDK should
be. Removed 2026-07-30; use `import.meta.resolve` if you ever need this check.

**`eth_getLogs` cannot see events from host-submitted contract calls.** The host submits native `Revive`
extrinsics, producing `Revive.ContractEmitted` in `System.Events` and nothing in the ETH log index.
**Polling is correct here — do not "modernise" it into log subscriptions.** The tx hash the host reports
is a Substrate extrinsic hash, not an ETH one.

**The host does not proxy legacy JSON-RPC.** `state_getMetadata` returns `-32601`; only `chainHead_v1_*`
is bridged. Fetch metadata through the `Metadata_metadata_at_version(15)` runtime API.

**`Revive.call`'s field is `weight_limit`, not `gas_limit`**, and PAPI's dynamic builder wants plain hex
strings for `H160`/`H256`. A wrong shape surfaces as `Incompatible runtime entry Tx(Revive.call)`, which
reads like a missing call and is not.

**Nothing opens the host transport for you.** Until something calls `getTruApi()`, the host never sees a
connected product and `waitForConnection()` hangs forever.

**`getLookupFn` from `@polkadot-api/metadata-builders` silently drops variant doc strings** — which is
why an earlier pass concluded the Bulletin pallet was undocumented. The docs were on chain all along.

---

## Documents that are wrong

Both repos' notes are load-bearing, so their errors matter.

- **`yolodot/docs/platform/sdk-notes.md` §1** argues at length that `AutoSigning` works, with three
  numbered consequences. Superseded by the host-bundle investigation and never annotated. Its §5c also
  records the personhood precompile as `[?]` when the app code has the address, and it claims packages
  ship `src/` alongside `dist/` — `@parity/truapi@0.5.1` does not.
- **`docs.polkadot.com/apps/` documents a different product** (`playground-cli`, gateway `dot.li`, a
  third network, no Windows build). yolodot's advice to "check it first" is wrong. It *is* the only
  source for Bulletin retention and DotNS rules.
- **`MAX_CONTENT_LENGTH` was 40,000 bytes**, not the 2,000 that `contracts/CLAUDE.md` and yolodot's
  decision 007 both stated, nor the 10,000 in ForumThread's own docstring.
- **This file was wrong twice, corrected 2026-07-30.** It claimed `.cdm/solidity/<scope>/<name>.sol`
  was "the reliable way to recover" a deployed address — it is regenerated build output and can come
  back zeroed. And it framed personhood as "the finding that unblocked Voting" when the precompile
  cannot gate a write at all. Both were written the same day they were falsified, which is the whole
  argument for the `[V]`/`[I]`/`[?]` convention: the first was `[I]` dressed as fact, and the second
  had never been tested against a real context or checked for an account→alias binding.
- **`CLAUDE.md` said "135 tests" while `npm test` ran 42.** Three contracts sat in
  `contracts/.isolate/` so their artifacts did not exist and 93 tests never ran — the suite reported
  "42 passing, 3 failing" and the 3 looked like the whole problem. Isolating a contract silently
  disables its tests; if you must do it, do it for one command, not as a resting state.
