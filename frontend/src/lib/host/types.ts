// The host-container seam, as types. NOTHING in this file imports the Products SDK, ethers, or
// React — it is the contract that the real backend (`session.ts`) and the fake backend (`fake.ts`)
// both satisfy, and that the React binding (`hooks/useHostSession.ts`) consumes.
//
// Read `docs/products-platform/architecture.md` §1, §1a and §5 before changing anything here. The
// shape of `Capabilities` in particular is a direct consequence of §5's prompt table and is not
// arbitrary.

import type { ethers } from 'ethers'

/* ============================================================ diagnostics == */

export type DiagnosticStatus = 'running' | 'ok' | 'fail' | 'skip'

export interface DiagnosticStep {
  id: string
  label: string
  status: DiagnosticStatus
  detail: string
}

/**
 * An ordered record of what session setup actually did.
 *
 * This is not logging for its own sake. The write path only runs inside a Polkadot host container,
 * which means it only runs on a phone, which means when it breaks it breaks where no console can be
 * attached. This record is the whole of our observability.
 */
export interface Diagnostics {
  step: (id: string, status: DiagnosticStatus, detail?: string) => void
  get: (id: string) => DiagnosticStep | null
  list: () => DiagnosticStep[]
  hasFailure: () => boolean
  reset: () => void
  subscribe: (listener: (steps: DiagnosticStep[]) => void) => () => void
}

/* =========================================================== capabilities == */

/**
 * What this session can do, in the only four terms the UI ever needs.
 *
 * ⚠️ `canWrite` AND `canPushLive` ARE SEPARATE AND MUST STAY SEPARATE.
 *
 * An account can legitimately have `canWrite && !canPushLive`, and that combination is the COMMON
 * case rather than an edge case: writing content needs a Bulletin authorization, which is granted
 * by an authorizer and needs no personhood proof, while announcing it live needs a statement-store
 * allowance, which is minted from a personhood proof. Two different mechanisms, two different
 * gates, and they come apart. (Established in yolodot's own measurements: their deploy account has
 * `personhoodStatus() == 0` and has written to Bulletin repeatedly.)
 *
 * ⛔ NEVER GATE THE COMPOSER ON `canPushLive`. A user with no personhood proof can still post; what
 * they lose is instant propagation, replaced by polling. Disabling the composer for them would
 * remove the feature entirely for the majority of accounts in order to hide a latency difference.
 * If you find a `disabled={!canPushLive}` anywhere, it is a bug.
 */
export interface Capabilities {
  /** Reads never need a wallet, a container, or a signer. Effectively always true. */
  canRead: boolean
  /** Can store content and move a head pointer. Depends on the Bulletin path alone. */
  canWrite: boolean
  /** Can announce a write so it appears instantly for others. Personhood-gated; NOT required to write. */
  canPushLive: boolean
  /** The product account, when there is one. `null` means an anonymous reader. */
  address: string | null
  /**
   * Are we running inside the Polkadot host container?
   *
   * ⚠️ EXISTS SO THE UI CANNOT TELL A USER INSIDE THE APP TO "OPEN THIS IN THE APP". It did exactly
   * that on a real phone: every step green except the Bulletin chain, and the panel still read
   * "POSTING NEEDS THE POLKADOT APP · open Plaza from inside the Polkadot app on your phone".
   * `canWrite === false` has two completely different causes — not in the app at all, versus in the
   * app with something broken — and advice for one is nonsense for the other. Do not infer this from
   * the `label` string.
   */
  insideHost: boolean
  /** Why `canWrite` is false, in a sentence written for a person. Undefined when it is true. */
  reason?: string
  /** Why `canPushLive` is false. Undefined when it is true. Never a reason to block a write. */
  liveReason?: string
}

/* ============================================================= delegation == */

/**
 * The local posting key's state. `null` when there is no writer at all — a panel offering to set up
 * a posting key for someone who cannot post is a control that can only fail.
 */
export interface DelegationState {
  /** Has a key been derived? False outside a container, or if `deriveEntropy` refused. */
  derived: boolean
  /** The delegate's 0x address, for `authorizeDelegate` and for display. */
  address: string | null
  /** Unix ms, or null when never authorised. */
  expiresAt: number | null
  /** Authorised AND unexpired AND funded — i.e. the next head write costs no prompt. */
  active: boolean
  /** Authorised but inside the renewal window. */
  renewDue: boolean
  /** Planck. `null` when unread. */
  balance: bigint | null
  existentialDeposit: bigint | null
  lowOnFunds: boolean
  /** The contract's `MAX_DELEGATION_SECONDS`, read from chain rather than assumed. */
  maxSeconds: number
  /** One sentence a person can read. Kept in step with the fake backend's copy on purpose. */
  reason: string
}

/* ============================================================== allowance == */

export type AllocationOutcome = 'Allocated' | 'Rejected' | 'NotAvailable'

/* ================================================================== CASH === */

