# The simulated host — what `@parity/host-api-test-sdk` can and cannot do

**Written 2026-07-31.** Companion to [`STATUS.md`](STATUS.md) and [`gotchas.md`](gotchas.md). Claims are
tagged **[V]** verified / **[I]** inference / **[?]** unknown, with the method.

> **The one-line answer: yes, Plaza runs inside a simulated host, and it reads the real chain while
> it does.** `npm run test:host` boots `frontend/dist` — the bundle `pad` publishes — inside an
> in-process Polkadot Products container, over the real Spektr/truapi wire protocol, with the real
> `@parity/product-sdk` on the product side. `openHostSession()` completes, permissions are
> requested and granted, a product account resolves, and `PostRegistry.getHeadsPaged` returns the
> two threads that are actually on devnet. **[V] 2026-07-31**, `tests/10-plaza-in-host.spec.ts`.

⛔ **It is a TEST SEAM, not an alternative path.** Nothing under `frontend/tests/` is imported by
`src/`, there is no test-only branch in production code, and none may be added. gotchas.md
§ *THE SDK PATH IS THE ONLY PATH* still governs. The sanctioned in-app dev seam remains
`?backend=fake`.

---

## What it is

`@parity/host-api-test-sdk@0.11.0`, a devDependency. `createTestHostServer()` serves a one-page HTML
host (`dist/host-page.js` + an 898 kB `dist/host-bundle.js`) that embeds the product in an iframe and
answers the truapi protocol from the parent frame. Playwright drives the host page; the product is
untouched and unaware.

Two products are wired up:

| Product | Port | What it is for |
|---|---|---|
| `tests/fixture-app/` | 5199 | A minimal probe. Ask the protocol direct questions (`00`–`03` specs). |
| **`frontend/dist`** | 5200 | **Plaza itself** (`tests/plaza-app.vite.config.ts`, `tests/plaza-fixture.ts`). |

---

## Coverage: all 64 wire methods, by domain

The protocol has **64** methods (`@parity/truapi` `dist/generated/wire-table.js`, counted). The test
host implements **55**. Every claim below is **[V]**, read from `dist/host-bundle.js` verbatim.

| Domain | Wire methods | Implemented | How, and what it is not |
|---|---|---|---|
| `system` | 3 | 3 | `handshake`, `featureSupported`, `navigateTo`. ⚠️ `featureSupported` answers `true` **only** for `{tag:'Chain'}` with a declared genesis; **every other feature tag returns `false`** — including any future probe. `navigateTo` is logged, never followed. |
| `permissions` | 2 | 2 | `approve-all` by default, `reject-all` or a predicate on request. **No UI, no user.** |
| `account` | 7 | 7 | `getAccount`, `getAccountAlias`, `createAccountProof`, `getLegacyAccounts`, `connectionStatusSubscribe`, `getUserId`, `requestLogin`. ⚠️ **The derivation is a stand-in — see below.** `getUserId` returns the dev account's name as `primaryUsername`. |
| `signing` | 6 | 6 | Real sr25519 over `@polkadot/keyring`. `createTransaction` returns a genuinely signed extrinsic. |
| `chain` | 13 | 13 | **PROXIED TO A REAL NODE.** `handleChainConnection` opens a websocket to whatever `rpcUrl` the matching `NetworkConfig` names and forwards the new JSON-RPC family. Reads, dry-runs and `broadcastTransaction` all reach the live chain. |
| `preimage` | 2 | 2 | `submit` and `lookupSubscribe` — over an **in-memory `Map`**. ⛔ Never touches Bulletin. |
| `statementStore` | 4 | 4 | `submit`, `subscribe`, `createProof`, `createProofAuthorized` — in-memory, topic-filtered. ⛔ **No allowance model at all.** |
| `localStorage` | 3 | 3 | In-memory. |
| `notifications` | 2 | 2 | Logged, never displayed. |
| `chat` | 6 | 6 | Rooms, bots, messages, injectable peer actions — all in-memory. |
| `theme` | 1 | 1 | `{name:{tag:'Default'},variant:'Light'\|'Dark'}`, switchable from the test. |
| `entropy` | 1 | 1 | ⚠️ Derives from the root public key with the context string **hardcoded to `"test-product"`** — so a delegate key derived here is not the one a real host would give. |
| `payment` | 4 | 4 | `balanceSubscribe`, `topUp`, `request`, `statusSubscribe`. A `bigint` counter. `request` fails only on insufficient balance and completes instantly. |
| `resourceAllocation` | 1 | 1 | ⛔ **`handleRequestResourceAllocation` maps every requested resource to `{tag:'Allocated'}`, unconditionally, ignoring the tag.** |
| **`coinPayment`** | **9** | **0** | ⛔ **Not implemented at all** — `createPurse`, `queryPurse`, `rebalancePurse`, `deletePurse`, `createReceivable`, `createCheque`, `deposit`, `refund`, `listenForPayment`. Nothing in the bundle mentions `coin_payment`. |

