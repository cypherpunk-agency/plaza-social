// Pure. Turns a raw write failure into something a person can act on.
//
// Why this exists: the first real post on the reference deployment failed with
//
//     TxError: createTransaction failed: HostFailure: Submit failed, no allowance set for account
//
// which is accurate, unactionable, and frightening. The content HAD been stored; only the
// announcement failed. A user shown that string has no way to know their words survived, let alone
// what to do next.
//
// ⚠️ RULE FOR EVERY `steps` ENTRY BELOW: only write a step we have verified. Wrong instructions are
// worse than a raw error, because the user follows them, fails, and now distrusts the app as well.
// Where we do not know, say so and point at the diagnostics panel. Each entry carries `confidence`
// so a dialog can hedge honestly rather than uniformly.

export type WriteFailureCode =
  | 'validation'
  /**
   * ⭐ RENAMED FROM `stale_session` ON 2026-07-31, BECAUSE THAT NAME WAS THE WRONG DIAGNOSIS AND THE
   * WRONG DIAGNOSIS WAS ON A USER'S SCREEN.
   *
   * "Stale" says *it used to work and time broke it*, which implies re-establishing the session
   * fixes it. Neither half survived contact with the chain (see the matcher below). The channel is
   * not stale; the account was never allowed to use it, and a fresh sign-in produces a fresh account
   * that is equally not allowed.
   */
  | 'no_statement_allowance'
  | 'no_contract_allowance'
  | 'permission_denied'
  | 'not_mapped'
  | 'no_funds'
  | 'no_container'
  | 'unknown'

export interface WriteClassification {
  code: WriteFailureCode
  title: string
  confidence: 'high' | 'medium' | 'low'
}

export interface WriteExplanation {
  body: string[]
  steps: string[]
  stepsCaveat?: string
  retryLabel: string
}

/**
 * Codes raised by input validation, before anything is sent.
 *
 * These are checked FIRST and pass through untouched, which makes this module TOTAL over every
 * rejection a write path can produce. Without that, a consumer routing all send failures through
 * here turns "that message is 341 characters, 21 over the limit" into a generic shrug — replacing
 * the most actionable message in the app with the least, for the one failure class the user can
 * actually fix themselves. (Observed in the reference app: a consumer did exactly that, because the
 * function name reads as though it covers every write. Naming a boundary in a comment would not have
 * stopped the next one; being total does.)
 */
// Must stay in step with `WireError.code` in `src/lib/wire.ts`. `too_many` (too many tags, too many
// attachments) was missing here, so "that is 9 attachments; 8 is the limit" was laundered into a
// generic write failure — precisely the failure this set exists to prevent. Add new wire codes here.
const VALIDATION_CODES = new Set(['empty', 'invalid', 'too_long', 'too_large', 'too_many', 'wire'])

const isValidationError = (error: unknown): error is Error =>
  (error as { name?: string })?.name === 'ValidationError' ||
  (typeof (error as { code?: unknown })?.code === 'string' &&
    VALIDATION_CODES.has((error as { code: string }).code))

