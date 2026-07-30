// The delegate key — arm 2 of the signer seam.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS IS, IN ONE PARAGRAPH
//
// Inside a Polkadot host container every transaction the host signs is a modal, unconditionally
// (architecture.md §5: `SmartContractAllowance` carries no signing key and all four of the host's
// signing handlers reach a modal with no allowance consulted). A chat room in which every line
// costs a modal is not a chat room. So the app derives a SECOND keypair, keeps it in memory, and
// asks the user — ONCE — to authorise it on chain as a delegate. After that the app signs contract
// calls with that key locally, and the host is never involved, so there is no prompt.
//
// ⚠️ THIS HALVES THE PROMPTS, IT DOES NOT REMOVE THEM. A post is TWO writes: the Bulletin store
// that holds the words, and the contract write that points at it. This file addresses the second
// only — and per architecture.md §5 a DELEGATE KEY CANNOT WRITE BULLETIN AT ALL: only the user's own
// personhood-backed product account can, because the route is
// `requestResourceAllocation([{tag:'BulletinAllowance'}])` granted to a verified user's product
// account, and a delegate key has neither a product account nor a path to one. The good news is
// that the Bulletin half is prompt-free for a different reason (the host keeps the granted
// `slotAccountKey` and signs with it silently), so the two halves together can be quiet. But do not
// promise "no more prompts" — the allowance grant and this authorisation are both real modals.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// ⚠️ THE HONEST SECURITY STORY. Read it before widening anything here.
//
//   The delegate's private key lives in this browser. It is DERIVED, via `deriveEntropy` (RFC-0007),
//   so it is reproducible from the user's wallet on the same device and product and is NEVER WRITTEN
//   TO DISK — but while a tab is open it is a signing key in JavaScript memory, and anything that can
//   run script in this origin can use it.
//
//   ⛔ This is the specific reason `deriveEntropy` replaced what this repo did before, which was
//   `ethers.Wallet.createRandom()` written to `localStorage` in PLAINTEXT (see the deleted
//   `utils/appWallet.ts`). That was worse in both directions: the key sat readable on disk forever,
//   AND clearing site data lost it irrecoverably along with the on-chain authorisation that pointed
//   at it — leaving an orphaned delegate row the user is still paying a storage deposit for and
//   which the app can never produce a key for again. A derived key survives a cleared cache and
//   leaves nothing behind when the tab closes.
//
//   Its blast radius is bounded BY DESIGN: the authorisation is scoped to this one user's rows, it
//   expires on chain, and one transaction revokes it early. The one thing it genuinely holds is the
//   small float we transfer to it so it can pay its own fees. That is a real, if tiny, loss if the
//   key leaks. Fund it deliberately small and say so in the UI rather than burying it.
//
// ⛔ NOTHING HERE MAY EVER BLOCK A WRITE. Every failure path resolves to "fall back to prompting",
// never to an exception the user sees. No key, no funds, an expired authorisation, a host that
// refuses to derive — all of them mean one extra modal, which is exactly where the app was before
// this file existed.

import { ethers } from 'ethers'

import { PRODUCT_NAMESPACE } from './container'
import { loadHost } from './sdk'
import type { DelegationState, Diagnostics } from './types'
import { describe, TIMEOUTS, unwrapParity, withTimeout } from './util'

/**
 * The `deriveEntropy` context, namespaced per product.
 *
 * ⚠️ CHANGING THIS STRING CHANGES THE KEY, which orphans the on-chain authorisation for the old one
 * — still valid, still costing the user a storage item, and pointing at a key the app can no longer
 * produce. Version it (`:v2`) only when you actually mean to rotate, and revoke the old delegate
 * first if you do.
 *
 * RFC-0007 derivation is deterministic per wallet AND namespaced per product by the host, so the
 * same user on the same wallet gets the same delegate on every load and a different product cannot
 * derive it. It is SILENT — no modal, no signature, no user interaction at all — which is the whole
 * reason it is the right primitive: a "set up posting" flow that needs a prompt before the prompt is
 * not an improvement.
 */
const ENTROPY_CONTEXT = `${PRODUCT_NAMESPACE}:contract-delegate:v1`

const SECOND = 1000
const DAY = 24 * 60 * 60 * SECOND

