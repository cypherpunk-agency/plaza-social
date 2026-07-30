// Container detection.
//
// ⚠️⚠️ THE TRAP THIS MODULE EXISTS TO CONTAIN:
//
//     `isInsideContainer()` is ASYNC. A Promise is ALWAYS truthy. So
//
//         isInsideContainer() ? realBackend() : fakeBackend()
//
//     silently always picks `realBackend()`, on every machine, forever, with no type error and no
//     runtime warning — the app just tries to talk to a host that is not there and hangs. This has
//     already bitten the reference codebase once.
//
//     `isInsideContainerSync()` is the sync one and the ONLY safe check for a branch.
//
// The two are kept behind `insideContainer()` below so no caller has to remember which is which.
// If you need the async form for something (it can in principle answer later than the sync form,
// after the host channel has settled), await it explicitly and never put it in a condition
// position.
//
// This module is deliberately tiny and separate: it must be cheap enough to sit on the load path,
// because a reader should not download the signing SDK to find out they cannot sign.

import { loadHost } from './sdk'

/**
 * The synchronous, branch-safe answer. `false` on any failure — outside a container, with no SDK
 * installed, or if the check itself throws.
 *
 * Async because it has to *load* the SDK chunk first; the CHECK inside is the sync one. The
 * distinction matters: awaiting this is fine, using its Promise in a ternary is not, which is why
 * it returns `Promise<boolean>` rather than exposing the raw SDK function.
 */
export async function insideContainer(): Promise<boolean> {
  try {
    const host = await loadHost()
    if (host?.__parityStub === true) return false
    // ⛔ isInsideContainerSync, NOT isInsideContainer. See the header.
    return host.isInsideContainerSync() === true
  } catch {
    return false
  }
}

/**
 * The host binds each product to a DotNS identifier and refuses to sign when it disagrees with the
 * URL it loaded. Deployed, we run on a sandbox origin rather than the bare `.dot` name, so derive
 * it rather than hardcoding either.
 */
export function productIdentifier(): string {
  return globalThis.location?.hostname ?? 'localhost'
}

/**
 * The `deriveEntropy` / key-derivation namespace root.
 *
 * ⚠️ CHANGING THIS STRING CHANGES EVERY DERIVED KEY. The on-chain authorisation for the old
 * delegate is then orphaned — still valid, still costing the user a storage item, and pointing at a
 * key the app can no longer produce. Version it (`:v2`) only when you actually mean to rotate, and
 * revoke the old delegate first if you do.
 */
export const PRODUCT_NAMESPACE = 'plaza'
