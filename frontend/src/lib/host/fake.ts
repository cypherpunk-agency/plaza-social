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

import { createCapabilityStore } from './capabilities'
import { createDelegate } from './delegate'
import { createDiagnostics } from './diagnostics'
import { setBulletinSource } from '../bulletin'
import { normaliseH160 } from '../recipient'
import type { AbiEntry, ChainReader, HostBackend, PutBlobOptions, RecipientResolution } from './types'
import { sleep } from './util'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Shaped like an SS58 address so truncation and copy-to-clipboard look right. */
export const FAKE_SELF_SS58 = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty'
/** …and like an 0x address, because the contract layer reads `msg.sender`, not an SS58 string. */
export const FAKE_SELF_H160 = '0x9e2a3f4b5c6d7e8f90a1b2c3d4e5f60718293a4b'

/**
 * Tipping THIS address makes `resolveRecipient` report `unavailable` — "we could not ask the chain"
 * — as opposed to `unmapped`, "the chain says there is no mapping". Lowercase because the seam
 * lowercases before comparing.
 *
 * It is a fixture, not a user: no other fake data references it, so the only way to reach it is to
 * type it into a tip. That is deliberate — the branch it exercises is the one that spent weeks
 * masquerading as a statement about the recipient.
 */
export const FAKE_LOOKUP_BROKEN_H160 = '0x000000000000000000000000000000000000dead'

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
   * Whether to offer a chain reader at all. `false` (i.e. `?rpc=off`) offers none.
   *
   * ⚠️ THIS USED TO BE `rpcUrl`, DEFAULTING TO A REAL PUBLIC ENDPOINT, and that default was itself a
   * violation: `?backend=fake` constructed an `ethers.JsonRpcProvider` against
   * `paseo-assethub-rpc.laissez-faire.trade` and read the LIVE chain. It was justified by the
   * feature hooks not being migrated yet — they are now — and it had a second, uglier consequence:
   * the fake served real heads whose bodies it could not produce, so a preview rendered real
   * people's threads as "(content no longer available)". See `chainReader` below.
   */
  chainReads?: boolean
}

/**
 * The fake chain. ⛔ IT ANSWERS STRUCTURALLY, AND IT ANSWERS EMPTY.
 *
 * Every method is decoded from the ABI's declared outputs and answered with that type's zero: an
 * empty `tuple[]`, `0n`, `false`, the zero address, `""`. Three properties make that the right
 * choice rather than a cop-out:
 *
 *  1. **It invents no content.** The preceding version read the REAL chain, so a fake session showed
 *     real threads by real authors with bodies it could not serve. `fake.ts` already refuses to
 *     synthesise bodies for CIDs it did not write (see the Bulletin read path below); this is the
 *     same refusal for the other half.
 *  2. **The composer path still runs end to end.** `publish()` reads `headOf` first — an empty head
 *     means `prev: null`, which is exactly a first post — then stores the body, then hits the fake's
 *     deliberate `writeContract` refusal. That is the ⭐ `?caps=write` scenario, unchanged.
 *  3. **A method the ABI does not have still fails loudly**, in JS, naming the method — the
 *     friendliest disguise of this codebase's most common bug.
 *
 * ⚠️ An empty board is therefore what `?backend=fake` looks like until you post in it. That is a
 * real cost of having no second read path, and it is the honest one.
 */
