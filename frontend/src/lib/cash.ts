// CASH — amounts, and nothing else. Pure functions, no SDK, no React, no chain.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ⭐ WHAT CASH IS, because the layering is genuinely confusing and we got it wrong once.
//
//   CASH    the Coinage bearer-coin system on the People chain. What a user holds and what the
//           Polkadot app's "CASH card" shows.
//   purse   where the host keeps it. BOTH TruAPI money APIs are keyed on a `CoinPaymentPurseId`.
//   pUSD    the DENOMINATION. `Coinage.UnderlyingAssetId` is an XCM Location pointing at Asset Hub
//           local asset 50000413 ("People USD" / pUSD), and that asset declares 6 decimals.
//
// So an RFC-0006 `payment.requestPayment` amount is NOT "pUSD instead of CASH" — it is CASH, quoted
// in the base units of the asset that denominates it. `HostPaymentRequest.from` and
// `HostPaymentBalanceSubscribeRequest.purse` are both `CoinPaymentPurseId`, which is the proof: the
// account-addressed API spends the very same purse the bearer API does.
//
// ⛔ DO NOT "CORRECT" THIS BACK to some other asset. See `lib/host/types.ts` `PaymentsSeam` for why
// the bearer surface (`coinPayment.*`) cannot express a tip.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// ⚠️ THE ONE NUMBER THAT MUST NOT BE WRONG: 6.
//
// There are TWO money types in the same SDK and they are 10^4 apart:
//
//   RFC-0006  `Balance = u128`            base units of the payment asset  →  1 CASH = 1_000_000
//   RFC-0017  `CoinPaymentBalance = u32`  dotUSD CENTS, exponent 2         →  1 CASH =         100
//
// We use the first. Four independent confirmations, three of them reproducible from this repo:
//
//   1. Asset Hub `Assets.Metadata(50000413)` = {name "People USD", symbol "pUSD", decimals 6}.
//      Reproduce: `node contracts/scripts/probe-tipping.mjs`.
//   2. People chain `Assets.Metadata` for the same asset's XCM location: symbol pUSD, decimals 6.
//   3. pUSD's ERC-20 precompile answers `decimals()` = 6 (its VALUE methods all revert — see below).
//   4. ⭐ Parity's own reference app, against the real host — `paritytech/w3spay`
//      `src/features/payment/api/send-payment.ts`:
//          const plancks = BigInt(input.amountCents) * PLANCKS_PER_CENT;
//          const receipt = await manager.requestPayment(plancks, destinationBytes);
//      with `PLANCKS_PER_CENT = 10^(decimals - displayDecimals) = 10^(6-2) = 10_000` and the comment
//      "the host API carries plancks; the UI works in cents". That settles the UNIT, not just the
//      asset's decimals — RFC-0006 itself only says "interpreted according to that asset's decimals"
//      and never names the unit.
//
// (`w3spay`'s comment misattributes `paymentRequest` to "RFC 0017". It is RFC-0006. The code is
// right and the label is wrong; do not follow the label to the cents encoding.)

/** Base-10 exponent of one CASH. `1 CASH = 10n ** 6n` base units. */
export const CASH_DECIMALS = 6

/** What a person calls it. The chain calls the denomination "pUSD"; users never see that word. */
export const CASH_SYMBOL = 'CASH'

/** `10n ** 6n`, precomputed. */
export const CASH_UNIT = 10n ** BigInt(CASH_DECIMALS)

/**
 * ⭐ THE SMALLEST SPENDABLE AMOUNT — one cent, `10_000` base units. NOT one base unit.
 *
 * This is a property of Coinage, not a UI preference. A CASH balance is a set of BEARER COINS whose
 * denominations are quantised: `pallet-coinage` defines
 *
 *     value = 2^CoinValue * UnderlyingAssetUnit
 *
 * and the People-Paseo runtime sets `UnderlyingAssetUnit = 10^4` (= $0.01) with
 * `MinimumExponent = 0`, `MaximumExponent = 14`. So the legal denominations are exactly
 * $0.01, $0.02, $0.04 … $163.84, and **nothing smaller than a cent exists**.
 *
 * Confirmed live: `Coinage.CoinsByOwner` on `wss://people-paseo.rotko.net` holds 613 entries, each
 * keyed by a single AccountId32 (one coin per account) with values `{value: 2..8, age: 1..4}`.
 *
 * An amount that is not a whole number of cents cannot be assembled from coins, so we refuse it
 * here rather than letting the host reject it later with something unreadable — or, worse, round it.
 * Parity's own app takes the same line: its UI works entirely in integer cents.
 */
export const CASH_CENT = 10_000n

/**
 * How many decimals to SHOW. Two, like a currency — the reference app does the same.
 * Display precision is deliberately not `CASH_DECIMALS`: "0.500000 CASH" reads like a bug.
 */