**[V] This confirms and extends the earlier note about money methods:** exactly **four** `payment.*`
handlers and **zero** `coinPayment.*` — and the zero is nine named methods, not an omission of one.
It is one more independent data point for STATUS.md's *"CASH is Coinage; `payment.*` is how you spend
it"*: the reference test host, like the reference bundle, implements only the RFC-0006 surface.

### The five answers the brief asked for

1. **Product account — yes, but the derivation is NOT the real one. [V]**
   `handleAccountGet` is, in full:
   ```js
   const key = `${dotNsIdentifier}/${derivationIndex}`;
   if (productAccounts[key]) return keypair(productAccounts[key].uri);
   return keypair(`${rootUri}//${dotNsIdentifier}/${derivationIndex}`);
   ```
   A `@polkadot/keyring` URI derivation — **not** `publicSoft(rootPublicKey, ["product", id, index])`.
   Same three inputs, different arithmetic. ⛔ **No address produced here can be compared with
   `0xda46…712e` or `0x18773c30…`.** What it *can* do is act as a key-observation probe — see
   § *The account experiment*.
2. **Contract writes — signed for real, and they CAN reach the chain. [V]/[I]**
   `createTransaction` produces a real signed extrinsic **[V]**, and because `chain` is proxied,
   `broadcastTransaction` would submit it to the live devnet **[I — never exercised, deliberately]**.
   The signer is `//Alice//plaza.dot/0`, which is unfunded there, so a write would fail on fees
   rather than on shape. ⛔ `tests/README.md`'s rule stands: **do not add a test that broadcasts.**
3. **Preimage — write yes, read no. [V]**
   `preimageSubmit` stores into the map, so Plaza's Bulletin *write* path (`session.ts` `putBlob` →
   preimage channel) executes end to end and the bytes are inspectable with `getPreimages()`.
   `preimageLookupSubscribe` answers from the same map, so `lib/bulletin.ts` →
   `resolveQueryStrategy` / `executeQuery` **finds nothing** for a CID written by anyone else.
   Bodies render as "(content no longer available)", correctly. `seedPreimage(bytes)` is the only
   way to make a lookup hit.
4. **`requestResourceAllocation` — implemented, and worthless as evidence. [V]** It allocates
   everything. It reproduces **none** of the statement-store behaviour that broke the browser host on
   2026-07-31: no periods, no slots, no personhood, no ring-VRF, no failure mode.
5. **Chain reads — real. [V]** See the table. This is the single most valuable property of the
   harness.

---

## What it proves, and what it cannot

**Can [V]**

- Plaza boots, handshakes, resolves an account and reads the real devnet contracts inside a container.
- Exactly which wire methods a Plaza action invokes, and how many times.
- Which permissions Plaza requests: measured `ChainSubmit` (×2) and `PreimageSubmit`, in that order.
- Real chain reads and real extrinsic construction against the deployed contracts.
- Layout, colour and contrast — **at last, in pixels** (§ *Screenshots*).

**Cannot [V, from the bundle]**

- ⛔ **Say anything about prompts.** The host auto-signs and has no UI. `signingLog` is the faithful
  *proxy* for "this would have prompted", not the answer.
