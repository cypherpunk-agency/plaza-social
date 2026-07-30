// Resource allowances: WHEN we ask the host, and what we ask for.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 1. `requestResourceAllocation` IS OPPORTUNISTIC, NOT A PRECONDITION.
//
//    From the truapi type docs, verbatim: "pre-allocation is opportunistic and the host may also
//    fulfil the allowance implicitly on the first submission." So `Rejected` / `NotAvailable` coming
//    back does NOT mean the write will fail. It is recorded and we carry on. Gating the UI on the
//    answer would disable writing for users who can in fact write.
//
//    ⚠️ THAT IS NOT A LICENCE TO ASK EVERY TIME, WHICH IS WHAT IT BECAME IN THE REFERENCE APP. The
//    request was made unconditionally during session setup, and session setup runs on load — so
//    every visitor, INCLUDING ONE WHO ONLY EVER READS, was shown the host's allowance modal on
//    every single page load. "Do not gate on the answer" and "ask before anyone needs it" are
//    different statements and only the first one is true.
//
//    So it is LAZY: `ensureAllowance` runs at the first WRITE of a session and never on a read.
//
// 2. THE LATCH CACHES THE ATTEMPT, NOT THE ANSWER.
//
//    A `Rejected` is a user who said no. Re-opening the same dialog on their next post is the
//    nagging this whole mechanism exists to stop. The only thing that bypasses the latch is an
//    explicit user-driven retry (`requestAgain`) — there, the user asked.
//
// 3. THE LATCH IS PERSISTED ACROSS RELOADS, and that is only sound because `AutoSigning` is gone.
//
//    The three resources we do request are the SLOT-TABLE allowances, which the same truapi
//    paragraph scopes "opportunistic" to BY NAME. Every one has implicit fulfilment, so the worst
//    case of a stale claim is an implicit allocation on submission — i.e. the documented behaviour.
//    That is the difference between one dialog per page load and one dialog per day.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

import type { AllocationOutcome, Diagnostics } from './types'
import { describe, describeAge, TIMEOUTS, unwrapParity, withTimeout } from './util'
import { loadHost } from './sdk'

/**
 * The resources Plaza asks the host to pre-allocate. Requested as ONE batch so the user sees one
 * dialog rather than three.
 *
 * ⛔⛔ `AutoSigning` USED TO BE THE FIRST ENTRY HERE. DO NOT PUT IT BACK.
 *
 * It reads like the fix for "why am I approving every single message?" — truapi describes it as
 * "permission to sign on the product's behalf without per-call user prompts", and the host SDK adds
 * "the host prompts the user once; subsequent operations covered by the granted allowance don't
 * re-prompt". Both sentences are in the type docs. NEITHER IS TRUE OF THE HOST WE SHIP INSIDE.
 * Read from the deployed `dev-dot.li` host bundle (evidence recorded in architecture.md §5 and in
 * `yolodot/apps/plaza/src/lib/host-session.js:446-478`):
 *
 *   · `handleRequestResourceAllocation` FLATTENS the response before it stores anything:
 *     `.map(e => e.tag === 'Allocated' ? { tag: 'Allocated', value: void 0 } : e)`. The `AutoSigning`
 *     payload (`{ productDerivationSecret, productRootPrivateKey }`) is discarded on the way in.
 *     Whatever the user approved never survives the reply handler.
 *   · The host's allowance service persists exactly `resource: O({ bulletin, statementStore })`.
 *     There is no storage slot for auto-signing anywhere in the bundle, and no consumer of one.
 *   · All four signing handlers — `handleSignPayload`, `handleCreateTransaction`, `handleSignRaw`,
 *     `handlePreimageSubmit` — go straight to an unconditional modal. Not one reads an allowance.
 *   · Parity's own docs, verbatim: "There is no 'auto-sign for the rest of this session' mode. Two
 *     consecutive transactions produce two prompts; ten produce ten. This is intentional."
 *
 * So asking for it bought nothing and cost two things: it contributed the first and scariest line of
 * the dialog ("Sign transactions automatically"), and — because it is the one variant with NO
 * implicit fulfilment and the SDK scopes it to the host session — it was the sole reason the latch
 * could not be persisted to disk. Dropping it is what makes `readClaim`/`writeClaim` sound.
 *
 * This does NOT contradict the finding that a granted `BulletinAllowance` is prompt-free. The
 * `Allocated` codec carries a `slotAccountKey` for bulletin and statement-store — a signing key the
 * host KEEPS — while `SmartContractAllowance` carries no key, which is why contract calls still
 * reach a modal and Bulletin stores do not. The flattening discards payloads in the product-facing
 * reply; the host retains the bulletin keys internally. `AutoSigning` has no host-side slot at all,
 * so its keys genuinely are lost.
 *
 * ⚠️ Spelling wrinkle to watch for: the host bundle spells the tag `BulletInAllowance` (capital I)
 * four times and `BulletinAllowance` once; the SDK types use `BulletinAllowance` only. Either the
 * host maps between them or one is a display string. If an allowance request is silently rejected,
 * check this before assuming anything else — do not misdiagnose it as a permissions problem.
 */
