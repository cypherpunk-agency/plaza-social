// Resolving "who gets the CASH" — the pure half. No SDK, no React, no chain.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ⛔ THE ONE RULE: H160 → ACCOUNT IS A LOOKUP, NEVER A COMPUTATION.
//
// Plaza knows people by their 20-byte `msg.sender`. `truApi.payment.request` takes
// `destination: S.Hex(32)` — a 32-byte AccountId32. There is no function from the first to the
// second. `h160ToSs58()` and every "derive" helper in `@parity/product-sdk-address` build the
// 0xEE-suffixed *fallback* account, which is a DIFFERENT account nobody holds a key for: measured on
// chain, the real Plaza writer maps to `5EJ3VTQ…` while the derivation gives `5CcnRhQ…`. Paying the
// second destroys the money, silently and permanently.
//
// The only sound route is the chain's own reverse map, `Revive.OriginalAccount`. This module owns the
// two pure steps on either side of that read — normalising the key that goes in, and turning the
// bytes that come out into the wire form — so both can be tested without a host.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Exactly what `payment.request.destination` is: `S.Hex(32)`, i.e. 32 raw bytes. */
export const DESTINATION_BYTES = 32

/**
 * Normalise an H160 for use as an `OriginalAccount` storage key, or `null` if it is not one.
 *
 * Lowercased because the storage key is the raw 20 bytes and a checksummed `0xAbC…` string and its
 * lowercase form must not become two different cache entries — or, worse, two different lookups
 * where one hits and one misses.
 *
 * ⚠️ Deliberately strict about the shape. An SS58 string, a 32-byte hex, a bare `0x`, or a truncated
 * `0x1877…f9` display form must all be REJECTED rather than padded, hashed or sliced into something
 * 20 bytes long. Every one of those "helpful" fixes silently addresses a different account.
 */
export function normaliseH160(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null
  const text = input.trim().toLowerCase()
  return /^0x[0-9a-f]{40}$/.test(text) ? text : null
}

/**
 * Turn the 32 bytes an `OriginalAccount` row decodes to into the `0x…` string the host wants.
 *
 * ⛔ THROWS ON THE WRONG LENGTH RATHER THAN PADDING OR TRUNCATING. A 31- or 33-byte value means the
 * decode disagreed with the wire contract, and the cost of guessing at that point is somebody's
 * money going to an address derived from a mistake. `sendTip` never sees a malformed destination
 * because this refuses to produce one.
 */
export function destinationFromPublicKey(publicKey: Uint8Array): string {
  if (!(publicKey instanceof Uint8Array)) {
    throw new Error('OriginalAccount decoded to something that is not bytes')
  }
  if (publicKey.length !== DESTINATION_BYTES) {
    throw new Error(
      `OriginalAccount decoded to ${publicKey.length} bytes, not ${DESTINATION_BYTES}`,
    )
  }
  let hex = '0x'
  for (const byte of publicKey) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/** True for a value that `payment.request` would accept as `destination`. */
export function isDestination(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value)
}
