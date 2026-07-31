// Backend selection. ONE place decides whether this page talks to a real host container or to the
// fake, and it decides from the URL.
//
// ⚠️ WHY A QUERY PARAMETER AND NOT `import.meta.env.DEV`.
//
// The fake's whole value is being reachable from the DEPLOYED bundle. Bulletin publishing is
// personhood-gated at 1/day on Lite personhood (architecture.md §1a), so "rebuild and redeploy to
// check a read-only banner" costs a whole day's quota. `?backend=fake` on the deployed URL costs
// nothing. Tying it to a build flag would throw that away.
//
// The default is the opposite of what you might expect: OUTSIDE a container we do NOT silently fall
// back to the fake. A page that quietly serves invented content is far worse than one that says
// "Plaza runs inside the Polkadot app" — someone would eventually screenshot fake posts as evidence
// of real ones. The real backend handles the no-container case honestly and says so.
//
// ⚠️ AND "HONESTLY" NOW MEANS EMPTY, NOT READ-ONLY. This comment used to promise a read-only page
// outside the container. Both read paths — Bulletin bodies and, since 2026-07-31, chain state — go
// through the host and have no substitute, so a plain browser tab loads nothing at all and says
// which step could not open. See `session.ts` and `gotchas.md` § THE SDK PATH IS THE ONLY PATH.

import { createFakeBackend, type FakeCapabilityPreset, type FakeDelegatePreset } from './fake'
import { openHostSession } from './session'
import type { HostBackend } from './types'

// ⛔ `DEFAULT_RPC_URL` IS GONE, DELETED 2026-07-31. DO NOT BRING IT BACK.
//
// It was `https://paseo-assethub-rpc.laissez-faire.trade` — a third-party domain, neither Parity's
// nor the community foundation's — and `session.ts` built an `ethers.JsonRpcProvider` from it
// BEFORE the container check, unconditionally, for every visitor. Every contract read in the app
// flowed through it. Inside the host container that is an external origin the user gets prompted
// about, exactly as they were prompted about the IPFS gateways. Chain reads now go through
// `@parity/product-sdk-contracts` `.query()` over the host provider; see `utils/contracts.ts`.
//
// There is nothing to configure any more, which is the point: an endpoint constant is an invitation
// to make it overridable, and `?rpc=<url>` was exactly that mistake (see `chainReads` below).

const CAPS: readonly FakeCapabilityPreset[] = ['none', 'read', 'write', 'live']
const DELEGATES: readonly FakeDelegatePreset[] = [
  'none',
  'active',
  'expiring',
  'expired',
  'lowfunds',
  'unavailable',
]

export interface BackendSelection {
  useFake: boolean
  caps: FakeCapabilityPreset
  delegate: FakeDelegatePreset
  latencyMs: number
  failRate: number
  seed: number
  /**
   * Whether to open the chain-read path at all. `false` only for `?rpc=off`.
   *
   * ⚠️ IT USED TO BE `rpcUrl: string | null` AND THAT WAS A SECURITY BUG, not just a layering one.
   * See `chainReads` in the parser below.
   */
  chainReads: boolean
}

/**
 * Parse the selection out of a query string. Pure, so it can be reasoned about without a browser.
 *
 * An unrecognised value falls back to the default rather than throwing. A typo in a debug flag must
 * not be able to take the app down, and `?caps=writ` silently behaving like `none` is a five-second
 * puzzle, while a white screen is a twenty-minute one.
 */