/** How long an authorisation is asked for. Clamped against the contract's own maximum by callers. */
const REQUEST_SECONDS = 90 * 24 * 60 * 60

/**
 * Slack subtracted from any contract-supplied maximum.
 *
 * ⛔ MEASURED FAILURE IN THE REFERENCE APP, NOT A PRECAUTION. Asking for exactly `maxSeconds`
 * reverted on a real wallet with `ExpiryTooFar(requested …042, max …028)` — 14 seconds over. We
 * compute the expiry from `Date.now()`; the contract compares it against `block.timestamp`, which is
 * the last authored block and trails wall time by up to a block before any browser clock drift is
 * added. An hour is far more slack than that and costs the user 89.96 days instead of 90.
 */
const CLOCK_SKEW_SLACK_SECONDS = 60 * 60

/**
 * Re-authorise this long BEFORE expiry, never after. A delegation that lapses mid-session turns the
 * next post into a failure rather than a prompt, and the user has no idea why.
 */
const RENEW_BEFORE_MS = 7 * DAY

/**
 * The existential deposit, in the units the pallet-revive ETH RPC reports.
 *
 * ⚠️ TWO DIFFERENT DECIMAL SCALES LIVE IN THIS CODEBASE AND CONFUSING THEM IS A 10^8 ERROR. Native
 * PAS is 10 decimals; the ETH-RPC facade that `ethers` talks to presents balances scaled to 18
 * decimals so that ordinary Ethereum tooling works. Everything in this file is in ETH-RPC (18dp)
 * units because everything in this file goes through `ethers`. 0.01 PAS is therefore `10n ** 16n`.
 *
 * It is a constant rather than a chain read because the ETH RPC exposes no equivalent of
 * `Balances.ExistentialDeposit` — that is a native-side constant. If the delegate ever moves to the
 * native submission path, read it instead of trusting this.
 */
const EXISTENTIAL_DEPOSIT = 10n ** 16n

/** "a few more writes left". ~6 × ED. Expressed in multiples of ED so a decimals change cannot silently 100× a transfer. */
const LOW_WATER = EXISTENTIAL_DEPOSIT * 6n
/** What a top-up aims for: ~25 delegated writes. Deliberately small — see the security note. */
const TOP_UP_TARGET = EXISTENTIAL_DEPOSIT * 50n

/**
 * Turn whatever the host hands back into exactly 32 valid bytes.
 *
 * `deriveEntropy` promises "entropy", not a length — the type is a bare `Uint8Array`. Hashing is the
 * only length-independent way to get the 32 bytes a secp256k1 key needs, and it is deterministic, so
 * the delegate stays stable across sessions whatever the host returns.
 *
 * The loop handles the (astronomically unlikely, but not impossible) case of a hash that is zero or
 * ≥ the curve order. Rejecting by re-hashing keeps the result deterministic, which a random retry
 * would not.
 */
function entropyToPrivateKey(entropy: Uint8Array): string {
  const CURVE_ORDER = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')
  let digest = ethers.keccak256(entropy)
  for (let i = 0; i < 8; i += 1) {
    const value = BigInt(digest)
    if (value > 0n && value < CURVE_ORDER) return digest
    digest = ethers.keccak256(digest)
  }
  throw new Error('could not derive a valid key from the host entropy')
}

export interface DelegateOptions {
  diagnostics: Diagnostics
  /** Anonymous read provider; the delegate signer is connected to it so it can read its own nonce. */
  provider: () => ethers.Provider | null
  /**
   * Overrides derivation. Used ONLY by the fake backend, which has no host to derive from — it
   * passes a fixed seed so the fake delegate is stable across reloads and obviously not a real key.
   */
  deriveOverride?: () => Promise<Uint8Array | null>
}