- ⛔ **Say anything about grants.** Every allocation is `Allocated`.
- ⛔ **Serve Bulletin content.** In-memory preimages only.
- ⛔ **Reproduce a real product-account address.** Different derivation.
- ⛔ **Model personhood, DotNS, or the deployed `dev-dot.li` shell.**
- ⛔ ⭐ **Settle native-container vs browser-over-SSO — the top open question in this repo.** The
  failure mode there is a personhood-gated statement-store *slot*, on a channel the simulator models
  as an in-memory array. A green run here is not evidence about a phone, and no amount of harness
  work will change that.

---

## The account experiment (`tests/12-product-account.spec.ts`)

The derivation is fake, so the *addresses* are worthless — but the **`productAccounts` map is keyed on
exactly the two values the wire carries**, `dotNsIdentifier` and `derivationIndex`. Point one key at a
distinguishable account and watch whether Plaza's address moves, and you have measured which key the
app requested. That half is real, because Plaza's request is real.

Eight boots, one variable at a time, no hardcoded addresses — every conclusion is "these two runs
agree" or "they differ":

**[V] Measured 2026-07-31**, eight boots, all eight arms green:

| Arm | `account.ss58` | Reading |
|---|---|---|
| baseline (root Alice) | `5Ca3pG9tugg…Bp6sL6` | `//Alice//plaza.dot/0` |
| `plaza.dot/0` → charlie | `5FLSigC9HGR…hXcS59Y` | **changes**, and it is *exactly* Charlie's well-known dev address ⇒ Plaza asks for `plaza.dot`, index 0 |
| `plaza.dot/0` → dave | `5DAAnrj7VHT…m3PTXFy` | Dave's dev address ⇒ the previous line was a hit, not a coincidence |
| `plaza-social.dot/0` → charlie | `5Ca3pG9tugg…` (baseline) | ⭐ **the name we are DEPLOYED under is never requested** |
| `plaza.dot/1` → charlie | baseline | the derivation index is 0 |
| `localhost/0` + `localhost:5200/0` → charlie | baseline | the hostname is never used as the identifier |
| served from `127.0.0.1:5200` | baseline, with `page.origin` genuinely different | ⭐ **the ORIGIN takes no part** |
| root Alice → Bob | `5EC3KgzK2m2…VJ2KseZ` | ⭐ **the root is the only thing that moves it** |

Both "changes" arms landed on the *named* dev account the map pointed at, which is what makes
this a measurement rather than a coin flip: the host was asked for `plaza.dot/0`, and only a
request for `plaza.dot/0` could have produced Charlie.

This upgrades gotchas.md § *THE ACCOUNT IS PER-WALLET-ROOT* from "read from
`@parity/product-sdk-keys`" to "read from the source **and** measured on the running app". The
`plaza.dot` / `plaza-social.dot` landmine is now **[V] at runtime**, not just derived from the SDK's
naming rule.

⛔ **It does not explain the user's two addresses**, and it cannot. The simulator is *handed* its root
as configuration; the reported split is between two roots, which happens inside the wallet, above the
product API. What the matrix does is eliminate everything on our side of the boundary. The remaining
candidate is the one STATUS.md already names — two roots — and settling it needs the two devices and
`account.primaryUsername` from DEBUG / IDENTITY on each.

---

## Screenshots (`tests/11-plaza-screenshots.spec.ts`)

⭐ **The Browser pane does not composite frames; Playwright does.** This is the first time anyone in
this project has *seen* the app. Output: `frontend/tests/.artifacts/screens/` (gitignored).

Two sets, and the difference decides how to read them:

- **`host-*`** — the real host backend, the real devnet chain. Thread cards, the author's display
  name and the timestamps are genuine. **Bodies are missing** because the simulator's preimage map is
  empty, so the board shows the app's degraded state honestly.
- **`fake-*`** — `?backend=fake&caps=live`, still inside the container iframe so the geometry is
  identical. Its chain reader **answers empty on purpose** (`fake.ts`: *"It invents no content"*), so
  this set is the EMPTY-STATE review.

⛔ **There is no configuration of this harness that shows a populated board with real bodies.** The
simulator cannot serve Bulletin content and the fake backend will not invent it. That is worth
knowing on its own: **the only way to review Plaza with real content is a real device** — or a
`fake.ts` that seeds a few objects, which is a production-code change and not the harness's to make.

