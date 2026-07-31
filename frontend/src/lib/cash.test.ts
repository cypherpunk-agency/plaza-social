// The scale is the whole point of these tests.
//
// A 10^12 error in a money field is silent: every number still renders, the UI still looks right,
// and the user is billed a million million times what they read. So the first test here pins the
// exact base-unit value of one CASH, and several others pin the boundary between "wire scale"
// (6 decimals) and "smallest spendable amount" (one cent = 10_000 base units) — the two constants
// that are easiest to confuse and worst to confuse.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CASH_CENT,
  CASH_DECIMALS,
  CASH_PRESETS,
  CASH_SYMBOL,
  CASH_UNIT,
  formatCash,
  formatCashWithSymbol,
  parseCash,
} from './cash.ts'

const ok = (input: string): bigint => {
  const result = parseCash(input)
  assert.equal(result.ok, true, `expected ${JSON.stringify(input)} to parse`)
  return (result as { ok: true; plancks: bigint }).plancks
}
const err = (input: string): string => {
  const result = parseCash(input)
  assert.equal(result.ok, false, `expected ${JSON.stringify(input)} to be rejected`)
  return (result as { ok: false; error: string }).error
}

/* ---------------------------------------------------------------- constants -- */

test('one CASH is exactly 1_000_000 base units', () => {
  // ⚠️ If this fails, DO NOT update the expectation to match the code. Re-verify against
  // `Assets.Metadata(50000413)` (node contracts/scripts/probe-tipping.mjs) first — the constant is
  // the claim, and the chain is the authority.
  assert.equal(CASH_DECIMALS, 6)
  assert.equal(CASH_UNIT, 1_000_000n)
})

test('one cent is 10_000 base units — the Coinage UnderlyingAssetUnit', () => {
  assert.equal(CASH_CENT, 10_000n)
  assert.equal(CASH_UNIT / CASH_CENT, 100n, 'there must be exactly 100 cents in one CASH')
})

test('every preset is a whole number of cents and parses back to itself', () => {
  for (const preset of CASH_PRESETS) {
    assert.equal(preset % CASH_CENT, 0n, `preset ${preset} is not a whole number of cents`)
    assert.equal(ok(formatCash(preset)), preset, `preset ${preset} did not survive a format/parse round trip`)
  }
})

/* -------------------------------------------------------------------- parse -- */

test('parses whole and fractional amounts at the correct scale', () => {
  assert.equal(ok('1'), 1_000_000n)
  assert.equal(ok('1.00'), 1_000_000n)
  assert.equal(ok('0.5'), 500_000n)
  assert.equal(ok('0.01'), 10_000n)
  assert.equal(ok('12.34'), 12_340_000n)
  assert.equal(ok('.5'), 500_000n)
  assert.equal(ok('  2.50  '), 2_500_000n)
})

test('the smallest accepted amount is one cent', () => {
  assert.equal(ok('0.01'), CASH_CENT)
  assert.equal(err('0.001'), 'too-precise')
})

test('REFUSES sub-cent precision rather than truncating it', () => {
  // Truncation here would be the dangerous behaviour: the user reads back an amount that is not the
  // amount sent. Refusal is the only safe answer.
  for (const input of ['0.001', '0.0001', '1.234', '0.000001', '1.005']) {
    assert.equal(err(input), 'too-precise', `${input} should have been refused`)
  }
})

test('rejects zero, negatives and empty input distinctly', () => {
  assert.equal(err(''), 'empty')
  assert.equal(err('   '), 'empty')
  assert.equal(err('0'), 'zero')
  assert.equal(err('0.00'), 'zero')
  assert.equal(err('-1'), 'negative')
})

test('rejects anything that is not a plain decimal number', () => {
  // `1e3` is the one that matters: it is a plausible typo worth a thousand times the intended tip.
  for (const input of ['1e3', '1,50', 'abc', '0x10', '1.2.3', '.', '-', '1 000', '+1', 'Infinity']) {
    assert.equal(err(input), 'not-a-number', `${input} should have been refused as not-a-number`)
  }
})

test('handles amounts far larger than any realistic tip without precision loss', () => {
  // bigint throughout, so this is exact where a float would not be.
  assert.equal(ok('9007199254740993'), 9_007_199_254_740_993n * CASH_UNIT)
})

