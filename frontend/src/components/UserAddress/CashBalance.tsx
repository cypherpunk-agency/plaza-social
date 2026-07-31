import { CASH_SYMBOL, formatCashWithSymbol } from '../../lib/cash';

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ⭐ ONE COMPONENT FOR EVERY PLACE A BALANCE APPEARS NEXT TO A PERSON.
//
// It replaced `{formatBalance(balance)} PAS` in the hover card, the profile page and the profile
// modal. PAS was wrong in two separate ways and the second is the interesting one:
//
//   1. PAS is the GAS token. Plaza's money is CASH, and a tip is denominated in CASH, so a PAS
//      figure next to a TIP button invited the reader to compare two different currencies.
//   2. `provider.getBalance(addr).catch(() => 0n)` rendered a FAILED READ as `0.0000 PAS`. Whatever
//      number sits here, it must never be one we made up when we did not know.
//
// ⛔ AND WE CANNOT KNOW SOMEBODY ELSE'S CASH BALANCE. That is the host API, not a missing feature:
// `truApi.payment.balanceSubscribe` takes `{ purse?: CoinPaymentPurseId }` — a selector among the
// CALLER'S own purses — and no method in either money domain accepts an account. So the honest set
// of states is exactly three, and two of them are not numbers.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export type CashBalanceState =
  /** We asked, and this is the answer. `0n` is a legitimate value here and renders as `0.00`. */
  | { kind: 'known'; plancks: bigint }
  /** Ours to know, but not known yet or not disclosed. */
  | { kind: 'unknown' }
  /** Somebody else's. Unknowable by design — see above. */
  | { kind: 'private' };

/** `null` → `unknown`, a bigint → `known`. The seam's own convention, kept in one place. */
export function ownCashBalanceState(plancks: bigint | null): CashBalanceState {
  return plancks === null ? { kind: 'unknown' } : { kind: 'known', plancks };
}

interface CashBalanceProps {
  state: CashBalanceState;
  className?: string;
}

export function CashBalance({ state, className = '' }: CashBalanceProps) {
  if (state.kind === 'known') {
    return (
      <span className={`font-mono whitespace-nowrap ${className}`}>
        {formatCashWithSymbol(state.plancks)}
      </span>
    );
  }

  // ⛔ An em dash, never `0.00`. The title carries the reason, and the two reasons are different
  // enough that collapsing them would be its own small lie.
  const title =
    state.kind === 'unknown'
      ? `The Polkadot app has not shared your ${CASH_SYMBOL} balance.`
      : `Only your own ${CASH_SYMBOL} balance is visible — the Polkadot app does not disclose anyone else's.`;

  return (
    <span className={`font-mono whitespace-nowrap opacity-70 ${className}`} title={title}>
      — {CASH_SYMBOL}
    </span>
  );
}
