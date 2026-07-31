// ⭐ THE ONLY MODULE IN THIS APP THAT IMPORTS `@parity/*`. Keep it that way.
//
// Two reasons, both load-bearing:
//
//  1. It is its own lazily-loaded chunk. A visitor who only reads never downloads the signing SDK,
//     and a resolution failure in here cannot take the read path down with it.
//  2. The SDK THROWS OUTSIDE A CONTAINER. Importing it eagerly from a module on the load path means
//     localhost development stops working entirely — which is why the fake backend (`fake.ts`)
//     exists and why nothing above this file may import `@parity/*` directly.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ⚠️ THE `@ts-ignore` ON EACH IMPORT IS DELIBERATE AND TEMPORARY.
//
// The `@parity/*` packages are not yet in `frontend/package.json` (they are listed in this task's
// report for a single install pass). Without the suppression `tsc -b` fails with TS2307 and the
// whole app stops building — including the fake-backend path, which needs none of these packages.
//
// `@ts-ignore` rather than `@ts-expect-error` ON PURPOSE: `@ts-expect-error` would itself become an
// error the moment the packages ARE installed, so the file would need editing twice. `@ts-ignore`
// is a no-op once resolution succeeds. The cost is that these bindings are `any` until someone
// removes the comments, which is why every one of them is unwrapped through a typed helper below
// rather than used directly by callers.
//
// The `@parity/*` packages are now real runtime dependencies, so nothing shims them at build time.
//
// ⚠️ HISTORY WORTH KEEPING. `vite.config.ts` used to carry a `parityOptionalDeps()` plugin that stubbed
// any un-installed `@parity/*` package. Its own comment warned that a stub shadowing a real package
// would be "a genuinely horrible bug — the app would build, deploy, and refuse to sign". That is
// exactly what it did: it tested installation with CJS `require.resolve`, but these packages are
// ESM-only, so the check failed even once they were installed and the stub never stood down. The
// symptom was a 0.34 kB chunk where the SDK should be. Plugin deleted 2026-07-30.
//
// The `__parityStub` guards below are retained deliberately: on a real module namespace the property
// is `undefined`, so every check reads "SDK available" and they cost nothing.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// The bindings below are `any` until the packages are installed; unwrapping happens in typed helpers.
/* eslint-disable @typescript-eslint/no-explicit-any */
//
// `ban-ts-comment` wants `@ts-expect-error` instead of `@ts-ignore`, and in general it is right — an
// unnecessary suppression should be an error. Not here: these suppressions ARE expected to become
// unnecessary the moment the `@parity/*` packages are installed, at which point `@ts-expect-error`
// would fail the build and this file would need editing twice. `@ts-ignore` is the correct tool for a
// suppression whose disappearance must be a non-event.
/* eslint-disable @typescript-eslint/ban-ts-comment */

// @ts-ignore optional dependency — see the block comment above
const importHost = () => import('@parity/product-sdk-host')
// @ts-ignore optional dependency — see the block comment above
const importWallet = () => import('@parity/product-sdk/wallet')
// ⛔ `@parity/product-sdk-keys` IS DELIBERATELY NOT HERE. `KeyManager.fromRawKey(...).deriveAccount()`
// is the right primitive when the delegate signs NATIVE extrinsics, as the reference app does. This
// repo's delegate signs through `ethers` against the pallet-revive ETH RPC, so the derived entropy
// becomes a secp256k1 key directly (`delegate.ts`, `entropyToPrivateKey`) and a second key-derivation
// library would be an extra megabyte to do the same HKDF twice. Add it back if and when the delegate
// moves to native submission — that is also when the nonce and finality traps in the reference app's
// `delegate.js` start applying.
// @ts-ignore optional dependency — see the block comment above
const importCloudStorage = () => import('@parity/product-sdk-cloud-storage')
// @ts-ignore optional dependency — see the block comment above
const importStatementStore = () => import('@parity/product-sdk-statement-store')
// Arm 1. `submitAndWatch` is what actually signs a NATIVE `Revive` extrinsic with the host signer —
// there is no `eth_sendTransaction` the host will answer, so this is the only route for a
// host-signed contract write. Loaded lazily like the rest: a read-only session never needs it.
// @ts-ignore optional dependency — see the block comment above
const importTx = () => import('@parity/product-sdk-tx')
// Owner-only contract writes. These must be signed by the PRODUCT ACCOUNT, not the delegate key, so
// they go through the host's Asset Hub client rather than ethers. See `contracts.ts`.
// @ts-ignore optional dependency — see the block comment above
const importContracts = () => import('@parity/product-sdk-contracts')
// @ts-ignore optional dependency — see the block comment above
const importChainClient = () => import('@parity/product-sdk-chain-client')
/**
 * SS58 ↔ raw-bytes CODECS. Pure maths, no host, no chain.
 *
 * ⛔ IT IS HERE FOR ONE THING: `ss58Decode`, to turn the `SS58String` that
 * `Revive.OriginalAccount` returns back into the 32 raw bytes `payment.request` takes
 * (`destination: S.Hex(32)` in `@parity/truapi`). That is a DECODE — it recovers exactly the bytes
 * the chain encoded — and it is the opposite of the forbidden thing.
 *
 * ⛔ NOTHING MAY USE `deriveH160`/`ss58ToH160` FROM THIS PACKAGE TO GO THE OTHER WAY. H160 → account
 * is not a computation; see `types.ts` `PaymentsSeam.resolveRecipient`. Paying a derived account
 * destroys the money.
 *
 * Imported as the leaf package rather than `@parity/product-sdk/address`, whose barrel side-effect
 * imports cloud-storage, chain-client, contracts, crypto, host, local-storage and signer.
 */
