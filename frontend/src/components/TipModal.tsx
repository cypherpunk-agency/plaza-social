import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { truncateAddress } from '../utils/formatters';
import {
  CASH_PRESETS,
  CASH_SYMBOL,
  formatCash,
  formatCashWithSymbol,
  parseCash,
} from '../lib/cash';
import type { PaymentsSeam } from '../lib/host/types';
import type { Signer } from '../utils/contracts';

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ⭐ TIPS ARE PAID IN CASH, BY THE HOST, FROM THE USER'S OWN BALANCE.
//
// What this replaced, and why every part of it was wrong:
//
//   · `ethers.parseEther(amount)` — 18 decimals. CASH has 6. Every amount was off by 10^12.
//   · `sessionWallet` = the DELEGATE key, as the payer. The delegate is never funded (`session.ts`
//     `authorizeDelegate` is a stub and no caller passes a top-up), so its balance was always `0n`
//     and EVERY tip died on "Insufficient balance in selected wallet". That is the real reason no
//     tip has ever succeeded — not the scale.
//   · `canTip={host.canWrite}` — posting ability, which has nothing whatever to do with funds.
//   · a native `sendTransaction` to the recipient's H160 — CASH cannot move that way at all. pUSD is
//     a PROTECTED asset: every value method on its ERC-20 precompile reverts with "Protected asset
//     access requires value-transfer authorization". ethers can never move it.
//
// `payments.sendTip` debits the USER through the host's own confirmation sheet. The delegate is not
// on this path at all, which is why the wallet picker is gone rather than reduced to one row.
//
// The `sessionWallet*` props below are kept ONLY so existing callers still compile. They are unused.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface TipModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The recipient's H160, as Plaza knows them. Resolved to a payable account before anything else. */
  recipientAddress: string;
  recipientName?: string;
  /**
   * The CASH seam. `null`/absent means this session cannot pay — the modal says so rather than
   * offering an amount field that could only fail.
   */
  payments?: PaymentsSeam | null;
  /** @deprecated Unused. The delegate key is not a payer; see the note above. */
  sessionWallet?: Signer | null;
  /** @deprecated Unused. */
  sessionWalletAddress?: string | null;
  /** @deprecated Unused. */
  sessionWalletBalance?: bigint;
  /** Opens the host notice when there is nothing to tip from. */
  onConnectWallet?: () => void;
}

/** Where the recipient lookup has got to. `unresolved` is a refusal, not an error. */
type Recipient =
  | { state: 'looking' }
  | { state: 'ready'; destination: string }
  | { state: 'unresolved' };