---

## Running it

```bash
cd frontend
npx playwright install chromium        # first time
npm run test:host                      # everything: probe specs + Plaza specs
npm run test:host:plaza                # Plaza only (10, 11, 12)
npx playwright test 11-plaza-screenshots   # just the pictures
```

Both webServers start automatically: `vite build` of the probe app on :5199 and of Plaza on :5200.
The Plaza build is `vite build`, **not** `tsc -b && vite build`, so somebody else's half-finished
edit in `src/` cannot fail this harness for reasons unrelated to it.

### Gotchas found while wiring this up

- ⚠️ **Declare the DEVNET Asset Hub, not the SDK's built-in `PASEO_ASSET_HUB`.** Our contracts live
  on genesis `0xd6eec261…`, served by `wss://asset-hub-paseo-rpc.n.dwellir.com` **[V] 2026-07-31 via
  `chain_getBlockHash(0)`**. The test SDK's default is `0xbf0488db…`
  (`paseo-asset-hub-next-rpc.polkadot.io`), a different chain — declare only that and every read comes
  back empty, which looks exactly like a broken deployment.
- ⚠️ **`wss://bulletin-paseo.tservices.es:8443` answers HTTP 429** on the websocket handshake and PAPI
  retries in a tight loop (17 failed handshakes in 15 s, measured). `PLAZA_NETWORKS` deliberately
  omits the devnet Bulletin, which makes `featureSupported` say `false` and sends `session.ts` down
  its existing paseo fallback — exercising the fallback rather than hiding it.
- ⚠️ **The host page forwards its own `location.search` into the iframe**, exactly as the real dot.li
  shell does. So `hostUrl/?backend=fake&caps=live` reaches Plaza unchanged.
- ⚠️ **The first contract read pays for ~880 kB of Asset Hub metadata** over the proxied RPC. Allow
  45 s before asserting on rendered chain data.
- ⚠️ Serve a **built** bundle, never the vite dev server: dep pre-bundling reloads the iframe
  mid-test and destroys Playwright's execution context.
- ⛔ **Turn tracing OFF for these specs.** `trace: 'retain-on-failure'` records *continuously*;
  with ~4 MB of chain metadata streaming through a session held open for minutes, the buffer
  OOM-killed the Playwright worker (`code=134`) twice, taking every screenshot with it.
- ⛔ **Never `waitForFunction(() => …document.body.innerText…)`.** Same crash, different cause:
  it re-reads the whole rendered text on every animation frame. Poll from the Node side.
- ⚠️ **`vite preview` binds `localhost`, which on Windows can be `::1` only** — so
  `http://127.0.0.1:5200` is not served and the origin-variation arm fails with "iframe never
  appeared", which reads like an app bug. `preview.host: true` fixes it. And note
  `reuseExistingServer` means a stale preview from an earlier run keeps the OLD bind address:
  kill it, or the config change appears not to work.
- ⚠️ **Leaving the board and coming back re-runs the whole walk.** There is no list cache, so
  thread cards are absent for several seconds every time you navigate back to the forum. A fixed
  short wait reports "empty board" on a board that has two threads.
- ⚠️ **`getByRole` cannot see a `display:none` element**, and below `xl` the entire sidebar is
  `hidden` — count a nav row before opening the drawer and you get 0.
- ⚠️ **Nav rows carry a leading glyph** (`☰ Forum`, `⚙ Settings`, `@ 0x…`), so an anchored
  `/^Forum$/` matches nothing and then hangs on `click()` until the test times out.

---

## Open, and worth doing

1. **[?] Can `seedPreimage` be used to render a real thread?** It needs the exact bytes of a Bulletin
   object, and the only routes to those are the IPFS gateways this repo deliberately deleted. Not
   attempted; deliberately.
2. **[?] Does `broadcastTransaction` through the proxy actually reach the chain?** Believed yes by
   construction; not tested, because the test that answers it is a live write.
3. **[?] Would a `fake.ts` content seed be worth it?** It would make visual review possible without a
   device. It is a production-code decision (the fake currently refuses to invent content **on
   purpose**), so it belongs to whoever owns `lib/host/fake.ts`.
