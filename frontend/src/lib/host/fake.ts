// The fake backend. Selected with `?backend=fake`.
//
// ⚠️ THIS IS REQUIRED INFRASTRUCTURE, NOT A CONVENIENCE. Two independent reasons, both from
// architecture.md §1 and §1a:
//
//   · The Products SDK THROWS OUTSIDE A CONTAINER. Without a fake there is no localhost development
//     at all — not "a degraded experience", none.
//   · The write path needs a phone. Signing, `deriveEntropy` and the Bulletin channels are all
//     container-only, so the local loop is the only one that does not cost a deploy per iteration.
//
// ⚠️ CORRECTED 2026-07-30 — this used to say "publishing is rate-limited to 1/day on Lite
// personhood", offered as a second reason. That is FALSE for deploys: several an hour work fine. The
// limit belongs to `pad --publish`, which is the Browse listing, not the deploy. Iterate locally
// because it is fast, not because deploys are scarce.
//
// It only earns its keep if it behaves like the real thing, so it reproduces the FAILURE MODES rather
// than the happy path:
//
//   · latency on every operation
//   · every capability combination, including the one that is easy to get wrong
//     (`canWrite && !canPushLive` — see below)
//   · every delegate state the UI has to render, including the two nobody remembers: an
//     authorisation inside its renewal window, and a key that is authorised but out of fees
//   · writes that fail, so an optimistic row has something to fail against
//
// ⭐ THE CAPABILITY COMBINATION THAT MATTERS MOST is `?caps=write`, which simulates an account with a
// Bulletin authorization but NO statement-store allowance — i.e. anyone without a personhood proof,
// which is the MAJORITY of accounts. Posting must keep working; only instant propagation goes away,
// replaced by polling. If the composer is disabled in that mode, that is the bug this switch exists
// to catch.
//
// Deterministic by default: the same seed produces the same jitter and the same delegate clock on
// every reload, because a UI you cannot reproduce is a UI you cannot debug.

import { ethers } from 'ethers'

import { createCapabilityStore } from './capabilities'
import { createDelegate } from './delegate'
import { createDiagnostics } from './diagnostics'
import type { HostBackend, PutBlobOptions } from './types'
import { sleep } from './util'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Shaped like an SS58 address so truncation and copy-to-clipboard look right. */
export const FAKE_SELF_SS58 = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty'
/** …and like an 0x address, because the contract layer reads `msg.sender`, not an SS58 string. */
export const FAKE_SELF_H160 = '0x9e2a3f4b5c6d7e8f90a1b2c3d4e5f60718293a4b'

/**
 * The fake delegate's entropy. A FIXED, OBVIOUSLY-FAKE seed rather than a random one, for two
 * reasons: the derived address is then stable across reloads (so a screenshot of the settings panel
 * is reproducible), and nobody can mistake a key derived from the literal string "fake" for
 * something worth funding.
 */
const FAKE_ENTROPY = new TextEncoder().encode('plaza:fake-backend:delegate:do-not-fund:v1')

export type FakeCapabilityPreset = 'none' | 'read' | 'write' | 'live'
export type FakeDelegatePreset = 'none' | 'active' | 'expiring' | 'expired' | 'lowfunds' | 'unavailable'

export interface FakeOptions {
  /**
   * `none` — outside a container entirely: the localhost default, and what a browser tab sees.
   * `read` — inside a container, no account: an anonymous reader. Reads work, composer is off.
   * `write` — ⭐ can write, CANNOT push live. The common no-personhood case. Composer must work.
   * `live`  — everything on. The happy path, and the least interesting.
   */
  caps?: FakeCapabilityPreset
  delegate?: FakeDelegatePreset
  latencyMs?: number
  /** 0..1 chance that a write rejects, so failure UI has something to render. */
  failRate?: number
  seed?: number
  /**
   * ETH-RPC URL for reads, or `null` for no read provider at all.
   *
   * Defaulting to a REAL endpoint is deliberate: the 16 feature hooks have not been migrated onto
   * this seam yet, so they still read chain state directly through ethers. Handing them a live
   * provider means `?backend=fake` exercises the real read path against real data while faking
   * exactly the parts that need a phone. `?rpc=off` drops it, to see how the app behaves with no
   * chain at all.
   */
  rpcUrl?: string | null
}