export interface Delegate {
  state: () => DelegationState
  subscribe: (listener: (state: DelegationState) => void) => () => void
  /** The ethers signer, connected to the read provider. `null` until derived. Never throws. */
  signer: () => ethers.Signer | null
  /** Derive if needed and read balance. Never throws. */
  refresh: () => Promise<DelegationState>
  /**
   * The ONE prompt. Both steps are INJECTED rather than implemented here, because the contract
   * interface is owned elsewhere and this module must not grow a dependency on an ABI.
   *
   * @param authorizeOnChain records `(user, delegate, expiry)`. Whatever performs it will prompt.
   * @param topUp transfers the float. Skipped when the delegate is already funded, so a routine
   *   90-day renewal moves no money at all.
   */
  authorize: (options: {
    authorizeOnChain: (delegateAddress: string, expirySeconds: number) => Promise<unknown>
    topUp?: (delegateAddress: string, amount: bigint) => Promise<unknown>
    maxSeconds?: number
    force?: boolean
  }) => Promise<DelegationState>
  /** End it early. Injected for the same reason as `authorize`. Never throws. */
  revoke: (revokeOnChain: (delegateAddress: string) => Promise<unknown>) => Promise<boolean>
  /**
   * Record that the on-chain authorisation is known good until `expiresAt`. Called by whatever read
   * the contract, because this module deliberately does not know how to.
   */
  noteAuthorization: (expiresAt: number | null, maxSeconds?: number) => void
  /**
   * Optimistically decrement the tracked balance after a delegated write, so "running low" is
   * reached BEFORE a write fails for want of a fee rather than after.
   */
  noteSpend: () => void
}