const MATCHERS: Array<{ code: WriteFailureCode; test: RegExp; title: string; confidence: 'high' | 'medium' | 'low' }> = [
  {
    // ⚠️ NOT a smart-contract or gas problem, despite how it reads. Two layers, both **[V]**:
    //
    // ── layer 1, the host bundle (`https://browse.dev-dot.li/assets/auth-BuYgQyky.js`, 2026-07-31)
    //   · The string is one of a family of STATEMENT-STORE submit rejections. The bundle maps
    //     `{tag:'rejected', reason:'noAllowance'}` to `Submit failed, no allowance set for account`,
    //     beside `noProof` / `badProof` / `encodingTooLarge` / `accountFull` / `storeFull`.
    //     Nothing in that family concerns gas, PGAS, deposits or pallet-revive.
    //   · When Plaza runs in a BROWSER, the page reaches the paired phone over an SSO-v2 channel
    //     WHOSE TRANSPORT IS THE STATEMENT STORE: `createTransaction`, `signRaw`, `getRingVrfAlias`
    //     and `requestResourceAllocation` all go through one `c.request(...)` →
    //     `prover.generateMessageProof(...).andThen(statementStore.submitStatement)`, signed by a
    //     RANDOM sr25519 account the browser generates locally (`DeviceIdentity.statementAccountSeed`
    //     = `crypto.getRandomValues(32)`).
    //
    // ── layer 2, the chain — ⭐ THIS IS THE PART THE FIRST INVESTIGATION MISSED, and it inverts the
    //    remedy. `statement_submit` is served by the Individuality/People chain node
    //    (`wss://people-paseo.rotko.net` answers it; **[V]** `rpc_methods`, 2026-07-31), and on that
    //    chain a statement-store allowance has exactly ONE source: `Resources`.
    //
    //      Resources.set_statement_store_account(period, seq, target_account)
    //        "The origin must be `Origin::StmtStoreAlias`, produced by the `AsResources`
    //         (`RegisterStatementStoreAllowance(..)`) transaction extension AFTER PROOF VALIDATION."
    //
    //    `RegisterStatementStoreAllowance` carries an anonymous **ring-VRF membership proof** over
    //    `MembershipCollection::{People | LitePeople}` — i.e. PERSONHOOD. The only other
    //    allowance-raising call, `set_friend_request_statement_account_for_sequence`, is gated the
    //    same way. There is no `Statement` pallet and no balance-derived route.
    //    Reproduce: `node contracts/scripts/probe-statement-allowance.mjs`.
    //
    // ⛔ THREE CONSEQUENCES, and the old copy got all three wrong:
    //
    //   1. **Signing in again cannot help.** Pairing is READ-ONLY on the browser side — `Bl(...)` in
    //      the host bundle only `subscribeStatements` + polls `queryStatements`; the PHONE writes the
    //      handshake statement. So login never touches the allowance and never tests it, and a new
    //      pairing mints a *new* random statement account that needs its own on-chain authorization.
    //      That is why sign-in looks fine and then EVERY action fails identically.
    //   2. **`requestResourceAllocation` travels the same dead channel**, so "we'll ask the host and
    //      retry" cannot work and must never be promised here.
    //   3. **A delegate key is not an escape route** — the pointer write is host-signed, and the
    //      derived delegate H160 is unfunded with nonce 0.
    //
    // The only paths that can work are: run inside the Polkadot app itself (no SSO channel), or hold
    // personhood so the phone can claim a slot. Slots are per-DAY — 20/period for a full person,
    // 10 for a lite person, swept after a 2-day grace window — so even a working browser session
    // needs re-authorizing regularly.
    //
    // The body of the post survives all of this because the Bulletin write does not use that channel
    // at all (the SSO chunk contains no preimage handler). Hence `stored: true` — say so first.
    code: 'no_statement_allowance',
    test: /no allowance set for account/i,
    title: 'Your post is saved, but this browser cannot announce it',
    confidence: 'high',
  },
  {
    // A genuine pre-warmed-gas refusal, which words itself differently. Kept separate so the two
    // never share remedy copy again.
    code: 'no_contract_allowance',
    test: /SmartContractAllowance|PGAS/i,
    title: 'Your post is saved, but not yet visible to others',
    confidence: 'low',
  },
  {
    code: 'permission_denied',
    test: /denied (ChainSubmit|the )|permission (was )?(denied|not granted)|ChainSubmit/i,
    title: 'Your post is saved, but this app was not allowed to announce it',
    confidence: 'high',
  },
  {
    code: 'no_container',
    test: /not inside a (polkadot )?(host )?container|isInsideContainer|no host channel/i,
    title: 'This page is not running inside the Polkadot app',
    confidence: 'high',
  },
  {
    code: 'not_mapped',
    test: /not mapped|account mapping|ensureContractAccountMapped/i,
    title: 'Your post is saved, but your account needs one setup step',
    confidence: 'medium',
  },
  {
    code: 'no_funds',
    test: /insufficient|balance too low|can't pay|cannot pay|Funds/i,
    title: 'Your post is saved, but the announcement could not be paid for',
    confidence: 'medium',
  },
]

export function classifyWriteFailure(error: unknown): WriteClassification {
  // Validation first: it is decided by the error's own SHAPE, not by matching prose, and it must
  // never fall through to a transport matcher.
  if (isValidationError(error)) {
    return { code: 'validation', title: 'That message could not be sent', confidence: 'high' }
  }
  const e = error as { name?: string; message?: string }
  const text = typeof error === 'string' ? error : `${e?.name ?? ''} ${e?.message ?? ''}`
  for (const matcher of MATCHERS) {
    if (matcher.test.test(text)) {
      return { code: matcher.code, title: matcher.title, confidence: matcher.confidence }
    }
  }
  return {
    code: 'unknown',
    title: 'Your post is saved, but it could not be announced',
    confidence: 'low',
  }
}

/**
 * The user-facing explanation and steps.
 *
 * `stored: true` is the single most important thing on the screen and leads every variant — a person
 * who thinks they lost what they wrote will not read the rest.
 */