/* ------------------------------------------------------------------- format -- */

test('formats base units to two decimal places by default', () => {
  assert.equal(formatCash(0n), '0.00')
  assert.equal(formatCash(10_000n), '0.01')
  assert.equal(formatCash(500_000n), '0.50')
  assert.equal(formatCash(1_000_000n), '1.00')
  assert.equal(formatCash(12_340_000n), '12.34')
})

test('formatCash TRUNCATES toward zero rather than rounding', () => {
  // Rounding a balance up invites the user to spend money they do not have, and our refusal then
  // looks like our bug rather than arithmetic.
  assert.equal(formatCash(999_999n), '0.99')
  assert.equal(formatCash(1_999_999n), '1.99')
})

test('formatCash honours a requested precision, including zero', () => {
  assert.equal(formatCash(1_234_567n, 6), '1.234567')
  assert.equal(formatCash(1_234_567n, 0), '1')
})

test('negative balances render with a single leading minus', () => {
  // Not expected from the host, but a formatter that renders "-" as "0.00" would hide a real bug.
  assert.equal(formatCash(-1_500_000n), '-1.50')
})

test('formatCashWithSymbol labels the amount CASH, never pUSD', () => {
  assert.equal(CASH_SYMBOL, 'CASH')
  assert.equal(formatCashWithSymbol(2_500_000n), '2.50 CASH')
})

/* ---------------------------------------------------------------- round trip -- */

test('format then parse is the identity for whole-cent amounts', () => {
  for (const plancks of [10_000n, 500_000n, 1_000_000n, 12_340_000n, 163_840_000n]) {
    assert.equal(ok(formatCash(plancks)), plancks)
  }
})

/* ------------------------------------------------- the two money units, pinned -- */

test('⭐ the RFC-0006 ↔ RFC-0017 factor is exactly 10^4, and we are on the LEFT of it', () => {
  // TWO money types live in the same SDK, 10^4 apart, and this is the conversion Parity's own
  // reference app performs:
  //
  //   RFC-0006  `Balance = u128`            base units  → what `payment.request(amount, …)` takes
  //   RFC-0017  `CoinPaymentBalance = u32`  CENTS       → what `coinPayment.createCheque` takes
  //
  //   w3spay: `const plancks = BigInt(input.amountCents) * PLANCKS_PER_CENT` with
  //           `PLANCKS_PER_CENT = 10^(6-2) = 10_000`.
  //
  // ⛔ `parseCash` returns the LEFT-HAND unit — plancks — because `sendTip` calls `payment.request`.
  // If anything ever routes an amount into a `coinPayment` method it must DIVIDE by this factor, and
  // the divide must be exact. Handing cents to `payment.request` undercharges by 10_000×; handing
  // plancks to a cents field overflows a u32 at ~429 CASH and truncates below that.
  const PLANCKS_PER_CENT = CASH_CENT
  assert.equal(PLANCKS_PER_CENT, 10n ** BigInt(CASH_DECIMALS - 2))
  assert.equal(PLANCKS_PER_CENT, 10_000n)

  for (const [text, cents] of [
    ['0.01', 1n],
    ['0.10', 10n],
    ['1.00', 100n],
    ['5.00', 500n],
    ['163.84', 16_384n],
  ] as const) {
    const plancks = ok(text)
    assert.equal(plancks % PLANCKS_PER_CENT, 0n, `${text} is not a whole number of cents`)
    assert.equal(plancks / PLANCKS_PER_CENT, cents)
    assert.equal(plancks, cents * PLANCKS_PER_CENT)
  }
})

test('every parsed amount is expressible as a u32 count of cents at realistic sizes', () => {
  // `CoinPaymentBalance` is a u32 of cents, so the cents form of anything a person would type must
  // fit. This is not a limit we impose — it is the one the other unit has — and it is here so that a
  // future `coinPayment` path cannot silently wrap.
  const U32_MAX = 4_294_967_295n
  for (const text of ['0.01', '1.00', '5.00', '9999.99']) {
    assert.ok(ok(text) / CASH_CENT <= U32_MAX, `${text} overflows a u32 of cents`)
  }
})