const PLAZA_RESOURCES: Array<{ tag: string; value?: number }> = [
  // Pre-warmed PGAS for the contract account. `value` is the derivation index; 0 is the product
  // account we sign with. Worth keeping but NOT a fix for anything: RFC-0010 makes pre-warming a
  // latency optimisation — the account implicitly claims a slot when it is about to pay fees and
  // does not hold enough, so steady-state signing works without it.
  { tag: 'SmartContractAllowance', value: 0 },
  { tag: 'StatementStoreAllowance', value: undefined },
  { tag: 'BulletinAllowance', value: undefined },
]

/**
 * How long a persisted claim is trusted before we ask again.
 *
 * There is nothing to read back: `AllocationOutcome` is a bare string union with no expiry, no
 * handle and no query, so the TTL is ours to pick and it is a guess bounded by measurement. The
 * shortest lease behind these three resources is the on-chain `StatementStoreAllowance`, measured at
 * roughly 2–3 days. 24 h sits comfortably inside that, which means the failure mode we are choosing
 * is "one unnecessary dialog a day" rather than "a claim that outlives its grant". Both are
 * survivable — implicit fulfilment covers the second — but the first is the one a user would rather
 * have.
 */
const CLAIM_TTL_MS = 24 * 60 * 60 * 1000

/**
 * ⚠️ KEYED BY ACCOUNT ADDRESS. A different account is a different grant and inherits nothing; a
 * shared browser or an account switch must produce its own dialog, not silently reuse someone
 * else's claim.
 */
const claimKey = (address: string) => `plaza.allowance.v1:${address}`

interface Claim {
  at: number
  age: number
  outcomes: string
}

/**
 * ⚠️ NEITHER `readClaim` NOR `writeClaim` MAY THROW. They sit on the write path, between a user
 * pressing Post and the bytes going to Bulletin. Private browsing, a disabled store, a full quota
 * and JSON somebody else wrote all resolve to "no claim" — and "no claim" is the safe answer: we
 * ask, and the user sees exactly the one dialog they would have seen before this cache existed.
 */
function readClaim(address: string | null): Claim | null {
  if (!address) return null
  try {
    const raw = globalThis.localStorage?.getItem(claimKey(address))
    if (!raw) return null
    const claim = JSON.parse(raw) as { at?: unknown; outcomes?: unknown }
    const at = Number(claim?.at)
    if (!Number.isFinite(at)) return null
    const age = Date.now() - at
    // A negative age means a clock that moved backwards, not a fresh claim. Distrust it.
    if (age < 0 || age > CLAIM_TTL_MS) return null
    return { at, age, outcomes: typeof claim?.outcomes === 'string' ? claim.outcomes : '' }
  } catch {
    return null
  }
}

function writeClaim(address: string | null, outcomes: string): void {
  if (!address) return
  try {
    globalThis.localStorage?.setItem(claimKey(address), JSON.stringify({ at: Date.now(), outcomes }))
  } catch {
    // Quota, privacy mode, or no storage at all. The in-memory latch still covers this page load;
    // the entire cost is one dialog on the next one.
  }
}

export interface AllowanceGate {
  /**
   * ⚠️ MUST NOT BE CALLED FROM A READ PATH. The entire point is that a visitor who only reads never
   * sees the host's allowance modal; putting this behind anything that runs on load puts the dialog
   * straight back on every page load, which is the bug it exists to fix.
   *
   * Concurrent callers share the one in-flight promise, so two posts fired together produce one
   * dialog. Never throws, never gates: the caller's write proceeds whatever comes back.
   */
  ensure: () => Promise<AllocationOutcome[] | null>
  /**
   * The user-driven retry. DELIBERATELY BYPASSES both halves of the latch — the in-memory promise
   * and the persisted claim. It is the only thing that does. Everywhere else a second dialog is
   * nagging; here the user pressed a button that says this is what it will do, so suppressing it
   * would be lying to them. It also re-primes both halves with the fresh answer, which makes it the
   * way out of a "deny" the user regrets.
   */
  requestAgain: () => Promise<AllocationOutcome[] | null>
  /** What the load path may safely report: whether the FIRST write will show a dialog. Reads only localStorage. */
  describeDeferred: () => string
  /** Called on reconnect. Clears the in-memory latch only — it never requests, so no dialog appears. */
  reset: () => void
}

