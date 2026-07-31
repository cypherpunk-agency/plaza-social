// Small pure helpers shared by every module in this directory. No SDK, no React, no ethers.

/**
 * A hung host call is the worst failure mode available to us: on a phone, nothing moves and nothing
 * explains why. Every single host call in this directory goes through here.
 */
export function withTimeout<T>(promise: PromiseLike<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s.`)),
        ms,
      )
    }),
  ])
}

export const TIMEOUTS = {
  connect: 20_000,
  /**
   * One contract `.query()` dry-run.
   *
   * ⚠️ THE FIRST READ OF A SESSION PAYS FOR THE CHAIN CLIENT TOO — the Asset Hub descriptor chunk
   * plus the chainHead subscription — so this is deliberately generous rather than tuned to the
   * steady-state cost, which is one JSON-RPC message on an already-open host socket. A read that
   * takes longer than this is a hung host call, and a hung host call on a phone is the worst
   * failure mode available to us; better to surface it as a failed poll (the last good list stays
   * on screen — see `lib/poll.ts`) than to wait for ever.
   */
  read: 20_000,
  permission: 30_000,
  allowance: 30_000,
  statements: 30_000,
  entropy: 20_000,
  publish: 60_000,
  store: 120_000,
  write: 60_000,
} as const

/**
 * Flatten anything throwable into a sentence.
 *
 * ⚠️ `error.value?.reason` is not defensive noise. The SDK's neverthrow-flavoured results carry
 * their payload under `.value`, and a rejection that has been unwrapped one level too few arrives
 * looking like `{ value: { reason: '…' } }` with no `.message` at all. Without that branch the
 * single most informative string in the whole failure — the host's free-text `reason` — is
 * replaced by `[object Object]`.
 */
export function describe(error: unknown): string {
  if (!error) return 'unknown error'
  if (typeof error === 'string') return error
  const e = error as { name?: string; message?: string; reason?: string; value?: { reason?: string } }
  const name = e.name && e.name !== 'Error' ? `${e.name}: ` : ''
  const reason = e.value?.reason ?? e.reason
  return `${name}${e.message ?? reason ?? JSON.stringify(error)}`
}

/** "2h 14m" / "24h" / "3m". Read by a human on a phone; sub-minute precision is noise. */
export function describeAge(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * The `@parity/result` shape: `{ ok: true, value }` | `{ ok: false, error }`.
 *
 * ⚠️ THE SDK SHIPS TWO DIFFERENT `Result` TYPES AND MIXING THEM IS A KNOWN TRAP.
 *
 *   · `@parity/result` — a plain discriminated union. You read `.ok`, then `.value` / `.error`.
 *     This is what `@parity/product-sdk-host` returns (`requestPermission`, `deriveEntropy`,
 *     `requestResourceAllocation`, `broadcastTransaction`) and what `SignerManager.connect()`
 *     returns.
 *   · neverthrow's `ResultAsync` — has NO `.ok` property. You must `await` it and then `.match()`,
 *     or `.isOk()` on the awaited value. Parts of the contracts/tx packages use this.
 *
 * The failure mode is silent and total: `result.ok` on a neverthrow `ResultAsync` is `undefined`,
 * so `if (!result.ok) throw` throws on every SUCCESS, and `if (result.ok)` skips every success.
 * Neither reads as a type error if the value is `any` — which it is, because these modules are
 * dynamically imported. So the discipline is: unwrap at the boundary, in ONE place per call, using
 * the helper that matches the package.
 */
export interface ParityResult<T> {
  ok: boolean
  value?: T
  error?: unknown
}

/** Unwrap a `@parity/result`. Throws with the host's own error text on failure. */
export function unwrapParity<T>(result: ParityResult<T> | undefined, label: string): T {
  if (!result || typeof result.ok !== 'boolean') {
    // Reaching here almost always means a neverthrow `ResultAsync` was passed to the wrong
    // unwrapper — see the block comment above. Say so, rather than "cannot read property of
    // undefined" three frames later.
    throw new Error(
      `${label}: expected a @parity/result with an .ok field, got ${JSON.stringify(result)}. ` +
        'If this call returns a neverthrow ResultAsync, unwrap it with unwrapNeverthrow instead.',
    )
  }
  if (!result.ok) throw new Error(`${label}: ${describe(result.error)}`)
  return result.value as T
}

/**
 * Unwrap a neverthrow `Result` / awaited `ResultAsync`. Never call `.ok` on one of these.
 */
export function unwrapNeverthrow<T>(result: unknown, label: string): T {
  const r = result as { isOk?: () => boolean; value?: T; error?: unknown }
  if (typeof r?.isOk !== 'function') {
    throw new Error(
      `${label}: expected a neverthrow Result with isOk(), got ${JSON.stringify(result)}. ` +
        'If this call returns a @parity/result, unwrap it with unwrapParity instead.',
    )
  }
  if (!r.isOk()) throw new Error(`${label}: ${describe(r.error)}`)
  return r.value as T
}