export function parseBackendSelection(search: string): BackendSelection {
  const params = new URLSearchParams(search)
  const pick = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const value = params.get(name)
    return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
  }
  /**
   * ⚠️ THE `=== null` CHECK IS LOAD-BEARING. `Number(params.get('latency'))` is `Number(null)`, which
   * is `0`, which is finite — so the obvious version silently replaced every default with zero. Caught
   * in the browser: `?backend=fake` came back with `latencyMs: 0`, `seed: 0`, which turns the fake's
   * simulated latency off entirely and makes the deterministic seed non-deterministic-looking. The
   * fake's whole value is behaving like the real thing, and a zero-latency fake does not.
   */
  const number = (name: string, fallback: number) => {
    const raw = params.get(name)
    if (raw === null || raw.trim() === '') return fallback
    const value = Number(raw)
    return Number.isFinite(value) ? value : fallback
  }

  return {
    useFake: params.get('backend') === 'fake',
    // `?caps` alone implies the fake, so `?backend=fake&caps=write` can be shortened — but the
    // default when only `backend=fake` is given is `none`, the most restrictive state, because a
    // preview that flatters itself is not a useful preview.
    caps: pick('caps', CAPS, 'none'),
    delegate: pick('delegate', DELEGATES, 'none'),
    latencyMs: number('latency', 90),
    failRate: number('fail', 0),
    seed: number('seed', 20260729),
    /**
     * ⛔ `?rpc=` IS A SWITCH, NOT A URL. `off` means NO CHAIN READS; ANY other value is IGNORED.
     *
     * ⚠️ THE NAME IS A FOSSIL AND THE PARAMETER NO LONGER NAMES ANYTHING. There is no RPC to point
     * at: chain reads go through the SDK over the host provider (`utils/contracts.ts`), and the
     * external endpoint this used to select was removed on 2026-07-31. The key is kept because
     * `?rpc=off` is documented in `FAKE_SCENARIOS`, has been typed into address bars, and still has
     * exactly the meaning it always had at the UI level: prove that a screen degrades honestly with
     * no chain behind it.
     *
     * ⛔ AND IT MUST NEVER AGAIN ACCEPT A VALUE. It used to be `params.get('rpc') || DEFAULT_RPC_URL`
     * — an arbitrary origin, no allowlist, no scheme check, taken straight off the query string.
     * `frontend/CLAUDE.md` records **[V]** that the dot.li shell FORWARDS QUERY AND HASH INBOUND, so
     * a shared `https://plaza-social.dot/?rpc=https://evil.example` pointed the whole app at an
     * attacker-chosen origin: fabricated heads, profiles and vote tallies, and arbitrary CIDs handed
     * to the host's preimage lookup.
     *
     * ⚠️ Do not "improve" this with an allowlist. There is nothing left for an allowlist to allow.
     */
    chainReads: params.get('rpc') !== 'off',
  }
}

export interface OpenBackendOptions {
  appName: string
  /** Defaults to `window.location.search`. Injectable so this is testable. */
  search?: string
}

/**
 * ⚠️ NEVER THROWS. A backend that could not open is still a backend — read-only, with a `reason`. The
 * app must come up regardless, because reading is the majority of what anyone does here and it needs
 * no wallet, no container and no signer.
 */
export async function openBackend(options: OpenBackendOptions): Promise<HostBackend> {
  const selection = parseBackendSelection(options.search ?? globalThis.location?.search ?? '')

  if (selection.useFake) {
    return createFakeBackend({
      caps: selection.caps,
      delegate: selection.delegate,
      latencyMs: selection.latencyMs,
      failRate: selection.failRate,
      seed: selection.seed,
      chainReads: selection.chainReads,
    })
  }

  return openHostSession({
    appName: options.appName,
    chainReads: selection.chainReads,
  })
}

/**
 * The debug URLs, in one place, so a reviewer can copy them and so they cannot rot silently.
 * Rendered by the settings screen.
 */
export const FAKE_SCENARIOS: ReadonlyArray<{ query: string; what: string }> = [
  { query: '?backend=fake', what: 'Outside a container. Read-only, and it says why.' },
  { query: '?backend=fake&caps=read', what: 'Inside a container, no account. Anonymous reader.' },
  {
    query: '?backend=fake&caps=write',
    what: '⭐ Can write, cannot push live — the no-personhood majority. The composer MUST work.',
  },
  { query: '?backend=fake&caps=live', what: 'Everything on. The happy path.' },
  { query: '?backend=fake&caps=live&delegate=none', what: 'Posting key derived but never authorised.' },
  { query: '?backend=fake&caps=live&delegate=active', what: 'Posting key live — writes cost no prompt.' },
  { query: '?backend=fake&caps=live&delegate=expiring', what: 'Inside the 7-day renewal window.' },
  { query: '?backend=fake&caps=live&delegate=expired', what: 'Authorisation lapsed; next post renews it.' },
  { query: '?backend=fake&caps=live&delegate=lowfunds', what: 'Authorised but out of fees.' },
  { query: '?backend=fake&caps=live&delegate=unavailable', what: 'No key at all; every post prompts.' },
  { query: '?backend=fake&caps=live&fail=1', what: 'Every write fails, so failure UI has something to render.' },
  {
    query: '?backend=fake&caps=live&rpc=off',
    what: 'No chain reads at all — every list is empty and nothing may crash.',
  },
]