export function explainWriteFailure({ code }: { code: WriteFailureCode }): WriteExplanation {
  const stored =
    'What you wrote is safely stored — it is not lost, and you do not need to type it again.'
  const announce =
    'What failed is the second half: announcing it on chain so other people can find it. Until that succeeds, you can see it and they cannot.'
  const retryLabel = 'Try announcing again'

  switch (code) {
    case 'validation':
      // Never reaches a dialog — validation rejects before anything is written, so there is no
      // stored content and no remedy beyond editing the message. Present for totality.
      return {
        body: ['Nothing was sent, so nothing was lost. Edit the message and try again.'],
        steps: [],
        retryLabel: 'Try again',
      }

    case 'no_statement_allowance':
      return {
        body: [
          stored,
          'What failed is announcing it so other people can find it — and it failed before anything reached the chain.',
          // ⚠️ NO "signing in again fixes it". It does not, and we said so for a day. See the matcher.
          'When Plaza runs in a browser tab, every signing request has to travel to your phone through the Polkadot statement store, and using that store needs a permission granted on chain — one that only a verified person can be given, one day at a time. Without it this browser cannot reach your phone at all, so nothing it asks you to sign ever arrives.',
        ],
        steps: [
          // Listed first because it is the only step that removes the channel rather than repairing it.
          'Open Plaza from inside the Polkadot app itself — find plaza-social.dot there — instead of in a browser paired to your phone. That path signs on the device and does not use this channel.',
          'If you want the browser to work, finish the "prove you are a person" step in the Polkadot app first, then sign in again here.',
          'Signing in again on its own will not help — it hands this browser a new identity that needs the very same permission.',
        ],
        stepsCaveat:
          'We traced this on chain rather than on a device: the mechanism is confirmed, the two remedies are not. If the in-app route fails the same way, that is genuinely new information — please send the diagnostics report.',
        retryLabel,
      }

    case 'no_contract_allowance':
      return {
        body: [stored, announce, 'The allowance for submitting contract transactions could not be obtained for this account.'],
        steps: [
          'Try announcing again — the app re-requests the allowance first, and this often clears it.',
          'If the Polkadot app shows a prompt asking you to approve a resource for Plaza, approve it.',
          'If it fails again, send us the diagnostics report so we can see which step refused.',
        ],
        stepsCaveat:
          'We have not seen this exact failure in the wild, so treat these steps as a best guess and send the report if they do not work.',
        retryLabel,
      }

    case 'permission_denied':
      return {
        body: [
          stored,
          announce,
          'The Polkadot host did not grant this app permission to submit transactions, so the announcement was refused before it was sent.',
        ],
        steps: [
          'Try announcing again — the app will ask for the permission once more, and a prompt should appear.',
          'Approve the prompt when it appears.',
          'If no prompt appears, close and reopen Plaza from the Polkadot app so the permission can be requested fresh.',
        ],
        retryLabel,
      }

    case 'no_container':
      return {
        body: [
          'Plaza can only post from inside the Polkadot app. Reading works anywhere; writing needs the host container, which is where signing happens.',
          'Nothing was lost, and nothing was sent.',
        ],
        steps: ['Open Plaza from the Polkadot app rather than from a browser tab.'],
        retryLabel: 'Try again',
      }

    case 'not_mapped':
      return {
        body: [
          stored,
          announce,
          'Your account needs a one-off setup transaction before it can call contracts. This happens once, and every later post skips it.',
        ],
        steps: [
          'Try announcing again and approve the transaction the Polkadot app asks you to sign.',
          'This only happens on your first post from this account.',
        ],
        retryLabel,
      }

    case 'no_funds':
      return {
        body: [
          stored,
          announce,
          'Announcing costs a small refundable deposit, and this account does not appear to have enough to cover it.',
        ],
        steps: [
          'Try announcing again — the app will ask the host to cover the cost, which usually works.',
          'If it keeps failing, this account may need funding. Send us the diagnostics report and we will confirm which it is.',
        ],
        stepsCaveat:
          'We have not verified the funding route for product accounts, so treat the second step as a guess and send the report instead.',
        retryLabel,
      }

    default:
      return {
        body: [
          stored,
          announce,
          'We do not recognise this particular failure, so we would rather not guess at a fix and send you down the wrong path.',
        ],
        steps: [
          'Try announcing again — a fair share of these are transient.',
          'If it fails again, open the diagnostics report and send it to us. It contains the exact step that failed.',
        ],
        retryLabel,
      }
  }
}

/**
 * The one plain sentence a UI can render anywhere, safely, without reading raw backend text.
 *
 * Deliberately short and STEP-FREE: it goes on PERSISTENT surfaces (a failed row, a status line)
 * that outlive a dialog, so it has to stand alone — while remedies, which go stale, live only in the
 * dialog where they can be kept correct. The reference app's first remedy told people to retry over
 * the very channel that was down; that is the argument for keeping steps out of anything long-lived.
 */