export function createAllowanceGate({
  address,
  diagnostics: diag,
}: {
  address: () => string | null
  diagnostics: Diagnostics
}): AllowanceGate {
  /** Holds the in-flight-or-settled promise of the one allocation request this session makes. */
  let inFlight: Promise<AllocationOutcome[] | null> | null = null

  /** Never throws, never gates. */
  async function allocate(
    resources: Array<{ tag: string; value?: number }>,
    note: string,
  ): Promise<AllocationOutcome[] | null> {
    const who = address()
    try {
      const host = await loadHost()
      if (host?.__parityStub === true) {
        diag.step('allowance', 'skip', 'the Products SDK is not installed in this build')
        return null
      }
      const outcomes = unwrapParity<AllocationOutcome[]>(
        await withTimeout(
          host.requestResourceAllocation(resources),
          TIMEOUTS.allowance,
          'Resource allocation',
        ),
        'Resource allocation',
      )
      // Outcomes come back POSITIONALLY, so name them — "Rejected, Allocated, Allocated" is
      // unreadable, and the three entries differ in how much anyone should care.
      const named = outcomes
        .map((outcome, index) => `${resources[index]?.tag ?? index}=${outcome}`)
        .join(', ')
      // ⚠️ The claim records that we ASKED and got an answer, not that the answer was yes.
      writeClaim(who, named)
      diag.step('allowance', outcomes.includes('Allocated') ? 'ok' : 'skip', `${note}: ${named}`)
      return outcomes
    } catch (error) {
      // No claim written. Either the host never answered or it failed — nothing was shown and
      // nothing was decided, so a reload should be free to ask again.
      diag.step(
        'allowance',
        'skip',
        `${describe(error)} — the host may still allocate implicitly on submission`,
      )
      return null
    }
  }

  return {
    ensure() {
      if (!inFlight) {
        const claim = readClaim(address())
        if (claim) {
          diag.step(
            'allowance',
            'ok',
            `cached from a previous load, granted ${describeAge(claim.age)} ago` +
              `${claim.outcomes ? ` (${claim.outcomes})` : ''} — reused without asking the host, so no ` +
              `dialog was shown. Claims expire after ${describeAge(CLAIM_TTL_MS)}.`,
          )
          // Resolve to null, exactly as a refused or timed-out allocation does. No caller reads
          // this value for anything but logging, and inventing outcomes we did not receive would
          // put fiction into the one panel we debug production from.
          inFlight = Promise.resolve(null)
        } else {
          diag.step('allowance', 'running', 'first write of this session, no cached grant')
          inFlight = allocate(PLAZA_RESOURCES, 'requested this session')
        }
      }
      return inFlight
    },

    requestAgain() {
      const promise = allocate(PLAZA_RESOURCES, 'explicit retry')
      inFlight = promise
      return promise
    },

    describeDeferred() {
      const claim = readClaim(address())
      return claim
        ? `deferred — cached from a previous load, granted ${describeAge(claim.age)} ago` +
            `${claim.outcomes ? ` (${claim.outcomes})` : ''}. Your first post will reuse it and show no ` +
            `dialog; claims expire after ${describeAge(CLAIM_TTL_MS)}.`
        : 'deferred — requested at your first post, not on load. No cached grant for this account, ' +
            'so that post will show one dialog.'
    },

    /**
     * Fires on the SDK's automatic reconnect. It only CLEARS the in-memory latch — it never
     * requests, so this stays off the load path and no dialog appears here.
     *
     * The three allowances we ask for are chain-side and survive a reconnect untouched, so this is
     * not a re-ask. What it buys is correctness across an ACCOUNT SWITCH: the next write re-reads
     * the persisted claim for the CURRENT address, and a different account has no claim and gets
     * its own dialog, which is right.
     */
    reset() {
      inFlight = null
    },
  }
}

/** Exported so the diagnostics panel and any test can assert on the real list. */
export const ALLOWANCE_FACTS = {
  resources: PLAZA_RESOURCES.map((r) => r.tag),
  claimTtlMs: CLAIM_TTL_MS,
  /** Stated explicitly so a future reader does not have to infer it from an absence. */
  autoSigningRequested: false,
} as const