// @ts-ignore optional dependency — see the block comment above
const importAddress = () => import('@parity/product-sdk-address')

/**
 * Asset Hub chain DESCRIPTORS, imported one at a time.
 *
 * ⚠️ Two reasons this is a per-environment dynamic import rather than `getChainAPI(env)`:
 *
 *  1. **The descriptor is a separate import, not a property of the client.** `ChainClient` exposes
 *     `.raw.<name>` and the typed API; there is no `.descriptors`. Passing `client.descriptors?.assetHub`
 *     hands `undefined` to `createContractFromClient`, which stores it as a WeakMap key and throws
 *     `Invalid value used as weak map key` — a message that names nothing useful.
 *  2. **`getChainAPI`'s preset table statically references polkadot/kusama/paseo metadata**, dragging
 *     megabytes of chunks into a bundle we upload to Bulletin and never load.
 */
/**
 * ⚠️ ONLY the environments we can actually target. Each entry costs a ~880 kB metadata chunk in the
 * built bundle — and that bundle is UPLOADED TO BULLETIN, so an unreachable descriptor is bytes paid
 * for and never fetched. `session.ts` resolves everything to devnet or paseo; polkadot and kusama were
 * never reachable, so listing them added 1.7 MB to every deploy for nothing.
 */
const DESCRIPTOR_LOADERS = {
  // @ts-ignore optional dependency — see the block comment above
  devnet: () => import('@parity/product-sdk-descriptors/devnet-asset-hub').then((m) => m.devnet_asset_hub),
  // @ts-ignore optional dependency — see the block comment above
  paseo: () => import('@parity/product-sdk-descriptors/paseo-asset-hub').then((m) => m.paseo_asset_hub),
} as Record<string, () => Promise<unknown>>

const descriptorCache = new Map<string, Promise<unknown>>()

/** Resolve one Asset Hub descriptor. Throws for an unknown environment rather than returning null —
 *  a null descriptor is the exact value that produces the unreadable WeakMap error downstream. */
export function loadAssetHubDescriptor(environment: string): Promise<unknown> {
  const loader = DESCRIPTOR_LOADERS[environment]
  if (!loader) throw new Error(`no Asset Hub descriptor for environment "${environment}"`)
  let pending = descriptorCache.get(environment)
  if (!pending) {
    pending = loader()
    descriptorCache.set(environment, pending)
  }
  return pending
}

type Loader<T> = () => Promise<T>

/** Memoise so a second write does not re-import, and so a failure is not retried in a tight loop. */
function once<T>(loader: Loader<T>): Loader<T> {
  let pending: Promise<T> | null = null
  return () => (pending ??= Promise.resolve().then(loader))
}

export const loadHost = once(importHost) as Loader<any>
export const loadWallet = once(importWallet) as Loader<any>
export const loadCloudStorage = once(importCloudStorage) as Loader<any>
export const loadStatementStore = once(importStatementStore) as Loader<any>
export const loadTx = once(importTx) as Loader<any>
export const loadContracts = once(importContracts) as Loader<any>
export const loadChainClient = once(importChainClient) as Loader<any>
export const loadAddress = once(importAddress) as Loader<any>

/**
 * Is the SDK even present in this build?
 *
 * `vite.config.ts` substitutes a stub for any missing `@parity/*` package so the bundle still
 * builds; the stub sets this marker so we can tell "not installed" from "installed and refused"
 * instead of reporting a confusing failure. Without it, a developer who has not run the install
 * sees the same message as a user whose host connection is broken.
 */
export async function sdkAvailable(): Promise<boolean> {
  try {
    const host = await loadHost()
    return host?.__parityStub !== true
  } catch {
    return false
  }
}