export function plainWriteFailure(error: unknown): string {
  // Validation messages are already written for people and carry the specific detail that makes them
  // useful ("21 over the limit"). Flattening them would be a strict downgrade, so they pass through.
  if (isValidationError(error)) return error.message
  if ((error as { stored?: boolean })?.stored === true) {
    return 'Saved, but not yet visible to other people.'
  }
  const { code } = classifyWriteFailure(error ?? '')
  // ⚠️ This line used to end "Signing in again should fix it." It does not — see the matcher. It is
  // the sentence most likely to be the ONLY thing a user reads, so it must not carry a false remedy.
  if (code === 'no_statement_allowance') {
    return 'This browser could not reach your phone to sign. Open Plaza inside the Polkadot app instead.'
  }
  if (code === 'no_container') return 'Posting needs the Polkadot app. Reading works anywhere.'
  return 'Could not be posted. Nothing was stored, so trying again is safe.'
}

/**
 * ⭐ THE THING THAT WAS MISSING. Everything above this line existed and was correct on 2026-07-31 —
 * and **nothing in the app called any of it**. `classifyWriteFailure` had exactly three importers,
 * all of them the re-export list in `lib/host/index.ts`. So when a real reply failed on a real phone
 * the user was shown, verbatim:
 *
 *     TxError: createTransaction failed: HostFailure: Submit failed, no allowance set for account
 *
 * A classifier that no failure path routes through is decoration. `WriteFailure` is what makes it
 * structural: `lib/publish.ts` wraps every write failure in one of these, so the interpretation
 * happens at the ONE place that knows whether the body was already stored, and every consumer —
 * toast, error log, composer, a component nobody has written yet — gets the readable version without
 * having to remember to ask for it.
 *
 * ⚠️ `message` IS THE USER-FACING SENTENCE and must stay ONE line under 200 characters, because
 * `lib/errors.ts` `summarise()` puts it straight into a toast. The long form lives in `steps`.
 */
export class WriteFailure extends Error {
  override readonly name = 'WriteFailure'
  readonly code: WriteFailureCode
  readonly confidence: 'high' | 'medium' | 'low'
  readonly title: string
  /**
   * Whether the body reached Bulletin before the failure.
   *
   * ⭐ The single most important bit on the screen. Someone who thinks they lost what they wrote will
   * not read anything else, and for the failure that prompted this file the words HAD survived —
   * only the pointer write failed.
   */
  readonly stored: boolean
  /** The remedy, newline-joined and pre-numbered. Goes in the copyable detail, never in the toast. */
  readonly steps: string

  constructor(cause: unknown, options: { stored: boolean }) {
    const classification = classifyWriteFailure(cause)
    const explanation = explainWriteFailure(classification)
    // `stored` is what the CALLER observed, and it outranks the classifier's assumption: the
    // matchers' titles all read "your post is saved", which is a lie when the Bulletin write is the
    // thing that failed. Body failures must not tell someone their words are safe.
    const headline = options.stored ? classification.title : 'That post could not be sent'
    super(`${headline} — ${plainWriteFailure(cause)}`, { cause })
    this.code = classification.code
    this.confidence = classification.confidence
    this.title = headline
    this.stored = options.stored
    this.steps = [
      ...(options.stored ? explanation.body : []),
      ...explanation.steps.map((step, index) => `${index + 1}. ${step}`),
      ...(explanation.stepsCaveat ? [`(${explanation.stepsCaveat})`] : []),
    ].join('\n')
  }
}

/**
 * Wrap anything thrown by a write, unless it is already wrapped or is the user's own input problem.
 *
 * Validation errors pass through UNTOUCHED, and that is load-bearing rather than an optimisation:
 * "that message is 341 characters, 21 over the limit" is the most actionable message in the app, and
 * it is about content that was never sent. Laundering it into "your post is saved, but…" would be
 * both less useful and false.
 */
export function asWriteFailure(error: unknown, options: { stored: boolean }): unknown {
  if (error instanceof WriteFailure) return error
  if (isValidationError(error)) return error
  return new WriteFailure(error, options)
}

/**
 * Is this failure one that a cached allowance claim could be responsible for?
 *
 * The caller is `lib/host/session.ts`, which uses it to decide whether to `invalidate()` the
 * persisted claim. Deliberately narrow: invalidating on every write failure would throw away a
 * perfectly good grant every time an RPC hiccuped, and put an allowance dialog in front of a user
 * whose actual problem was a dropped connection.
 *
 * ⚠️ For `no_statement_allowance` this is BOOKKEEPING ONLY and will not fix anything. The claim we
 * cached is a record that we once asked; the thing actually missing is an on-chain statement-store
 * slot that only a personhood proof can create. Dropping the claim just stops us lying in the
 * diagnostics panel about having a grant.
 */
export function isAllowanceFailure(code: WriteFailureCode): boolean {
  return code === 'no_statement_allowance' || code === 'no_contract_allowance'
}
