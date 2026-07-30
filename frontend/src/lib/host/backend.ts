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
// "posting needs the Polkadot app" — someone would eventually screenshot fake posts as evidence of
// real ones. The real backend handles the no-container case honestly, read-only, and says so.

import { createFakeBackend, type FakeCapabilityPreset, type FakeDelegatePreset } from './fake'
import { openHostSession } from './session'
import type { HostBackend } from './types'

/** Paseo Asset Hub ETH RPC — anonymous reads only. Nothing here signs. */
export const DEFAULT_RPC_URL = 'https://paseo-assethub-rpc.laissez-faire.trade'

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
  rpcUrl: string | null
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
    rpcUrl: params.get('rpc') === 'off' ? null : (params.get('rpc') || DEFAULT_RPC_URL),
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
      rpcUrl: selection.rpcUrl,
    })
  }

  return openHostSession({
    appName: options.appName,
    rpcUrl: selection.rpcUrl ?? DEFAULT_RPC_URL,
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
  { query: '?backend=fake&caps=live&rpc=off', what: 'No chain at all — nothing may crash.' },
]
