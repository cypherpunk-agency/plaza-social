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
//
// 4. ⭐ A PERSISTED CLAIM MUST BE DESTROYABLE BY EVIDENCE. `invalidate()`, added 2026-07-31.
//
//    This is the bug that broke replies. On 2026-07-30 ~22:22 a claim was written and two threads
//    published. At 06:46 the next morning — 8h later, well inside the 24 h TTL — a reply failed with
//
//        TxError: createTransaction failed: HostFailure: Submit failed, no allowance set for account
//
//    and the claim latch meant we had not even asked. "The latch caches the attempt, not the answer"
//    is right; what was missing is that a WRITE FAILURE NAMING AN ALLOWANCE IS PROOF THE CLAIM IS
//    WORTHLESS. Rules 1–3 all concern not nagging a user who has not contradicted us. Here the host
//    contradicted us. So the claim dies and the next write asks again.
//
//    ⚠️ NOT a shorter TTL. A shorter TTL trades one dialog a day for several and still leaves the
//    window in which we trust a claim the host has already refuted. Invalidation is the correct
//    shape: the TTL bounds the guess, evidence overrides it.
//
//    ⛔ BUT DO NOT READ RULE 4 AS A FIX FOR THAT FAILURE. It is hygiene. The 2026-07-31 failure was
//    never about a stale claim: on a browser host the write dies in the statement store, whose
//    allowance is personhood-gated on chain and cannot be obtained by asking the host again, by
//    signing in again, or by anything else this file does. Corrected the same day, one day after the
//    "sign in again" copy shipped. See `errors.ts` § `no_statement_allowance`.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

import type { AllocationOutcome, Diagnostics } from './types.ts'
import { describe, describeAge, TIMEOUTS, unwrapParity, withTimeout } from './util.ts'
import { loadHost } from './sdk.ts'

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
  /**
   * Pre-warmed PGAS for the contract account. `value` is the derivation index and **0 is correct** —
   * every product-account path in the SDK defaults to 0 (`getProductAccount(dotNsIdentifier,
   * derivationIndex = 0)`, `HostSigner`'s `derivationIndex = 0`), and `contracts.ts` signs with the
   * account that seam hands back, so 0 is the account we actually sign with. **[V]** 2026-07-31.
   *
   * ⚠️ BUT IT IS NOT THE ALLOWANCE A CONTRACT WRITE CONSULTS, AND ASKING FOR IT FIXES NOTHING.
   * Two independent readings, both **[V]** 2026-07-31 against the live host bundle
   * `https://browse.dev-dot.li/assets/auth-BuYgQyky.js`:
   *
   *   · The host's persisted allowance record is
   *     `{ productId, resource: O({ bulletin, statementStore }), slotAccountKey }`, and its
   *     tag mapper is exactly two cases —
   *     `bulletin → {tag:'BulletInAllowance'}`, `statementStore → {tag:'StatementStoreAllowance'}`.
   *     **There is no smart-contract case and no storage slot for one.** So this entry is inert on
   *     the host we ship inside. It is kept because RFC-0010 defines it and a future host may honour
   *     it, not because it does anything today.
   *   · RFC-0010 makes pre-warming a latency optimisation anyway: the account implicitly claims a
   *     slot when it is about to pay fees and does not hold enough.
   *
   * What a contract write really needs is `StatementStoreAllowance` — see the note below it.
   */
  { tag: 'SmartContractAllowance', value: 0 },
  /**
   * ⭐ THIS IS THE ONE A CONTRACT WRITE DEPENDS ON, and nothing about its name says so.
   *
   * **[V]** 2026-07-31, read out of `auth-BuYgQyky.js`: the web host talks to the paired phone over
   * an SSO-v2 channel **whose transport is the statement store**. Every request it forwards —
   * `createTransaction`, `signRaw`, `getRingVrfAlias`, and `requestResourceAllocation` itself — goes
   * through one `c.request(...)` → `submitRequestMessage` → `prover.generateMessageProof(...)`
   * `.andThen(statementStore.submitStatement)`.
   *
   * So the string `"Submit failed, no allowance set for account"` is a STATEMENT-STORE rejection
   * (`{tag:'rejected', reason:'noAllowance'}` → one of a family with `noProof` / `badProof` /
   * `encodingTooLarge` / `accountFull` / `storeFull` / `expiryTooLow`). Nothing in that family
   * concerns gas, PGAS, deposits or pallet-revive. A contract call fails there because the request
   * could not be SHIPPED to the phone to be signed — it never reached a chain.
   *
   * ⚠️ CONSEQUENCE, and it is why `invalidate()` is bookkeeping rather than a remedy:
   * `requestResourceAllocation` travels the SAME dead channel, so "re-request and retry" cannot work
   * for this failure and must never be promised to the user.
   *
   * ⛔ **AND NEITHER CAN SIGNING IN AGAIN. This paragraph asserted that it could, for one day.**
   * **[V] 2026-07-31**: on the chain that serves `statement_submit`, a statement-store allowance has
   * one source — `Resources.set_statement_store_account`, whose origin requires an anonymous ring-VRF
   * **personhood** proof (`RegisterStatementStoreAllowance`) over `People`/`LitePeople`. Pairing is
   * read-only on the browser side, so a fresh login neither tests nor obtains one; it mints a new
   * random statement account that needs the same grant. `host/errors.ts` classifies this as
   * `no_statement_allowance` and points at the in-app route instead. See
   * `contracts/scripts/probe-statement-allowance.mjs` and gotchas.
   */
  { tag: 'StatementStoreAllowance', value: undefined },
  /**
   * The Bulletin slot allowance. The host keeps a `slotAccountKey` for this one, which is why a
   * post's BODY still stores while its POINTER fails: the body goes out over the preimage channel
   * signed with a key the browser holds locally, and needs no round-trip to the phone at all
   * (`auth-BuYgQyky.js` contains no preimage handler — that path is elsewhere and does not use the
   * SSO channel). Exactly the asymmetry the 2026-07-31 reply failure showed.
   */
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

