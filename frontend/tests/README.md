# Host-protocol integration harness

Runs a real `@parity/product-sdk` client inside a real Polkadot Products host
container, driven by Playwright. This is the only way to execute SDK calls
without the phone app or a devnet publish.

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
| `../playwright.config.ts` | testDir, single worker, webServer (build + preview of the probe app) |
| `host-fixture.ts` | the reusable fixture — wraps `createTestHostFixture`, adds `probe` |
| `fixture-app/` | the minimal "product": `index.html` + `main.ts`, its own vite config |
| `00-smoke.spec.ts` | host page loads, iframe attaches, consoles are readable |
| `01-container.spec.ts` | container detection, session handshake, account resolution |
| `02-allowances.spec.ts` | `requestResourceAllocation` — request, response, tag spelling |
| `03-prompts.spec.ts` | which operations reach the host's signing handler |

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