function createFakeChainReader(latency: () => Promise<void>): ChainReader {
  const zero = (type: string | undefined, components: readonly AbiEntry[] | undefined): unknown => {
    const t = type ?? ''
    if (t.endsWith('[]')) return []
    if (t === 'bool') return false
    if (t === 'string') return ''
    if (t === 'address') return '0x0000000000000000000000000000000000000000'
    if (t.startsWith('bytes')) {
      const size = Number(t.slice(5))
      return Number.isFinite(size) && size > 0 ? `0x${'00'.repeat(size)}` : '0x'
    }
    if (/^u?int(\d+)?$/.test(t)) {
      // viem hands back a `number` for widths it can hold exactly and a `bigint` above that. The
      // hooks call `Number(...)` either way, but `ref.movedAt > 0n` does NOT survive a number, so
      // the boundary has to be reproduced rather than approximated.
      const bits = Number(/^u?int(\d+)?$/.exec(t)?.[1] ?? '256')
      return bits <= 48 ? 0 : 0n
    }
    if (t === 'tuple') {
      const out: Record<string, unknown> = {}
      for (const c of components ?? []) {
        out[String((c as { name?: string }).name ?? '')] = zero(
          (c as { type?: string }).type,
          (c as { components?: readonly AbiEntry[] }).components,
        )
      }
      return out
    }
    return null
  }

  return {
    label: 'fake backend (no chain — every read answers empty)',
    async read(_address, abi, method) {
      await latency()
      const entry = abi.find(
        (e) => (e as { type?: string }).type === 'function' && (e as { name?: string }).name === method,
      ) as { outputs?: Array<{ name?: string; type?: string; components?: AbiEntry[] }> } | undefined
      if (!entry) throw new Error(`the ABI has no readable method "${method}"`)

      const outputs = entry.outputs ?? []
      if (outputs.length === 0) return undefined
      if (outputs.length === 1) return zero(outputs[0]?.type, outputs[0]?.components)
      // Several outputs come back keyed by name, exactly as `product-sdk-contracts` decodes them —
      // so `utils/contracts.ts` normalisation is exercised by the fake too, not bypassed.
      const out: Record<string, unknown> = {}
      outputs.forEach((o, i) => {
        out[o.name || `_${i}`] = zero(o.type, o.components)
      })
      return out
    },
  }
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
    chainReads = true,
  } = options

  const diag = createDiagnostics()
  const random = rng(seed)
  const jitter = (base: number) => Math.max(0, Math.round(base * (0.6 + random() * 0.9)))

  const chainReader = chainReads ? createFakeChainReader(() => sleep(jitter(latencyMs))) : null

  const canWrite = caps === 'write' || caps === 'live'
  const canPushLive = caps === 'live'

  const capabilities = createCapabilityStore({
    // ⚠️ Was `caps !== 'none' || true`, i.e. an unconditional `true` with a misleading left operand —
    // "reading never depends on a container" was the assumption the whole external RPC rested on.
    // It does now. The fake STANDS IN for the container, so the reader exists unless `?rpc=off`.
    canRead: !!chainReader,
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
      //
      // ⚠️ REWRITTEN 2026-07-31 with `explain()`: the old copy promised "announcing a post costs no
      // prompt" and "your next post will top it up", both of which described the removed
      // ethers-signing arm. `funded` is kept in the state (the fake is the only place a funded
      // delegate can be simulated at all) but no longer changes the sentence, because being funded
      // does not currently change what the app can do.
      reason: !live
        ? base.expiresAt === null
          ? 'a posting key exists but is not authorised — every post asks you to sign'
          : 'the authorisation has expired — every post asks you to sign'
        : `authorised on chain for ${Math.round((base.expiresAt! - now) / DAY)} more days — but the ` +
          'key cannot be funded or submitted from here yet, so posts still ask you to sign',
    }
  }

  /* ------------------------------------------------------------------ API - */

  diag.step('container', caps === 'none' ? 'skip' : 'ok', 'fake backend — no real container involved')
  diag.step('sdk', 'skip', 'fake backend — no SDK loaded')
  diag.step(
    'chain',
    chainReader ? 'ok' : 'skip',
    chainReader ? chainReader.label : 'chain reads disabled (?rpc=off) — every list is empty',
  )
  diag.step('connect', canWrite ? 'ok' : 'skip', canWrite ? FAKE_SELF_SS58 : 'read-only preview')
  diag.step('permChain', canWrite ? 'ok' : 'skip', 'simulated')
  diag.step('statements', canPushLive ? 'ok' : 'skip', canPushLive ? 'in-memory' : 'simulating no personhood proof')

  const blobs = new Map<string, Uint8Array>()
  let counter = 0
  let destroyed = false
  const assertLive = () => {
    if (destroyed) throw new Error('This backend has been destroyed.')
  }

  /* ------------------------------------------------- the Bulletin READ path - */
  //
  // ⭐ THE FAKE IS NOW THE DEV SEAM FOR READS AS WELL AS WRITES, because there is no longer an HTTP
  // path to fall back on: post bodies come through the host's preimage lookup or not at all
  // (`lib/bulletin.ts`). So `?backend=fake` has to answer reads too, or localhost shows a board of
  // holes.
  //
  // ⛔ AND IT SERVES ONLY WHAT THIS SESSION WROTE. Not a fixture generator, not a deterministic
  // body for any CID somebody asks for. Synthesising bodies would put invented words under a real
  // author's name on a screen somebody will eventually screenshot; `backend.ts` refuses that trade
  // for the whole backend and this is the same refusal one layer down.
  //
  // ⚠️ THAT USED TO BITE HARDER THAN IT DOES NOW. `readProvider` pointed at the REAL chain, so a
  // fake session walked real heads and rendered real people's threads as "(content no longer
  // available)". The chain reader is fake too as of 2026-07-31 (see `createFakeChainReader`), so the
  // board simply starts empty and both halves of the preview are consistent about what they know.
  // Compose a thread in the same session and its body reads back correctly.
  //
  // `caps=none` deliberately installs NOTHING: it simulates a page outside the container, which is
  // now a page that genuinely cannot read a body, and the fake exists to reproduce failure modes.
  if (caps === 'none') {
    setBulletinSource(null)
    diag.step('read', 'fail', 'fake backend — simulating a page outside the Polkadot app, where no post body can load')
  } else {
    setBulletinSource({
      label: 'fake backend (this session only)',
      async read(cid) {
        await sleep(jitter(latencyMs))
        const bytes = blobs.get(cid)
        if (!bytes) {
          throw new Error(
            `The fake backend has no Bulletin and serves only what this session wrote, so ${cid} ` +
              'is unavailable. This is what an expired body looks like — compose a post to see the ' +
              'loaded state.',
          )
        }
        return bytes.slice()
      },
    })
    diag.step('read', 'ok', 'fake backend — serves only the objects this session wrote')
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
     * It must not succeed, either: a stub returning a transaction hash would be followed by a read
     * that never shows the write — reported to the user as "submitted but not visible yet", which is
     * a lie about a transaction that was never submitted at all.
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
     *   · recipient    → `ready` for one real measured mapping, `unmapped` for anything else, and
     *                    `unavailable` for one reserved address, so ALL THREE branches of
     *                    `RecipientResolution` can be seen without a host
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

      async resolveRecipient(h160Address): Promise<RecipientResolution> {
        await sleep(jitter(latencyMs))
        // Same normaliser the real seam uses, so a shape the fake accepts is one the host would.
        const h160 = normaliseH160(h160Address)
        if (!h160) {
          return { status: 'unavailable', reason: `"${h160Address}" is not a 20-byte address.` }
        }
        /**
         * ⭐ ONE ADDRESS IS RESERVED FOR THE `unavailable` BRANCH, and it exists because that branch
         * is the one that was invisible for weeks. The real lookup could not run inside a host at
         * all (`state_getStorage` is not a method the container's PAPI bridge serves) and the UI
         * rendered that failure as "this person has never transacted". A scenario that can only
         * produce `ready` and `unmapped` cannot catch that class of bug again.
         */
        if (h160 === FAKE_LOOKUP_BROKEN_H160) {
          return {
            status: 'unavailable',
            reason:
              'The fake backend has no chain, so `Revive.OriginalAccount` cannot be read for this ' +
              'address. This is the "we could not ask" branch — note that it says nothing about ' +
              'the recipient.',
          }
        }
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
        const destination = REAL_MAPPING[h160]
        return destination ? { status: 'ready', destination } : { status: 'unmapped' }
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

    chainReader: () => chainReader,

    signer: () => ({
      // The fake has no host, so arm 1 is honestly empty. A UI that needs it must say "not
      // available in the preview" rather than silently doing nothing.
      // (There is no arm 2 any more — see `types.ts` `SignerSeam`.)
      host: {
        account: canWrite ? { address: FAKE_SELF_SS58, h160Address: FAKE_SELF_H160 } : null,
        signer: null,
        submit: null,
      },
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
      // Cleared before the blobs it reads from, so a read can never observe an emptied source as a
      // torn-down one — see `session.ts` `destroy`.
      setBulletinSource(null)
      blobs.clear()
    },
  }
}
