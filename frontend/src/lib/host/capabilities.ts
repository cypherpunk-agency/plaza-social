// The capability model. Pure — no SDK, no React.
//
// Four booleans and an address is the entire vocabulary the UI gets for "what can this session do".
// Everything else (personhood tier, allowance outcomes, which gateway answered) belongs in
// diagnostics, not in a flag a component branches on.
//
// See `types.ts` for why `canWrite` and `canPushLive` are separate and must stay separate. The
// short version: writing content needs a Bulletin authorization (no personhood required);
// announcing it live needs a statement-store allowance (personhood required). `canWrite &&
// !canPushLive` is the COMMON case, not an edge case, and the composer must never be gated on
// `canPushLive`.

import type { Capabilities } from './types'

/** The honest default: anyone can read, nobody can write until proven otherwise. */
export const READ_ONLY: Capabilities = {
  canRead: true,
  canWrite: false,
  canPushLive: false,
  address: null,
  insideHost: false,
  reason: 'No account is connected, so this session can read but not post.',
}

export interface CapabilityStore {
  get: () => Capabilities
  /**
   * Merge a patch and notify, but only if something actually changed — a store that re-emits an
   * identical snapshot turns every poll into a React render.
   */
  set: (patch: Partial<Capabilities>) => Capabilities
  subscribe: (listener: (capabilities: Capabilities) => void) => () => void
}

const same = (a: Capabilities, b: Capabilities) =>
  a.canRead === b.canRead &&
  a.canWrite === b.canWrite &&
  a.canPushLive === b.canPushLive &&
  a.address === b.address &&
  a.reason === b.reason &&
  a.liveReason === b.liveReason

export function createCapabilityStore(initial: Capabilities = READ_ONLY): CapabilityStore {
  let current = normalise(initial)
  const listeners = new Set<(capabilities: Capabilities) => void>()

  return {
    get: () => current,
    set(patch) {
      const next = normalise({ ...current, ...patch })
      if (same(current, next)) return current
      current = next
      for (const listener of listeners) {
        try {
          listener(current)
        } catch {
          // A throwing subscriber must not take the session down with it.
        }
      }
      return current
    },
    subscribe(listener) {
      listeners.add(listener)
      listener(current)
      return () => listeners.delete(listener)
    },
  }
}

/**
 * Enforce the two invariants the rest of the app is allowed to rely on:
 *
 *   1. `canPushLive` implies `canWrite`. Live announcement without a write path is meaningless —
 *      there is nothing to announce. The reverse does NOT hold and must not be enforced.
 *   2. A `reason` exists whenever `canWrite` is false, and is absent when it is true. A banner that
 *      says "you cannot post" with no explanation is worse than no banner.
 */
function normalise(capabilities: Capabilities): Capabilities {
  const canWrite = capabilities.canWrite && !!capabilities.address
  const canPushLive = canWrite && capabilities.canPushLive
  return {
    canRead: capabilities.canRead,
    canWrite,
    canPushLive,
    address: capabilities.address,
    // Passed through untouched: it is a fact about where the code is running, not a capability to be
    // derived from the others.
    insideHost: capabilities.insideHost,
    reason: canWrite
      ? undefined
      : (capabilities.reason ?? 'No account is connected, so this session can read but not post.'),
    liveReason: canPushLive
      ? undefined
      : (capabilities.liveReason ??
        (canWrite
          ? 'Live updates are unavailable, so new posts appear on a timer rather than instantly. Posting still works.'
          : undefined)),
  }
}
