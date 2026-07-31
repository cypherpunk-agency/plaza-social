// Who gets the money, and in what shape.
//
// These tests exist because both failure modes here are silent and expensive. A destination that is
// the wrong LENGTH is rejected by the host with something unreadable; a destination that is the
// wrong ACCOUNT is accepted, settles, and the CASH is gone. So the assertions below are deliberately
// about refusing rather than about coping.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DESTINATION_BYTES,
  destinationFromPublicKey,
  isDestination,
  normaliseH160,
} from './recipient.ts'

/**
 * ⭐ THE ONE MEASURED MAPPING, and the anchor for every claim in this file.
 *
 * H160 `0x18773c30…4ef9` is the account that actually posted the first Plaza threads.
 * `Revive.OriginalAccount` maps it to SS58 `5EJ3VTQ…`, which decodes to these 32 bytes. Both the old
 * raw `state_getStorage` read and the new typed read + `ss58Decode` produce this exact value —
 * confirmed locally against `@parity/product-sdk-address` — which is what makes them interchangeable
 * and the switch safe.
 *
 * ⛔ The DERIVED account for the same H160 is `5CcnRhQ…`, a completely different account. Nothing in
 * this module may ever produce it. Reproduce: `node contracts/scripts/probe-tipping.mjs`.
 */
const REAL_H160 = '0x18773c30d65de35027ac8cd19e98c0ddb9c44ef9'
const REAL_DESTINATION = '0x62a4c0821686da4fe20ba29ceaf2a21aa404f0deddbafbb79dcd1c0b09903d2f'
const REAL_PUBLIC_KEY = Uint8Array.from(
  (REAL_DESTINATION.slice(2).match(/../g) ?? []).map((pair) => parseInt(pair, 16)),
)

/* ------------------------------------------------------------- normaliseH160 -- */

test('a well-formed H160 passes through, lowercased', () => {
  assert.equal(normaliseH160(REAL_H160), REAL_H160)
  assert.equal(normaliseH160(REAL_H160.toUpperCase().replace('0X', '0x')), REAL_H160)
  assert.equal(normaliseH160(`  ${REAL_H160}  `), REAL_H160)
})

test('a checksummed address and its lowercase form are the SAME key', () => {
  // They index the same 20 raw bytes on chain. If these disagreed, the same person would resolve
  // for one call site and not for another, which reads as "tipping is flaky".
  const checksummed = '0x18773C30d65DE35027Ac8cD19e98C0DDb9C44Ef9'
  assert.equal(normaliseH160(checksummed), normaliseH160(REAL_H160))
})

test('⛔ nothing that is not exactly 20 bytes is repaired into an address', () => {
  for (const bad of [
    '',
    '0x',
    '0x18773c30d65de35027ac8cd19e98c0ddb9c44ef', // 19 bytes
    '0x18773c30d65de35027ac8cd19e98c0ddb9c44ef9a', // 21 bytes
    '18773c30d65de35027ac8cd19e98c0ddb9c44ef9', // no 0x
    '0x18773c30…44ef9', // the truncated DISPLAY form, which is what a careless caller passes
    REAL_DESTINATION, // a 32-byte account, i.e. the OUTPUT of a resolution, not its input
    '5EJ3VTQLFVGHh2nrwpD9VyAFhYhhKnHxRTfGsGifFS4sx2rz', // SS58
    '0xZZ773c30d65de35027ac8cd19e98c0ddb9c44ef9', // non-hex
  ]) {
    assert.equal(normaliseH160(bad), null, `expected ${JSON.stringify(bad)} to be rejected`)
  }
})

test('a non-string is rejected rather than coerced', () => {
  assert.equal(normaliseH160(null), null)
  assert.equal(normaliseH160(undefined), null)
})

/* --------------------------------------------------- destinationFromPublicKey -- */

test('32 decoded bytes become the exact destination the host takes', () => {
  assert.equal(DESTINATION_BYTES, 32)
  assert.equal(destinationFromPublicKey(REAL_PUBLIC_KEY), REAL_DESTINATION)
})

test('leading zero bytes are padded, not dropped', () => {
  // `toString(16)` on 0x00 gives "0", so a missing `padStart` would shorten the whole string and
  // shift every later byte — producing a valid-looking hex string for a different account.
  const withZeros = new Uint8Array(32)
  withZeros[31] = 1
  assert.equal(destinationFromPublicKey(withZeros), `0x${'00'.repeat(31)}01`)
  assert.equal(destinationFromPublicKey(withZeros).length, 66)
})

test('every byte value round-trips', () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, i) => (i * 8) % 256)
  const hex = destinationFromPublicKey(bytes)
  const back = Uint8Array.from((hex.slice(2).match(/../g) ?? []).map((p) => parseInt(p, 16)))
  assert.deepEqual(back, bytes)
})

test('⛔ a wrong-length decode THROWS rather than being padded or truncated', () => {
  for (const length of [0, 20, 31, 33, 64]) {
    assert.throws(
      () => destinationFromPublicKey(new Uint8Array(length)),
      /not 32/,
      `expected ${length} bytes to be refused`,
    )
  }
})

test('⛔ a 20-byte H160 can never masquerade as a destination', () => {
  // This is the shape the forbidden derivation would produce something from. It must not be
  // possible to hand `payment.request` an H160 by accident.
  const h160Bytes = Uint8Array.from(
    (REAL_H160.slice(2).match(/../g) ?? []).map((p) => parseInt(p, 16)),
  )
  assert.equal(h160Bytes.length, 20)
  assert.throws(() => destinationFromPublicKey(h160Bytes), /not 32/)
})

test('non-bytes input throws', () => {
  assert.throws(
    () => destinationFromPublicKey('0x1234' as unknown as Uint8Array),
    /not bytes/,
  )
})

/* --------------------------------------------------------------- isDestination -- */

test('isDestination accepts only 32-byte lowercase hex', () => {
  assert.equal(isDestination(REAL_DESTINATION), true)
  assert.equal(isDestination(REAL_H160), false)
  assert.equal(isDestination(REAL_DESTINATION.toUpperCase()), false)
  assert.equal(isDestination(`${REAL_DESTINATION}00`), false)
  assert.equal(isDestination(REAL_DESTINATION.slice(0, -2)), false)
  assert.equal(isDestination(null), false)
  assert.equal(isDestination(undefined), false)
  assert.equal(isDestination(42), false)
})

test('the fake backend’s pretend mapping is a real, well-formed destination', () => {
  // `lib/host/fake.ts` hard-codes this pair. If it ever stops being a valid destination the fake
  // stops exercising the branch it exists for, and it does so quietly.
  assert.equal(normaliseH160(REAL_H160), REAL_H160)
  assert.equal(isDestination(REAL_DESTINATION), true)
})
