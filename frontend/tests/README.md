# Host-protocol integration harness

Runs a real `@parity/product-sdk` client inside a real Polkadot Products host
container, driven by Playwright. This is the only way to execute SDK calls
without the phone app or a devnet publish.

⭐ **It runs PLAZA ITSELF, not only a probe app.** `tests/plaza-fixture.ts` points the
same test host at `frontend/dist` — the bundle `pad` publishes — and declares the
**devnet** Asset Hub, so the app's own `openHostSession()` → `PostRegistry.getHeadsPaged`
path executes against the **real deployed contracts**. It also takes **screenshots**,
which is the first time anyone in this project has seen the app.

**Read [`docs/products-platform/simulated-host.md`](../../docs/products-platform/simulated-host.md)
before drawing a conclusion from a green run here.** It has the full domain-by-domain
capability table (55 of 64 wire methods; `coinPayment` is 0 of 9) and, more importantly,
the list of things the simulator *cannot* prove.

## Run it

```bash
cd frontend
npm install                 # first time
npx playwright install chromium   # first time
npm run test:host           # build the probe app, start the host, run all specs
```

`npm run test:host` builds `tests/fixture-app` and serves it on `:5199`, then
`@parity/host-api-test-sdk` starts an in-process host page that embeds it in an
iframe over the real Spektr/truapi protocol.

Useful variations:

```bash
npx playwright test 02-allowances                  # one spec
npx playwright test --reporter=list -g "side by side"
npm run test:host:probe                            # hot-reloading probe app on :5199, no host
PROBE_URL=http://localhost:5173 npm run test:host  # point the host at a different app
```

Tests print their findings with `console.log` and assert only what is stable, so
a run is meant to be read, not just pass.

## Layout

| File | Role |
|---|---|
| `../playwright.config.ts` | testDir, single worker, **two** webServers: probe app on :5199, Plaza on :5200 |
| `host-fixture.ts` | fixture for the **probe app** — wraps `createTestHostFixture`, adds `probe` |
| `fixture-app/` | the minimal "product": `index.html` + `main.ts`, its own vite config |
| `00-smoke.spec.ts` | host page loads, iframe attaches, consoles are readable |
| `01-container.spec.ts` | container detection, session handshake, account resolution |
| `02-allowances.spec.ts` | `requestResourceAllocation` — request, response, tag spelling |
| `03-prompts.spec.ts` | which operations reach the host's signing handler |
| **`plaza-fixture.ts`** | fixture for **Plaza** — real networks, viewports, `open()`, `shot()` |
| **`plaza-app.vite.config.ts`** | serves `frontend/dist` on :5200 with framing allowed |
| **`10-plaza-in-host.spec.ts`** | Plaza boots, handshakes, reads the real devnet chain |
| **`11-plaza-screenshots.spec.ts`** | ⭐ pixels, at 375 and 1280, host-backed and fake-backed |
| **`12-product-account.spec.ts`** | ⭐ the controlled experiment on what the account depends on |

Two products, two ports:

| Product | Port | Config |
|---|---|---|
| `fixture-app/` (probe) | 5199 | `fixture-app/vite.config.ts` |
| `frontend/dist` (**Plaza**) | 5200 | `plaza-app.vite.config.ts` |

```bash
npm run test:host           # everything
npm run test:host:plaza     # specs 10–12 only
npm run test:host:screens   # just the pictures → tests/.artifacts/screens/
```

## Using the fixture in a new test

```ts
import { test, expect } from './host-fixture';

test('my thing', async ({ testHost, probe }) => {
  await testHost.waitForConnection(60_000);
  const rec = await probe.record('requestAllowance', 'BulletinAllowance', undefined);
  expect(rec.signingLog).toHaveLength(0);
});
```

- `testHost` is the upstream `TestHost` (`productFrame()`, `getSigningLog()`,
  `setPermissionBehavior()`, `getPreimages()`, …).
- `probe.call(method, ...args)` invokes one `window.__PROBE__` method inside the
  product iframe and returns its raw result.
- `probe.record(method, ...args)` does the same with the signing and permission
  logs cleared first, and returns `{ result, signingLog, permissionLog }`.

