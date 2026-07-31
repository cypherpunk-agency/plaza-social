// The CASH seam, made reachable from anywhere that renders a person.
//
// ⭐ WHY A CONTEXT AND NOT A PROP. `canTip` and `onTip` are already drilled through nine components
// (ForumView → ThreadCard → UserLink → ProfileTooltip, and the same again down the profile feed) and
// adding a tenth prop to that chain would mean editing every one of them to move one session-wide
// value. The seam is created ONCE per session by `useHostSession`; it is not per-card data, and
// threading it like per-card data is what made the balance chip impossible to fix.
//
// ⛔ DO NOT CALL `useHostSession()` FROM A LEAF COMPONENT INSTEAD. That hook opens a backend per
// mount — one hover card would open a second container session and double every permission round
// trip. There is exactly one backend, and this is how the rest of the tree borrows its payment seam.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

import type { PaymentsSeam } from '../lib/host/types'

const PaymentsContext = createContext<PaymentsSeam | null>(null)

export function PaymentsProvider({
  payments,
  children,
}: {
  payments: PaymentsSeam | null
  children: ReactNode
}) {
  return <PaymentsContext.Provider value={payments}>{children}</PaymentsContext.Provider>
}

/** The session's CASH seam, or `null` when this session cannot pay at all. */
export function usePayments(): PaymentsSeam | null {
  return useContext(PaymentsContext)
}

/**
 * The SIGNED-IN USER'S OWN spendable CASH balance, in base units.
 *
 * ⚠️ `null` MEANS UNKNOWN AND IS NOT ZERO — it is the value before the first push arrives, the value
 * when the host declines to disclose the balance, and the value when there is no payment seam. All
 * three are "we do not know", and rendering any of them as `0.00 CASH` tells a funded user they are
 * broke. See `PaymentsSeam.subscribeBalance`.
 *
 * ⛔ THERE IS NO EQUIVALENT FOR SOMEBODY ELSE'S BALANCE, and that is a property of the API rather
 * than a gap here: `HostPaymentBalanceSubscribeRequest` is `{ purse?: CoinPaymentPurseId }` — a
 * selector among the CALLER'S OWN purses — and there is no account parameter anywhere on
 * `truApi.payment.*`. `coinPayment.queryPurse` is the same story one layer down. So a card for
 * another user must say "not visible", never a number and never zero.
 *
 * @param enabled pass `false` to skip the subscription entirely (e.g. a closed modal).
 */
export function useOwnCashBalance(enabled = true): bigint | null {
  const payments = usePayments()
  const [balance, setBalance] = useState<bigint | null>(null)

  useEffect(() => {
    if (!enabled || !payments) return
    let live = true
    const unsubscribe = payments.subscribeBalance((available) => {
      if (live) setBalance(available)
    })
    return () => {
      live = false
      unsubscribe()
    }
  }, [enabled, payments])

  // Disabled is reported as UNKNOWN by derivation rather than by resetting state inside the effect.
  // The stored value is only ever OUR OWN balance — the same number whichever card is being drawn —
  // so there is nothing here that could leak from one person's card to another's.
  return enabled && payments ? balance : null
}
