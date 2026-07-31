// Pure layer: an ordered record of what session setup actually did, so a failure on a phone
// reports itself instead of needing a debugger we cannot attach.
//
// The write path only runs inside a host container, so when it breaks it breaks where there is no
// console. This record is the whole of our observability.

import type { Diagnostics, DiagnosticStep } from './types'

/**
 * Listed in EXECUTION ORDER, because the panel is read top-to-bottom by a human trying to work out
 * which step refused. Permissions before allocations, because a denied permission makes an
 * allocation moot.
 */
export const STEP_LABELS: Record<string, string> = {
  container: 'Inside a Polkadot host container',
  sdk: 'Products SDK loaded',
  connect: 'Wallet connected',
  account: 'Product account resolved',
  personhood: 'Personhood tier (lite and full both count)',
  // ⚠️ CORRECTED 2026-07-30. This used to read "`StatementSubmit` and `PreimageSubmit` are NOT
  // requested: neither is ever read by the deployed host … DO NOT PUT THEM BACK." That conclusion was
  // inherited verbatim from yolodot, and yolodot's own later audit REFUTES it for `PreimageSubmit`:
  // the TruAPI sandbox gates `remote_preimage_submit` on it, one layer above where the host bundle was
  // originally grepped. Since the preimage channel is the write path that actually works on an
  // `rpc-gateway`-mode host, that permission is load-bearing, not decorative.
  permChain: 'ChainSubmit permission (required to announce)',
  permPreimage: 'PreimageSubmit permission (the fallback write path needs it)',
  allowance: 'Resource allocation — asked at your first write, then cached',
  bulletin: 'Bulletin write path',
  // The fallback that carries the bytes when the host will not open a Bulletin chain client at all.
  preimage: 'Bulletin preimage channel (fallback write path)',
  /**
   * ⭐ THE READ PATH, AND THERE IS ONLY ONE. Post bodies are fetched through the host's preimage
   * lookup subscription (`@parity/product-sdk-cloud-storage`), never over HTTP.
   *
   * This step exists because the alternative was invisible: until 2026-07-31 bodies came from four
   * public IPFS gateways, which made the host prompt a real user for permission to reach
   * `devnet-ipfs.api.polkadotcommunity.foundation`. The gateways are gone (`lib/bulletin.ts`), so
   * `fail` here means NO post body will load — a state that must be legible on a phone, since it is
   * indistinguishable on screen from "all this content expired".
   *
   * The detail column carries running counters rather than a line per read; see `session.ts`
   * `installBulletinReader` for why that is throttled.
   */
  read: 'Bulletin content reads (host preimage lookup — no external gateway)',
  bulletinAuth: 'Bulletin authorization (quota)',
  statements: 'Statement store connected (live updates only)',
  /**
   * ⭐ THE CHAIN READ PATH, AND THERE IS ONLY ONE — the SDK's. Heads, profiles, vote tallies and the
   * follow graph are `product-sdk-contracts` `.query()` dry runs routed through the host provider.
   *
   * ⚠️ THIS STEP IS THE SOURCE OF TRUTH FOR `capabilities.canRead`, and it changed meaning on
   * 2026-07-31. It used to read "Asset Hub read provider ready" and reported nothing more than
   * "an `ethers.JsonRpcProvider` was constructed" — against a third-party HTTP endpoint, for every
   * visitor, before the container check. `fail` here now means NO list in the app will populate,
   * which is the normal state OUTSIDE the Polkadot app and an error inside it.
   *
   * The detail column carries running counters rather than a line per read; see `session.ts`
   * `reportChainRead` for why that is throttled.
   */
  chain: 'Chain reads (product-sdk-contracts .query — no external RPC)',
  // "Announcing", not "posting": storing the words is a separate signature. The delegate key only
  // removes the head write's prompt.
  delegate: 'Posting key (delegate) — announcing costs one prompt per 90 days, not one per post',
  // Arm 1. Any host-signed NATIVE extrinsic goes through here, so it is deliberately generic — the
  // detail column carries the caller's label. Registered so it renders with a name and sorts here
  // rather than jumping to the top on `ORDER.indexOf(...) === -1`.
  submit: 'Host-signed transaction (one prompt each)',
  headwrite: 'Head pointer written',
  publish: 'Last publish result',
}

const ORDER = Object.keys(STEP_LABELS)

export function createDiagnostics(): Diagnostics {
  const steps = new Map<string, DiagnosticStep>()
  const listeners = new Set<(steps: DiagnosticStep[]) => void>()

  const list = () =>
    [...steps.values()].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id))

  const emit = () => {
    const snapshot = list()
    for (const listener of listeners) listener(snapshot)
  }

  return {
    step(id, status, detail = '') {
      steps.set(id, { id, label: STEP_LABELS[id] ?? id, status, detail: String(detail ?? '') })
      emit()
    },
    get: (id) => steps.get(id) ?? null,
    list,
    hasFailure: () => [...steps.values()].some((step) => step.status === 'fail'),
    reset() {
      steps.clear()
      emit()
    },
    subscribe(listener) {
      listeners.add(listener)
      listener(list())
      return () => listeners.delete(listener)
    },
  }
}

/**
 * ⭐ THE ONE RECORD THE REAL SESSION WRITES INTO, CREATED AT MODULE LOAD.
 *
 * ⚠️ IT EXISTS SO THE BOOT CONSOLE CAN STREAM FROM t=0, AND THAT IS THE WHOLE REASON.
 *
 * `openHostSession` used to call `createDiagnostics()` inside itself, and `useHostSession` can only
 * subscribe after `openBackend(...)` RESOLVES — so every handshake step (container, sdk, connect,
 * account, permChain, bulletin, chain) was already in the PAST before React could read one.
 * `BootConsole` could therefore show nothing but its own clock for the whole connecting window,
 * which is precisely the window it was built to explain. Its header says the fix is "one line in
 * `lib/host/`": have the session publish its `Diagnostics` object synchronously. This is that line.
 *
 * ⭐ NO SHAPE CHANGE WAS NEEDED. `DiagnosticStep` and `Diagnostics` are untouched — `subscribe()`
 * already replays the current list to a new listener, so a subscriber that arrives late still sees
 * everything, and one that arrives at t=0 sees each step as it lands. The only thing that was wrong
 * was WHEN the object came into existence.
 *
 * ⚠️ A MODULE SINGLETON IS THE HONEST SHAPE HERE, not a shortcut: `useHostSession` opens exactly one
 * backend per page (its own header explains why a second one would double every permission round
 * trip), so there is exactly one session to record. `openHostSession` calls `reset()` on entry, so a
 * re-open starts clean.
 *
 * ⚠️ IN REACT STRICT MODE (dev only) the mount effect runs twice, so two overlapping sessions write
 * into this one record and the second `reset()` clears the first's lines. The step ids are identical,
 * so the visible result is the later session's record — which is also the one that survives. Do not
 * "fix" this by going back to a per-session object; that reintroduces the t=0 gap.
 *
 * ⛔ THE FAKE BACKEND DOES NOT USE THIS. `fake.ts` still makes its own record, so `useHostSession`
 * checks identity and swaps its subscription when the opened backend brought a different one.
 */
export const sessionDiagnostics: Diagnostics = createDiagnostics()

/** A no-op record, so a caller that reports nothing needs no null checks at every call site. */
export const nullDiagnostics: Diagnostics = {
  step: () => {},
  get: () => null,
  list: () => [],
  hasFailure: () => false,
  reset: () => {},
  subscribe: (listener) => {
    listener([])
    return () => {}
  },
}