/** Same no-throw contract as the other two: a store that cannot be cleared is slow, never broken. */
function clearClaim(address: string | null): void {
  if (!address) return
  try {
    globalThis.localStorage?.removeItem(claimKey(address))
  } catch {
    /* the in-memory latch is cleared regardless, so this page load still re-asks */
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
  /**
   * ⭐ THROW THE CLAIM AWAY because the host has contradicted it. See rule 4 in the header.
   *
   * Call this — and ONLY this — from a write that failed for want of an allowance. It clears both
   * halves of the latch, so the next write asks the host again instead of trusting a record that a
   * real failure has already refuted.
   *
   * ⚠️ IT DOES NOT REQUEST, AND MUST NOT. Requesting here would put a dialog on top of an error
   * dialog, and for the failure that actually produces this (`no_statement_allowance`) the request travels the
   * same dead channel the write did, so it would hang for the host's four-minute queue timeout and
   * then change nothing. Its whole job is bookkeeping: make the NEXT attempt honest.
   *
   * Never throws.
   */
  invalidate: (reason: string) => void
  /** What the load path may safely report: whether the FIRST write will show a dialog. Reads only localStorage. */
  describeDeferred: () => string
  /** Called on reconnect. Clears the in-memory latch only — it never requests, so no dialog appears. */
  reset: () => void
}

export function createAllowanceGate({
  address,
  diagnostics: diag,
  request,
}: {
  address: () => string | null
  diagnostics: Diagnostics
  /**
   * Injected for tests only. Defaults to the real host call.
   *
   * `publish.ts` takes its chain access as functions for exactly this reason: the write path runs
   * inside a container, i.e. on a phone, where every bug costs a deploy to see. The latch's
   * ask/don't-ask decision is the part of this file that was wrong, so it needs to be assertable
   * without a host.
   */
  request?: (resources: Array<{ tag: string; value?: number }>) => Promise<AllocationOutcome[] | null>
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
      const outcomes = request
        ? await request(resources)
        : await (async () => {
            const host = await loadHost()
            if (host?.__parityStub === true) return null
            return unwrapParity<AllocationOutcome[]>(
              await withTimeout(
                host.requestResourceAllocation(resources),
                TIMEOUTS.allowance,
                'Resource allocation',
              ),
              'Resource allocation',
            )
          })()
      if (!outcomes) {
        diag.step('allowance', 'skip', 'the Products SDK is not installed in this build')
        return null
      }
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

    invalidate(reason) {
      inFlight = null
      clearClaim(address())
      diag.step(
        'allowance',
        'skip',
        `cached grant discarded — ${reason}. The next write will ask the host again rather than ` +
          `trust a claim a real failure has already contradicted.`,
      )
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