export function TipModal({
  isOpen,
  onClose,
  recipientAddress,
  recipientName,
  payments,
  onConnectWallet,
}: TipModalProps) {
  const [amount, setAmount] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** `null` is UNKNOWN, not zero. See `PaymentsSeam.subscribeBalance`. */
  const [balance, setBalance] = useState<bigint | null>(null);
  const [recipient, setRecipient] = useState<Recipient>({ state: 'looking' });

  /* -- balance: a subscription, torn down on close ---------------------------------------- */
  useEffect(() => {
    if (!isOpen || !payments) return;
    let live = true;
    const unsubscribe = payments.subscribeBalance((available) => {
      if (live) setBalance(available);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [isOpen, payments]);

  /* -- recipient: resolve BEFORE offering an amount field --------------------------------- */
  // Deliberately not lazy. Discovering that someone cannot be paid only after the user has chosen an
  // amount and pressed SEND wastes their effort and reads as a failure rather than as a fact about
  // the recipient.
  useEffect(() => {
    if (!isOpen || !payments) return;
    let live = true;
    setRecipient({ state: 'looking' });
    void payments.resolveRecipient(recipientAddress).then((destination) => {
      if (!live) return;
      setRecipient(destination ? { state: 'ready', destination } : { state: 'unresolved' });
    });
    return () => {
      live = false;
    };
  }, [isOpen, payments, recipientAddress]);

  /* -- reset between openings ------------------------------------------------------------- */
  useEffect(() => {
    if (!isOpen) {
      setAmount('');
      setError(null);
      setIsSending(false);
    }
  }, [isOpen]);

  const parsed = useMemo(() => (amount.trim() ? parseCash(amount) : null), [amount]);
  const overBalance = parsed?.ok === true && balance !== null && parsed.plancks > balance;
  const canSend =
    !!payments && recipient.state === 'ready' && parsed?.ok === true && !overBalance && !isSending;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSend || recipient.state !== 'ready' || parsed?.ok !== true || !payments) return;

    setError(null);
    setIsSending(true);
    const shown = formatCashWithSymbol(parsed.plancks);
    const who = recipientName || truncateAddress(recipientAddress);

    try {
      toast.loading(`Confirm ${shown} in the Polkadot app…`, { id: 'tip' });
      const outcome = await payments.sendTip(recipient.destination, parsed.plancks);

      // Four outcomes, four sentences. Collapsing them into "Failed to send tip" is what made the
      // old modal impossible to debug from a phone — and telling a user who simply changed their
      // mind that something broke is its own small insult.
      switch (outcome.status) {
        case 'sent':
          toast.success(`Sent ${shown} to ${who}`, { id: 'tip' });
          setAmount('');
          onClose();
          return;
        case 'rejected':
          toast.dismiss('tip');
          setError('You cancelled the payment. Nothing was sent.');
          return;
        case 'insufficient':
          toast.dismiss('tip');
          setError(`Not enough ${CASH_SYMBOL} to send ${shown}. Top up in the Polkadot app and try again.`);
          return;
        case 'failed':
          toast.error('Tip failed', { id: 'tip' });
          setError(outcome.reason);
          return;
      }
    } catch (err) {
      // `sendTip` is specified not to throw, so anything here is a bug rather than a payment result.
      // Say that plainly instead of implying the money might have moved.
      toast.error('Tip failed', { id: 'tip' });
      setError(err instanceof Error ? err.message : 'Something went wrong before the payment was sent.');
    } finally {
      setIsSending(false);
    }
  };

  const handleClose = () => {
    if (!isSending) onClose();
  };

  if (!isOpen) return null;

  /**
   * ⚠️ Falls back to the TRUNCATED ADDRESS, never to "Unknown User".
   *
   * `onTip(address)` carries only an address — the tooltip that knows the display name does not pass
   * it on — so `recipientName` is usually absent here. "Unknown User has never made a transaction"
   * reads as though we failed to identify somebody, when in fact we know exactly who they are and
   * are naming them the only way the caller allowed. On a screen that moves money, the address is
   * the identifier that matters anyway.
   */
  const who = recipientName || truncateAddress(recipientAddress);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/75" onClick={handleClose} />

      <div className="relative z-10 w-full max-w-sm mx-4 border-2 border-yellow-500 bg-black">
        <div className="border-b-2 border-yellow-500 px-6 py-4 flex items-center justify-between">
          <h2 className="text-xl font-bold text-yellow-500 font-mono">SEND TIP</h2>
          <button
            type="button"
            onClick={handleClose}
            disabled={isSending}
            aria-label="Close"
            className="text-yellow-500 hover:text-yellow-400 text-2xl font-mono disabled:opacity-50 transition-colors"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Recipient */}
          <div>
            <label className="block text-primary-600 font-mono text-xs mb-2">SENDING TO</label>
            <div className="p-3 border border-primary-700 bg-primary-950">
              {/* The address is the identifier that matters, so it is always shown. The name row
                  appears only when there IS a name — otherwise `who` is the truncated address and
                  this rendered the same string twice, which reads like a bug. */}
              {recipientName && (
                <div className="text-primary-300 font-mono text-sm">{recipientName}</div>
              )}
              <div
                className={`text-primary-600 font-mono text-xs ${recipientName ? 'mt-1' : ''}`}
              >
                {truncateAddress(recipientAddress)}
              </div>
            </div>
          </div>

          {/* No payment service at all — not in the app, or the app offers none. */}
          {!payments && (
            <div className="text-center py-4">
              <p className="text-primary-400 font-mono text-sm mb-4">
                Tipping pays in {CASH_SYMBOL} from your Polkadot app balance, so it only works inside
                the Polkadot app.
              </p>
              {onConnectWallet && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onConnectWallet();
                  }}
                  className="px-6 py-2 border-2 border-yellow-500 bg-yellow-950 text-yellow-500 font-mono text-sm hover:bg-yellow-900 transition-colors"
                >
                  WHY NOT?
                </button>
              )}
            </div>
          )}

          {payments && recipient.state === 'looking' && (
            <p className="text-primary-500 font-mono text-xs py-2">Checking whether {who} can be paid…</p>
          )}

          {/*
            ⛔ THE REFUSAL. This is the branch that protects the money.

            `requestPayment` needs a 32-byte account and Plaza only ever holds a 20-byte H160. The
            one sound reverse route is `Revive.OriginalAccount`, and it has no entry for this person.
            There IS a function that looks like the inverse — `h160ToSs58()` — and it is a trap: it
            builds the 0xEE-suffixed fallback account, a DIFFERENT account nobody holds a key for.
            Verified on chain: for a real Plaza writer the map gives 5EJ3VTQ… and the derivation
            gives 5CcnRhQ…. Tipping the second destroys the money, silently and permanently.

            So we refuse, and we explain, rather than guessing.
          */}
          {payments && recipient.state === 'unresolved' && (
            <div className="p-3 border border-yellow-700 bg-yellow-950/20 space-y-2">
              <p className="text-yellow-500 font-mono text-xs font-bold">CAN'T BE PAID YET</p>
              <p className="text-primary-300 font-mono text-xs leading-relaxed">
                {who} has never made a transaction from their Polkadot account, so this chain has no
                record of which account their address belongs to — and there is nowhere to send the{' '}
                {CASH_SYMBOL} to.
              </p>
              <p className="text-primary-500 font-mono text-xs leading-relaxed">
                Once they post or sign anything from the Polkadot app, tipping them will work. Plaza
                will not guess an address: a guessed one would send your {CASH_SYMBOL} to an account
                nobody can ever spend from.
              </p>
            </div>
          )}

          {payments && recipient.state === 'ready' && (
            <>
              {/* Balance. "Unknown" is a real state and must not render as zero. */}
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="text-primary-600">YOUR BALANCE</span>
                {balance === null ? (
                  <span className="text-primary-500" title="The Polkadot app did not share your balance">
                    unknown
                  </span>
                ) : (
                  <span className="text-primary-400">{formatCashWithSymbol(balance)}</span>
                )}
              </div>

              {/* Presets — a tip is a gesture, and typing is the slow way to make one. */}
              <div className="flex gap-2">
                {CASH_PRESETS.map((preset) => (
                  <button
                    key={String(preset)}
                    type="button"
                    onClick={() => setAmount(formatCash(preset))}
                    disabled={isSending}
                    className="flex-1 py-2 border border-yellow-700 text-yellow-500 font-mono text-xs hover:border-yellow-500 hover:bg-yellow-950 transition-colors disabled:opacity-50"
                  >
                    {formatCash(preset)}
                  </button>
                ))}
              </div>

              <div>
                <label htmlFor="tip-amount" className="block text-primary-600 font-mono text-xs mb-2">
                  AMOUNT
                </label>
                <div className="relative">
                  <input
                    id="tip-amount"
                    type="text"
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => {
                      setAmount(e.target.value);
                      setError(null);
                    }}
                    placeholder="0.00"
                    disabled={isSending}
                    aria-describedby="tip-amount-hint"
                    className="w-full bg-black border-2 border-yellow-700 px-4 py-3 text-yellow-400 font-mono text-sm placeholder-yellow-900 focus:border-yellow-500 disabled:opacity-50 text-right pr-20"
                  />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-yellow-600 font-mono text-sm pointer-events-none">
                    {CASH_SYMBOL}
                  </span>
                </div>

                {/* Validation speaks while typing, and says which rule was broken. */}
                <p id="tip-amount-hint" className="mt-2 font-mono text-xs">
                  {parsed?.ok === false ? (
                    <span className="text-red-400">{parsed.message}</span>
                  ) : overBalance ? (
                    <span className="text-red-400">
                      That is more {CASH_SYMBOL} than you have.
                    </span>
                  ) : (
                    <span className="text-primary-600">
                      {CASH_SYMBOL} is spendable in whole cents.
                    </span>
                  )}
                </p>
              </div>
            </>
          )}

          {error && (
            <div className="p-3 border border-red-500 bg-red-950/20">
              <p className="text-red-400 font-mono text-sm">{error}</p>
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={handleClose}
              disabled={isSending}
              className="flex-1 py-3 border-2 border-gray-600 text-gray-400 font-mono text-sm hover:border-gray-500 transition-colors disabled:opacity-50"
            >
              {recipient.state === 'unresolved' ? 'CLOSE' : 'CANCEL'}
            </button>
            {recipient.state !== 'unresolved' && (
              <button
                type="submit"
                disabled={!canSend}
                className="flex-1 py-3 border-2 border-yellow-500 bg-yellow-950 text-yellow-500 font-mono text-sm hover:bg-yellow-900 transition-colors disabled:opacity-50"
              >
                {isSending ? 'CONFIRM IN APP…' : 'SEND TIP'}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