export function createDelegate({ diagnostics: diag, provider, deriveOverride }: DelegateOptions): Delegate {
  let wallet: ethers.Wallet | null = null
  let derivationFailed = false
  let expiresAt: number | null = null
  let maxSeconds = REQUEST_SECONDS
  let balance: bigint | null = null
  let deriving: Promise<ethers.Wallet | null> | null = null

  const listeners = new Set<(state: DelegationState) => void>()

  const hasFunds = () => balance !== null && balance >= LOW_WATER

  function explain(): string {
    const now = Date.now()
    if (!wallet) {
      return derivationFailed
        ? 'no local posting key — every post will ask you to sign'
        : 'setting up a local posting key'
    }
    if (!expiresAt) return 'not authorised yet — your next post will set it up with one extra signature'
    if (expiresAt <= now) return 'the authorisation has expired — your next post will renew it'
    if (!hasFunds()) return 'the posting key is out of funds — your next post will top it up'
    const days = Math.max(0, Math.round((expiresAt - now) / DAY))
    // "announcing", not "posting": the Bulletin store is a separate write. See the header.
    return `authorised for ${days} more day${days === 1 ? '' : 's'} — announcing a post costs no prompt`
  }

  function state(): DelegationState {
    const now = Date.now()
    return {
      derived: !!wallet,
      address: wallet?.address ?? null,
      expiresAt,
      active: !!wallet && !!expiresAt && expiresAt > now && hasFunds(),
      renewDue: !!expiresAt && expiresAt - now < RENEW_BEFORE_MS,
      balance,
      existentialDeposit: EXISTENTIAL_DEPOSIT,
      lowOnFunds: !!wallet && balance !== null && !hasFunds(),
      maxSeconds,
      reason: explain(),
    }
  }

  function publish() {
    const snapshot = state()
    for (const listener of listeners) {
      try {
        listener(snapshot)
      } catch {
        // A throwing subscriber must not take the session down with it.
      }
    }
  }

  async function ensureWallet(): Promise<ethers.Wallet | null> {
    if (wallet || derivationFailed) return wallet
    deriving ??= (async () => {
      diag.step('delegate', 'running', 'deriving a local posting key')
      try {
        let entropy: Uint8Array | null
        if (deriveOverride) {
          entropy = await deriveOverride()
        } else {
          const host = await loadHost()
          if (host?.__parityStub === true) throw new Error('the Products SDK is not installed in this build')
          entropy = unwrapParity<Uint8Array>(
            await withTimeout(
              host.deriveEntropy(new TextEncoder().encode(ENTROPY_CONTEXT)),
              TIMEOUTS.entropy,
              'Entropy derivation',
            ),
            'Entropy derivation',
          )
        }
        if (!entropy) throw new Error('the host returned no entropy')
        wallet = new ethers.Wallet(entropyToPrivateKey(entropy))
        // Records the DERIVATION only. Authorisation state belongs to `state().reason`, which is
        // live; a diagnostics line saying "not authorised yet" would go stale the moment it was and
        // then contradict the panel two inches above it.
        diag.step('delegate', 'ok', `${wallet.address} derived`)
        return wallet
      } catch (error) {
        derivationFailed = true
        diag.step(
          'delegate',
          'skip',
          `${describe(error)} — posting still works, with a prompt each time`,
        )
        return null
      } finally {
        publish()
      }
    })()
    return deriving
  }

  async function readBalance() {
    const rpc = provider()
    if (!wallet || !rpc) return
    try {
      balance = await withTimeout(rpc.getBalance(wallet.address), 15_000, 'Delegate balance')
    } catch (error) {
      // A balance we could not read is UNKNOWN, not zero. Zeroing it would report "out of funds" for
      // a perfectly funded key and send every write down the prompting path.
      diag.step('delegate', 'skip', `could not read the posting key's balance: ${describe(error)}`)
    }
  }

  return {
    state,

    subscribe(listener) {
      listeners.add(listener)
      listener(state())
      return () => listeners.delete(listener)
    },

    signer() {
      if (!wallet) return null
      const rpc = provider()
      return rpc ? wallet.connect(rpc) : wallet
    },

    async refresh() {
      await ensureWallet()
      await readBalance()
      publish()
      return state()
    },

    async authorize({ authorizeOnChain, topUp, maxSeconds: contractMax, force = false }) {
      if (!(await ensureWallet())) return state()
      await readBalance()

      if (typeof contractMax === 'number' && contractMax > 0) maxSeconds = contractMax

      const now = Date.now()
      if (!force && expiresAt && expiresAt - now > RENEW_BEFORE_MS && hasFunds()) return state()

      // ⚠️ Reading the contract maximum is NOT sufficient on its own — see CLOCK_SKEW_SLACK_SECONDS.
      const ceiling = Math.max(maxSeconds - CLOCK_SKEW_SLACK_SECONDS, Math.floor(maxSeconds / 2))
      const seconds = Math.min(REQUEST_SECONDS, ceiling)

      diag.step(
        'delegate',
        'running',
        `authorising ${wallet!.address} for ${Math.round(seconds / 86_400)} days`,
      )
      try {
        await authorizeOnChain(wallet!.address, seconds)
        // Provisional. Whatever owns the contract read should call `noteAuthorization` with the
        // value the CONTRACT stored — the expiry we asked for and the expiry it recorded are
        // different facts and the panel must eventually show the second one.
        expiresAt = now + seconds * SECOND

        if (topUp && !hasFunds()) {
          const amount = TOP_UP_TARGET - (balance ?? 0n)
          if (amount > 0n) {
            await topUp(wallet!.address, amount)
            balance = (balance ?? 0n) + amount
          }
        }
        diag.step('delegate', 'ok', `${wallet!.address} authorised — announcing now costs no prompt`)
      } catch (error) {
        diag.step(
          'delegate',
          'skip',
          `the authorisation did not go through (${describe(error)}) — posting still works, with a prompt each time`,
        )
      }
      await readBalance()
      publish()
      return state()
    },

    async revoke(revokeOnChain) {
      if (!wallet) return false
      diag.step('delegate', 'running', `revoking ${wallet.address}`)
      try {
        await revokeOnChain(wallet.address)
        // Revoked, not un-derived: the key still exists and can be authorised again. That
        // distinction is exactly what the UI has to communicate, so the state has to hold it.
        expiresAt = null
        diag.step('delegate', 'ok', 'revoked. Posting still works and will prompt each time.')
        publish()
        return true
      } catch (error) {
        diag.step('delegate', 'fail', `revoke failed: ${describe(error)}`)
        return false
      }
    },

    noteAuthorization(next, nextMax) {
      expiresAt = next && next > 0 ? next : null
      if (typeof nextMax === 'number' && nextMax > 0) maxSeconds = nextMax
      publish()
    },

    noteSpend() {
      if (balance === null) return
      const cost = EXISTENTIAL_DEPOSIT * 2n
      balance = balance > cost ? balance - cost : 0n
      publish()
    },
  }
}

/** Exported for UI copy and tests, so the two cannot drift. */
export const DELEGATE_FACTS = {
  entropyContext: ENTROPY_CONTEXT,
  requestSeconds: REQUEST_SECONDS,
  renewBeforeMs: RENEW_BEFORE_MS,
  existentialDeposit: EXISTENTIAL_DEPOSIT,
  lowWater: LOW_WATER,
  topUpTarget: TOP_UP_TARGET,
} as const