To test something new, add a method to `probe` in `fixture-app/main.ts` and its
name to `ProbeMethod` in `host-fixture.ts`.

## What this harness can and cannot tell you

**Can:**

- whether an SDK call encodes, reaches the host, and decodes — the wire contract
  between `@parity/product-sdk` and the host protocol is genuinely exercised
- exactly which host wire methods an operation invokes, and how many times
- account resolution with real sr25519 dev keys (Alice & co.)
- real chain reads and real extrinsic construction: the host proxies
  `chainHead_v1_*` to whatever networks the fixture declares

**Cannot:**

- tell you whether a real host would show a signing modal. The test host
  auto-signs everything and has no UI. `signingLog` is the faithful *proxy*
  (those six handlers are the ones a real host gates behind a prompt), not the
  answer.
- tell you whether a real host would *grant* a resource allocation. Its
  `handleRequestResourceAllocation` returns `Allocated` for every request
  unconditionally, ignoring the tag.
- exercise personhood, DotNS resolution, or anything the deployed
  `dev-dot.li`/phone host adds on top of the protocol.

**Do not** add tests that broadcast transactions. Everything here stops at
`tx.sign()`, which returns signed bytes and never submits.

## Gotchas found the hard way

- Nothing opens the transport for you. Until something calls `getTruApi()` the
  host never sees a connected product and `waitForConnection()` hangs forever.
  `fixture-app/main.ts` does this on boot.
- Serve a **built** probe app, not the vite dev server. Vite discovers
  `polkadot-api` lazily and reloads the iframe mid-test, destroying Playwright's
  execution context.
- The host proxies only the new JSON-RPC family. `state_getMetadata` returns
  `-32601 Method "state_getMetadata" is not supported by the host`; fetch
  metadata through the `Metadata_metadata_at_version` runtime API instead.
- `client.getUnsafeApi().tx` is a Proxy — `Object.keys()` on it returns `[]`.
  Enumerate pallets from metadata.
- `polkadot-api` has no runtime `FixedSizeBinary` export, and PAPI's dynamic
  builder wants **plain hex strings** for `H160`/`H256` args. A wrong shape
  surfaces as `Incompatible runtime entry Tx(pallet.call)`, which looks like a
  missing call.
- `Statement` fields are hex strings (`topics: HexString[]`, `data: HexString`),
  not byte arrays.
- `StoreBuilder` has no sign-only terminal: `send()` and `sendUnsigned()` both
  broadcast. That is why `03-prompts.spec.ts` stops at `checkAuthorization` and
  builds Bulletin extrinsics by hand through PAPI when it needs a signature.
- `PreimageManager.submit()` returns a bare `Promise<HexString>`, not a `Result`.
- **Declare the DEVNET Asset Hub** (`0xd6eec261…`, `wss://asset-hub-paseo-rpc.n.dwellir.com`).
  The test SDK's built-in `PASEO_ASSET_HUB` is a *different chain* and our contracts are not on
  it — every read comes back empty and it looks exactly like a broken deployment.
- **`wss://bulletin-paseo.tservices.es:8443` answers HTTP 429** on the websocket handshake and
  PAPI retries in a tight loop. `PLAZA_NETWORKS` omits it deliberately; `session.ts` then takes
  its existing paseo fallback.
- **The host page forwards its own `location.search` into the iframe**, exactly like the dot.li
  shell — so `hostUrl/?backend=fake&caps=live` reaches Plaza unchanged.
- **`getByRole` cannot see a `display:none` element.** Below `xl` the whole sidebar is `hidden`,
  so counting a nav row before opening the drawer reports 0 and silently skips the step.
- **Nav rows carry a leading glyph** (`☰ Forum`, `⚙ Settings`, `@ 0x…`), so `/^Forum$/` matches
  nothing and then hangs on `click()` until the test times out.
- ⛔ **Never `waitForFunction(() => …document.body.innerText…)`.** It re-reads the whole rendered
  text every animation frame; it OOM-killed the Playwright worker here (`code=134`). Poll from
  the Node side instead.
- **The first contract read pays for ~880 kB of Asset Hub metadata** over the proxied RPC. Allow
  a minute before asserting on chain-derived UI.