export const CASH_DISPLAY_DECIMALS = 2

/** Offered amounts, in base units. A tip is a gesture, so these are small and round. */
export const CASH_PRESETS: readonly bigint[] = [
  CASH_UNIT / 10n, // 0.10
  CASH_UNIT / 2n, // 0.50
  CASH_UNIT, // 1.00
  CASH_UNIT * 5n, // 5.00
]

/** Everything `parseCash` can object to. The UI turns each into its own sentence. */
export type CashParseError =
  | 'empty'
  | 'not-a-number'
  | 'negative'
  | 'zero'
  /** Finer than one cent — not representable as Coinage coins. See `CASH_CENT`. */
  | 'too-precise'

export interface CashParseFailure {
  ok: false
  error: CashParseError
  /** One sentence, already written for a person. */
  message: string
}
export interface CashParseSuccess {
  ok: true
  /** Base units — exactly what `requestPayment(amount, …)` takes. */
  plancks: bigint
}
export type CashParseResult = CashParseSuccess | CashParseFailure

/**
 * Parse a typed CASH amount into base units.
 *
 * ⚠️ RETURNS A RESULT, NEVER THROWS, AND NEVER ROUNDS.
 *
 * `ethers.parseEther` — which this replaces — is wrong here twice over: it assumes 18 decimals (a
 * 10^12 error against CASH's 6) and it throws on malformed input, so the amount field could not
 * distinguish "still typing" from "invalid".
 *
 * ⛔ MORE PRECISION THAN CASH HAS IS AN ERROR, NOT SOMETHING TO TRUNCATE. `0.0000001` silently
 * becoming `0` — or, worse, becoming `0.000000` of a DIFFERENT amount than the user read back — is
 * exactly the class of bug this whole module exists to prevent. Say no instead.
 */
export function parseCash(input: string): CashParseResult {
  const text = input.trim()
  if (!text) return fail('empty', 'Enter an amount.')

  // Deliberately strict: no exponent form, no thousands separators, no leading `+`, no hex. A money
  // field that accepts `1e3` accepts a typo that is a thousand times the intended tip.
  if (!/^-?\d*\.?\d*$/.test(text) || text === '.' || text === '-') {
    return fail('not-a-number', `That is not an amount. Use digits, like 1.50.`)
  }
  if (text.startsWith('-')) return fail('negative', 'An amount must be greater than zero.')

  const [whole, fraction = ''] = text.split('.')

  // ⛔ Two decimal places, not six. `CASH_DECIMALS` is the WIRE scale — the exponent the host's
  // `amount` is quoted in — while `CASH_CENT` is the smallest amount that can actually EXIST as a
  // coin. Validating against the wire scale would happily accept 0.000001 and hand the host an
  // amount it cannot assemble.
  if (fraction.length > 2) {
    return fail('too-precise', `${CASH_SYMBOL} is spendable in whole cents. Enter at most 2 decimal places.`)
  }

  const plancks =
    BigInt(whole || '0') * CASH_UNIT + BigInt((fraction || '0').padEnd(CASH_DECIMALS, '0'))

  if (plancks === 0n) return fail('zero', 'An amount must be greater than zero.')
  // Belt and braces: the fraction-length check above already implies this, but the invariant that
  // leaves this function is "a whole number of cents", and it should be enforced where it is stated.
  if (plancks % CASH_CENT !== 0n) {
    return fail('too-precise', `${CASH_SYMBOL} is spendable in whole cents. Enter at most 2 decimal places.`)
  }
  return { ok: true, plancks }
}

function fail(error: CashParseError, message: string): CashParseFailure {
  return { ok: false, error, message }
}

/**
 * Render base units as a human amount.
 *
 * Truncates rather than rounds, and that is the correct direction for a BALANCE: rounding 0.999 up
 * to "1.00" invites a user to try to spend one CASH they do not have, and the refusal then looks
 * like a bug in us rather than arithmetic.
 */
export function formatCash(plancks: bigint, displayDecimals = CASH_DISPLAY_DECIMALS): string {
  const negative = plancks < 0n
  const value = negative ? -plancks : plancks
  const whole = value / CASH_UNIT
  const fraction = (value % CASH_UNIT).toString().padStart(CASH_DECIMALS, '0')
  const shown = displayDecimals > 0 ? `.${fraction.slice(0, displayDecimals)}` : ''
  return `${negative ? '-' : ''}${whole}${shown}`
}

/** `formatCash` plus the ticker, for anywhere a bare number would be ambiguous. */
export function formatCashWithSymbol(plancks: bigint, displayDecimals = CASH_DISPLAY_DECIMALS): string {
  return `${formatCash(plancks, displayDecimals)} ${CASH_SYMBOL}`
}