/**
 * Paying another user in CASH.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ⭐ WHY THIS USES `payment.*` (RFC-0006) AND NOT `coinPayment.*` (RFC-0017).
 *
 * A future reader WILL find `coinPayment` in `@parity/truapi`, see the word Coinage in its type
 * names, and conclude we used the wrong API. We did not. Four reasons, in order of how hard they
 * are to argue with:
 *
 *  1. **The host does not implement it.** Every `coin_payment_*` handler is absent from the
 *     reference host bundle (`@parity/host-api-test-sdk`: zero occurrences of `coinPayment`,
 *     `receivable`, `cheque`, `Purse`) and from the public iOS host's product bridge, which
 *     carries only the four RFC-0006 handlers. In the RFC's own Rust trait every method defaults
 *     to `Err(unavailable())`. `@parity/product-sdk-host` wraps NONE of it.
 *  2. **A tip cannot be addressed in that model.** RFC-0017 pays to a `CoinPaymentReceivable` — an
 *     ephemeral public key that only the PAYEE's own running product can mint, bound to a
 *     product-scoped purse. There is no way to derive one from an address, a username or a
 *     profile. The recipient of a tip is, by definition, not here.
 *  3. **Delivery rides the statement store.** `CoinPaymentTransmissionChannel` has exactly one
 *     variant, `Standard { sssTopic }`. Our own `canPushLive` is false for most accounts, so the
 *     handoff channel is unavailable precisely when we would need it.
 *  4. **The payee would have to come back and claim.** `deposit(cheque)` is a second act by the
 *     recipient. A tip that requires the recipient to run Plaza again is not a tip.
 *
 * ⛔ AND `payment.*` IS NOT A DIFFERENT CURRENCY. `HostPaymentRequest.from` and
 * `HostPaymentBalanceSubscribeRequest.purse` are both `CoinPaymentPurseId` — the account-addressed
 * API spends the very same CASH purse the bearer API does. RFC-0017 says so itself: it "does not
 * replace that surface… it extends the relevant RFC 0006 request types with optional CoinPayment
 * purse selectors." See `lib/cash.ts` for the amount scale and the rest of the layering.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/**
 * Why a tip cannot be sent to a particular person. Each value gets its OWN sentence in the UI —
 * "unmapped" and "no-payments" have completely different causes and completely different advice,
 * and collapsing them into "tipping unavailable" is what makes a feature feel broken.
 */
export type TipBlocker =
  /** Not in a host container, or the host exposes no payment manager. */
  | 'no-payments'
  /** The host refused to disclose the balance, so we cannot know if a tip would succeed. */
  | 'balance-unknown'
  /** No `Revive.OriginalAccount` entry — this H160 cannot be resolved to a payable account. */
  | 'unrecipient'

export type TipOutcome =
  | { status: 'sent' }
  /** The user declined the host's confirmation sheet. Not an error; do not shout about it. */
  | { status: 'rejected' }
  | { status: 'insufficient' }
  | { status: 'failed'; reason: string }

export interface PaymentsSeam {
  /**
   * Push subscription of the spendable CASH balance, in base units (see `lib/cash.ts`).
   *
   * ⚠️ `null` MEANS UNKNOWN AND IS NOT ZERO. `subscribeBalance` can be refused per call
   * (`HostPaymentBalanceSubscribeError.PermissionDenied`), and "we may not look" must not render as
   * "you have nothing" — that would tell a funded user they are broke and disable a control that
   * would in fact have worked.
   *
   * This is a SUBSCRIPTION, not a getter. Callers must invoke the returned unsubscribe.
   */
  subscribeBalance: (listener: (available: bigint | null) => void) => () => void

  /**
   * Resolve an H160 to the 32-byte account `requestPayment` needs, via `Revive.OriginalAccount`.
   *
   * ⛔ RETURNS `null` WHEN THERE IS NO MAPPING, AND THE CALLER MUST REFUSE. Never fall back to
   * `h160ToSs58()` or any other derivation: those build the 0xEE-suffixed *fallback* account, which
   * is a DIFFERENT account that nobody holds a key for. Verified on chain — for the one real Plaza
   * writer, `OriginalAccount` gives `5EJ3VTQ…` while the derivation gives `5CcnRhQ…`. Paying the
   * second destroys the money. The mapping is a lookup, never a computation.
   */
  resolveRecipient: (h160Address: string) => Promise<string | null>

  /** Ask the host to debit the USER and pay `destination`. Prompts; never silent. */
  sendTip: (destination: string, amount: bigint) => Promise<TipOutcome>
}

/* ================================================================ backend == */

export interface PutBlobOptions {
  /**
   * ⚠️ A DIAGNOSTICS LABEL AND NOTHING ELSE. Bulletin stores opaque bytes: `store(data)` takes no
   * options and there is nowhere on that chain to put a MIME type. It exists so "12 KB image/png"
   * appears in the panel rather than "12 KB". Readers get the type from the object that references
   * the CID, which is where it has always actually lived.
   */
  contentType?: string
}