/* ------------------------------------------------------------ tiny PRNG -- */
// mulberry32: four lines, deterministic, good enough to jitter latency and place failures.
function rng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function createFakeBackend(options: FakeOptions = {}): HostBackend {
  const {
    caps = 'none',
    delegate: delegatePreset = 'none',
    latencyMs = 90,
    failRate = 0,
    seed = 20260729,
    rpcUrl,
  } = options

  const diag = createDiagnostics()
  const random = rng(seed)
  const jitter = (base: number) => Math.max(0, Math.round(base * (0.6 + random() * 0.9)))

  const provider =
    rpcUrl === null || rpcUrl === undefined ? null : new ethers.JsonRpcProvider(rpcUrl)

  const canWrite = caps === 'write' || caps === 'live'
  const canPushLive = caps === 'live'

  const capabilities = createCapabilityStore({
    canRead: caps !== 'none' || true, // reading never depends on a container
    canWrite,
    canPushLive,
    // The fake backend stands in FOR the container, so this is true. Otherwise every `?backend=fake`
    // session would render the "open this in the Polkadot app" advice while deliberately simulating
    // already being inside it.
    insideHost: true,
    address: canWrite ? FAKE_SELF_H160 : null,
    reason:
      caps === 'none'
        ? 'Fake backend: simulating a page outside the Polkadot app. Reading works, posting does not.'
        : caps === 'read'
          ? 'Fake backend: simulating a visitor with no account. Reading works, posting does not.'
          : undefined,
    liveReason: canWrite && !canPushLive
      ? 'Fake backend: simulating an account with no personhood proof. New posts appear on a timer rather than instantly. Posting still works.'
      : undefined,
  })

  /* ------------------------------------------------------------ delegation - */
  //
  // The delegate key is a real derived key here, from `FAKE_ENTROPY` instead of the host — so the
  // fake exercises the SAME code path as production (`createDelegate`, `entropyToPrivateKey`, the
  // ethers wallet) rather than a parallel imitation that can drift from it. What is faked is only
  // the two things that need a chain: the authorisation clock and the balance.
  const delegate = createDelegate({
    diagnostics: diag,
    provider: () => provider,
    deriveOverride: async () => {
      await sleep(jitter(latencyMs))
      // The one preset with no key at all: the host refused to derive entropy, or we are outside a
      // container. Every post prompts. This is the state a delegate panel most often forgets.
      return delegatePreset === 'unavailable' ? null : FAKE_ENTROPY
    },
  })

  const startedAt = Date.now()
  const ED = 10n ** 16n // matches DELEGATE_FACTS.existentialDeposit — 0.01 PAS at ETH-RPC 18dp
  const presets: Record<FakeDelegatePreset, { expiresAt: number | null; balance: bigint | null }> = {
    // Not set up. The first post authorises it — one prompt, then quiet.
    none: { expiresAt: null, balance: 0n },
    active: { expiresAt: startedAt + 87 * DAY, balance: ED * 50n },
    expiring: { expiresAt: startedAt + 4 * DAY, balance: ED * 40n },
    expired: { expiresAt: startedAt - 2 * DAY, balance: ED * 30n },
    lowfunds: { expiresAt: startedAt + 60 * DAY, balance: ED * 2n },
    unavailable: { expiresAt: null, balance: null },
  }

  /**
   * The balance the fake reports, injected by monkey-patching what `createDelegate` would have read
   * from chain. It is done through `noteAuthorization` plus a local override rather than by giving
   * `createDelegate` a "fake balance" parameter, because a production module should not carry a
   * parameter that only a test uses.
   */
  let fakeBalance = presets[delegatePreset].balance

  void (async () => {
    await delegate.refresh()
    delegate.noteAuthorization(presets[delegatePreset].expiresAt, 7_776_000)
  })()

  const delegationState = () => {
    const base = delegate.state()
    if (!base.derived) return base
    const funded = fakeBalance !== null && fakeBalance >= ED * 6n
    const now = Date.now()
    const live = base.expiresAt !== null && base.expiresAt > now
    return {
      ...base,
      balance: fakeBalance,
      active: live && funded,
      lowOnFunds: fakeBalance !== null && !funded,
      // Kept word-for-word in step with `delegate.ts` `explain()`. If they drift, the fake stops
      // testing the copy the real one produces, which is half of its job.
      reason: !live
        ? base.expiresAt === null
          ? 'not authorised yet — your next post will set it up with one extra signature'
          : 'the authorisation has expired — your next post will renew it'
        : !funded
          ? 'the posting key is out of funds — your next post will top it up'
          : `authorised for ${Math.round((base.expiresAt! - now) / DAY)} more days — announcing a post costs no prompt`,
    }
  }

  /* ------------------------------------------------------------------ API - */

  diag.step('container', caps === 'none' ? 'skip' : 'ok', 'fake backend — no real container involved')
  diag.step('sdk', 'skip', 'fake backend — no SDK loaded')
  diag.step('chain', provider ? 'ok' : 'skip', provider ? (rpcUrl as string) : 'no read provider (?rpc=off)')
  diag.step('connect', canWrite ? 'ok' : 'skip', canWrite ? FAKE_SELF_SS58 : 'read-only preview')
  diag.step('permChain', canWrite ? 'ok' : 'skip', 'simulated')
  diag.step('statements', canPushLive ? 'ok' : 'skip', canPushLive ? 'in-memory' : 'simulating no personhood proof')

  const blobs = new Map<string, Uint8Array>()
  let counter = 0
  let destroyed = false
  const assertLive = () => {
    if (destroyed) throw new Error('This backend has been destroyed.')
  }

  return {
    kind: 'fake',
    label:
      caps === 'none'
        ? 'fake backend (no container)'
        : caps === 'read'
          ? 'fake backend (read-only)'
          : caps === 'write'
            ? 'fake backend (can write, no live updates)'
            : 'fake backend',
    diagnostics: diag,

    capabilities: capabilities.get,
    onCapabilities: capabilities.subscribe,

    /**
     * Host-signed contract writes — present, and always refuses.
     *
     * ⚠️ NOT `null`, AND THE REASON IS SUBTLE. `null` reads as "this session cannot write", so the
     * publisher does not exist, so the composer is not rendered at all — which silently defeats the
     * ⭐ `?caps=write` scenario above, whose entire job is to prove the composer works for an account
     * with no personhood proof. A present-but-refusing writer keeps the composer on screen and its
     * error path exercisable.
     *
     * It cannot succeed, either: `readProvider` points at a REAL RPC by default, so a stub that
     * returned a transaction hash would be followed by a read of the real chain that never shows the
     * write — reported to the user as "submitted but not visible yet", which is a lie about a
     * transaction that was never submitted at all.
     */
    writeContract: canWrite
      ? async (_address, _abi, method, _args, label) => {
          assertLive()
          await sleep(jitter(latencyMs * 2))
          throw new Error(
            `The fake backend has no chain to submit to, so ${method} (${label}) cannot land. ` +
              'Everything up to this point — validation, encoding, the Bulletin write — did run. ' +
              'Open Plaza inside the Polkadot app to publish for real.',
          )
        }
      : null,

    /**
     * CASH payments — present, and every path refuses honestly.
     *
     * ⚠️ NOT `null`, for the same reason `writeContract` is not null: a null seam makes `canTip`
     * false everywhere, the tip control disappears, and the modal this scenario exists to exercise
     * can never be opened. Present-and-refusing keeps the whole UI reachable.
     *
     * ⛔ AND IT MUST NOT PRETEND TO SUCCEED. There is no host to prompt and no chain to settle on, so
     * a stub returning `{status:'sent'}` would show a success toast for money that never moved —
     * the single most dangerous lie this file could tell. Each method therefore reports the honest
     * unavailable state, and each reports a DIFFERENT one, so all three UI branches can be seen:
     *
     *   · balance      → `null`, i.e. "unknown" (NOT `0n` — see `PaymentsSeam.subscribeBalance`)
     *   · recipient    → resolves for a stable pretend subset, `null` otherwise, so the
     *                    "cannot be paid" copy is reachable without a real unmapped account
     *   · sendTip      → `failed`, naming the fake backend
     */
    payments: {
      subscribeBalance(listener) {
        let live = true
        // Asynchronous on purpose: a synchronous callback would hide the "balance unknown" first
        // paint that the real push subscription always goes through.
        void sleep(jitter(latencyMs)).then(() => {
          if (live) listener(null)
        })
        return () => {
          live = false
        }
      },

      async resolveRecipient(h160Address) {
        await sleep(jitter(latencyMs))
        const h160 = h160Address?.trim().toLowerCase()
        if (!h160 || !/^0x[0-9a-f]{40}$/.test(h160)) return null
        /**
         * ⭐ THE FAKE MIRRORS THE REAL CHAIN RATHER THAN INVENTING A RULE.
         *
         * `REAL_MAPPING` below is a genuine, measured `Revive.OriginalAccount` row from Paseo Asset
         * Hub — the H160 of the one account that has actually posted to Plaza, and the 32-byte
         * account it really resolves to (`5EJ3VTQLFVGHh2nrwpD9VyAFhYhhKnHxRTfGsGifFS4sx2rz`).
         * Reproduce with `node contracts/scripts/probe-tipping.mjs`.
         *
         * Everything else resolves to `null`, which is also true to life: the map holds 4236 entries
         * chain-wide but only accounts that have transacted appear in it. So the fake exercises BOTH
         * branches, and the payable one uses a destination that is not a fiction.
         *
         * ⛔ It is still never sent anywhere — `sendTip` below refuses unconditionally.
         */
        const REAL_MAPPING: Record<string, string> = {
          '0x18773c30d65de35027ac8cd19e98c0ddb9c44ef9':
            '0x62a4c0821686da4fe20ba29ceaf2a21aa404f0deddbafbb79dcd1c0b09903d2f',
        }
        return REAL_MAPPING[h160] ?? null
      },

      async sendTip(_destination, amount) {
        assertLive()
        await sleep(jitter(latencyMs * 2))
        return {
          status: 'failed',
          reason:
            `The fake backend has no host to authorise a payment and no chain to settle it, so ${amount} ` +
            'base units of CASH were NOT sent. Amount parsing, the recipient lookup and the ' +
            'confirmation flow all ran. Open Plaza inside the Polkadot app to tip for real.',
        }
      },
    },

    readProvider: () => provider,

    signer: () => ({
      // The fake has no host, so arm 1 is honestly empty. A UI that needs it must say "not
      // available in the preview" rather than silently doing nothing.
      host: {
        account: canWrite ? { address: FAKE_SELF_SS58, h160Address: FAKE_SELF_H160 } : null,
        signer: null,
        submit: null,
      },
      delegateSigner: canWrite ? delegate.signer() : null,
    }),

    // `null` when the preview cannot write, exactly as the real backend does: the delegate exists to
    // serve a WRITER, and there is no writer without an account. A panel offering to set up a
    // posting key for someone who cannot post is a control that can only fail.
    delegation: () => (canWrite ? delegationState() : null),
    onDelegation: (listener) => delegate.subscribe(() => listener(canWrite ? delegationState() : null)),

    async authorizeDelegate() {
      assertLive()
      if (!canWrite) return null
      await sleep(jitter(latencyMs * 3)) // a real one is a block inclusion, so it is not instant
      if (!delegate.state().derived) return delegationState()
      if (failRate > 0 && random() < failRate) {
        diag.step('delegate', 'skip', 'the authorisation was rejected. (simulated)')
        return delegationState()
      }
      fakeBalance = ED * 50n
      delegate.noteAuthorization(Date.now() + 90 * DAY, 7_776_000)
      return delegationState()
    },

    async revokeDelegate() {
      assertLive()
      await sleep(jitter(latencyMs * 3))
      // Revoked, not un-derived: the key still exists and can be authorised again. That distinction
      // is exactly what the panel has to communicate, so the fake has to hold it too.
      delegate.noteAuthorization(null)
      return true
    },

    async putBlob(bytes: Uint8Array, putOptions?: PutBlobOptions) {
      assertLive()
      if (!capabilities.get().canWrite) {
        throw new Error(capabilities.get().reason ?? 'This preview is read-only.')
      }
      await sleep(jitter(latencyMs * 2)) // a Bulletin write is the slow half of a send
      if (failRate > 0 && random() < failRate) throw new Error('Bulletin rejected the write. (simulated)')
      counter += 1
      const cid = `bafyfake${String(counter).padStart(5, '0')}${Math.floor(random() * 1e9).toString(36)}`
      blobs.set(cid, bytes.slice())
      diag.step(
        'bulletin',
        'ok',
        putOptions?.contentType ? `${cid} — ${bytes.length} bytes (${putOptions.contentType})` : cid,
      )
      return cid
    },

    // No host, so nothing to ask. Reported rather than silently skipped, because "did the allowance
    // step run?" is a question the panel is expected to answer in every mode.
    async ensureAllowance() {
      diag.step('allowance', 'skip', 'fake backend — no host to ask, so no dialog either')
      return null
    },
    async requestAllowanceAgain() {
      diag.step('allowance', 'skip', 'fake backend — no host to ask')
      return null
    },

    destroy() {
      destroyed = true
      blobs.clear()
    },
  }
}