/**
 * The two-arm signer seam.
 *
 * ARM 1 — host-signed (`signAndSend`). For contract calls the user must approve. Per §5 of
 * architecture.md this ALWAYS prompts: `SmartContractAllowance` carries no signing key, and all
 * four of the deployed host's signing handlers reach an unconditional modal. There is no
 * "auto-sign for the rest of this session" mode and asking for one does nothing (see
 * `allowance.ts`). Use it for one-off onboarding steps — `authorizeDelegate`, profile creation.
 *
 * ARM 2 — delegate-signed (`delegateSigner`). A local key that signs its OWN transactions, so the
 * host is never asked and no modal appears. Use it for everything on the hot path. Its key is
 * derived through `deriveEntropy` (RFC-0007), namespaced per product by the host, so it is
 * reproducible from the user's wallet on the same device and is never written to disk.
 *
 * ⛔ NOTHING IN THE DELEGATE ARM MAY EVER BLOCK A WRITE. Every failure in it means "fall back to
 * the prompting arm", never an error the user sees. A user must not lose a post because a
 * convenience mechanism broke.
 */
export interface HostAccount {
  /** SS58. What the host calls the account, and what contract `origin` parameters want. */
  address: string
  /** The 0x mapping, when the host exposes one. Needed to match a contract's `msg.sender`. */
  h160Address: string | null
}

export interface SignerSeam {
  /**
   * ARM 1 — host-signed. Prompts, every time, by design.
   *
   * ⚠️ THIS ARM IS DELIBERATELY NOT AN `ethers.Signer`, AND IT CANNOT BE ONE.
   *
   * The host does not sign Ethereum transactions. It signs NATIVE `Revive` extrinsics — which is
   * also, from the other end, why architecture.md §8 is right that polling must not be
   * "modernised" into `eth_getLogs` subscriptions: a host-submitted contract call produces a
   * `Revive.ContractEmitted` in `System.Events` and NOTHING in the ETH log index. So there is no
   * `eth_sendTransaction` the host will answer and no adapter that can fake one. Anything that
   * wants this arm has to build a native transaction and hand it to `submit`.
   *
   * `submit` is left injectable rather than implemented here because the contract interface is
   * owned elsewhere; see `session.ts`.
   */
  host: {
    account: HostAccount | null
    /** The raw SDK signer. Opaque on purpose — only the contract layer should look inside. */
    signer: unknown
    /** Submit an already-prepared native transaction, prompting the user. `null` when unwired. */
    submit: ((prepared: unknown, label: string) => Promise<{ txHash: string }>) | null
  }
  /**
   * ARM 2 — delegate-signed. An ordinary ethers signer backed by the derived delegate key, already
   * connected to the read provider, signing its own transactions with no host involvement and
   * therefore no prompt. `null` when no key could be derived — in which case callers fall back to
   * arm 1 and accept the prompt, and MUST NOT surface that as a failure.
   */
  delegateSigner: ethers.Signer | null
}

/**
 * What a backend — real or fake — must provide. This is THE interface the feature hooks will be
 * migrated onto once the contract interface and Bulletin data layer land.
 */
export interface HostBackend {
  kind: 'host' | 'fake'
  /** Short human label for the diagnostics panel and the settings screen. */
  label: string
  diagnostics: Diagnostics

  capabilities: () => Capabilities
  onCapabilities: (listener: (capabilities: Capabilities) => void) => () => void

  /**
   * Host-signed contract writes — for calls the delegate key must NOT make.
   *
   * `null` when unavailable (no signer, no account). Use this for anything owner-only: the delegate
   * would be recorded as `msg.sender`, and it is unfunded besides. See `contracts.ts`.
   */
  writeContract:
    | ((address: string, abi: Record<string, unknown>[], method: string, args: unknown[], label: string) => Promise<{ txHash: string }>)
    | null

  /**
   * Paying another user in CASH. `null` when this session cannot pay at all — outside a container,
   * or on a host with no payment manager.
   *
   * ⚠️ Non-null does NOT mean a tip will succeed: the balance may be unknown, the recipient may be
   * unresolvable, and the user may decline. See `PaymentsSeam`.
   */
  payments: PaymentsSeam | null

  /** Anonymous reads. Always available, never gated, never needs a wallet. */
  readProvider: () => ethers.Provider | null

  signer: () => SignerSeam

  delegation: () => DelegationState | null
  onDelegation: (listener: (state: DelegationState | null) => void) => () => void
  /** The ONE prompt: fund + authorise in a single transaction. Never throws. */
  authorizeDelegate: () => Promise<DelegationState | null>
  revokeDelegate: () => Promise<boolean>

  /**
   * Store bytes on Bulletin and return their CID.
   *
   * ⭐ This is also THE LAZY-ALLOWANCE TRIGGER, and it lives here rather than somewhere tidier
   * because it is the narrowest choke point that every write passes through and no read does.
   */
  putBlob: (bytes: Uint8Array, options?: PutBlobOptions) => Promise<string>

  /**
   * Request the host's resource allowances, at most once per session, at the first WRITE.
   *
   * ⚠️ MUST NOT BE CALLED FROM A READ PATH. See `allowance.ts`.
   */
  ensureAllowance: () => Promise<AllocationOutcome[] | null>
  /** The user-driven retry. Deliberately bypasses the latch — here, the user asked. */
  requestAllowanceAgain: () => Promise<AllocationOutcome[] | null>

  destroy: () => void
}
