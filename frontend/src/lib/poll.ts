/**
 * Stale-while-revalidate for the polling list hooks.
 *
 * ⚠️ WHY THIS FILE EXISTS — a bug reported from a real device: "maybe once a minute the items
 * flicker for a few hundred milliseconds". Every list hook ran a 30-second `setInterval` that
 * re-entered the SAME loader the cold load uses, and that loader announced `setIsLoading(true)` and
 * `setX([])` *before* it fetched. So twice a minute a populated list became an empty, loading list
 * and then repopulated — a full unmount/remount of every row, for data that was almost always
 * identical to what was already on screen.
 *
 * The rule this file encodes:
 *
 *   A **background** refresh never clears data and never raises the initial-loading flag. It swaps
 *   data in only once the new data has arrived, and only if the new data actually differs.
 *   A **cold** load keeps the old behaviour, because there is genuinely nothing to show yet.
 *
 * ⛔ **The two entry points must be named, never inferred.** Do not decide "background" by asking
 * whether the array is currently empty: a genuinely empty list that polls would then alternate
 * between the two behaviours forever, which is the flicker again with extra steps.
 *
 * Three properties worth not re-litigating:
 *
 * - **A failed refresh never calls `setData`.** Not on background (it would blank a list the user is
 *   reading) and not on cold either (a cold failure already has nothing to blank). The error is
 *   surfaced separately, so a good list plus an error banner is representable — which is the honest
 *   state when the RPC is flaky.
 * - **An unchanged result is not committed at all.** The poll usually fetches byte-identical data;
 *   handing React a fresh array of fresh objects every 30s re-renders every row for nothing. The
 *   deep-equal skip keeps the previous object identities alive so memoised rows stay mounted.
 * - **`isRefreshing` is separate from `isLoading`.** A UI that wants a subtle "updating" hint can
 *   have one without the list unmounting. Nothing is required to consume it.
 *
 * This module is deliberately React-free: it is driven through injected sinks so it can be tested by
 * `npm run test:lib`, which runs on bare node with zero dependencies and cannot render a component.
 */

/** How a load was entered. Always explicit — see the ⛔ above. */
export type RefreshMode = "cold" | "background";

/**
 * The poll period shared by the list hooks.
 *
 * Polling, NOT log subscriptions: `eth_getLogs` cannot see events from host-submitted contract calls
 * (architecture §8). Do not "modernise" this into a subscription.
 */
export const POLL_INTERVAL_MS = 30_000;

/**
 * Where a refresh writes its results. In a hook these are the `useState` setters; in a test they are
 * recorders. `setData` is the only one that must be idempotent-safe — the others are called at most
 * twice per refresh.
 */
export interface RefreshSinks<T> {
  /** Commit new data. NOT called when the fetch failed, and NOT called when nothing changed. */
  setData: (next: T) => void;
  /** The initial-loading flag. Only ever moved by a **cold** load. */
  setLoading: (value: boolean) => void;
  /** The background-refresh flag. Only ever moved by a **background** load. */
  setRefreshing: (value: boolean) => void;
  /** The error slot. Cleared on any success; set on any failure. */
  setError: (value: string | null) => void;
}

/**
 * Orders concurrent refreshes, so an older one cannot commit over a newer one.
 *
 * ⚠️ WITHOUT THIS, A JUST-PUBLISHED ITEM CAN SILENTLY VANISH. The sequence, all of it realistic:
 * the 30-second poll starts fetching at t0; the user publishes; the post-write reload starts at t1
 * and resolves at t2 with the new list and commits; then the poll's fetch — which snapshotted the
 * chain BEFORE the write — resolves at t3 and commits the pre-write list over it. The new reply
 * disappears until the next tick, and because the write itself succeeded there is no error to
 * explain it.
 *
 * Latency here is not milliseconds: a walk fetches bodies from public gateways, so overlapping
 * fetches routinely finish out of order.
 *
 * One gate per hook instance, created once (`useMemo(() => createRefreshGate(), [])`).
 */
export interface RefreshGate {
  /** Take a ticket. The returned predicate is false once a LATER refresh has entered the gate. */
  enter: () => () => boolean;
}

export function createRefreshGate(): RefreshGate {
  let latest = 0;
  return {
    enter() {
      const mine = ++latest;
      return () => mine === latest;
    },
  };
}

/** No gate supplied: every refresh is its own latest, which is the pre-gate behaviour. */
const alwaysCurrent = () => true;

export interface RefreshSpec<T> {
  mode: RefreshMode;
  sinks: RefreshSinks<T>;
  /** Do the actual fetching. Anything it throws becomes the error; it must not touch the sinks. */
  load: () => Promise<T>;
  /**
   * The last data committed by a previous refresh, for the equality skip.
   *
   * ⚠️ Read this from a **ref**, not from a `useState` value captured in a `useCallback` closure —
   * a stale closure would compare against data from two polls ago and commit needlessly.
   */
  previous: () => T;
  /** Defaults to {@link deepEqual}. Override when a cheaper identity is available. */
  equal?: (a: T, b: T) => boolean;
  /**
   * Optional ordering guard — see {@link RefreshGate}. Supply it wherever a write is followed by a
   * reload that races the poll, which is every hook that can publish.
   */
  gate?: RefreshGate;
  /** Turn a thrown value into the one line the UI shows. Defaults to the message or a generic. */
  message?: (err: unknown) => string;
  /** Side channel for logging. Runs before the error is committed. */
  onError?: (err: unknown) => void;
}

function defaultMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Failed to load";
}

/**
 * Run one load under the stale-while-revalidate rules.
 *
 * Never rejects: a failure is reported through `setError`, because every caller is a fire-and-forget
 * `void refresh(...)` from an interval or an effect and an unhandled rejection there is just noise.
 */
export async function refresh<T>(spec: RefreshSpec<T>): Promise<void> {
  const { mode, sinks, load } = spec;
  const cold = mode === "cold";
  // Taken BEFORE the fetch starts, so ordering is by start time — the reload that follows a write
  // always enters after the poll it needs to beat.
  const isCurrent = spec.gate ? spec.gate.enter() : alwaysCurrent;

  if (cold) {
    sinks.setLoading(true);
    // Cleared up front only on a cold load: the screen is about to show a spinner, and pairing it
    // with the previous error would describe a fetch that is no longer running. A background load
    // leaves the existing error alone until its own outcome is known.
    sinks.setError(null);
  } else {
    sinks.setRefreshing(true);
  }

  try {
    const next = await load();
    // ⛔ A SUPERSEDED REFRESH COMMITS NOTHING. Its data is older than what is already on screen, so
    // committing it would roll the list backwards — see {@link RefreshGate}.
    if (!isCurrent()) return;
    const equal = spec.equal ?? deepEqual;
    if (!equal(spec.previous(), next)) {
      sinks.setData(next);
    }
    sinks.setError(null);
  } catch (err) {
    // Diagnostics run even when superseded — an error that really happened should still reach the
    // console. Only the UI state is gated, because a newer refresh will report its own outcome.
    spec.onError?.(err);
    if (!isCurrent()) return;
    // ⛔ NO `setData` HERE, EVER. Blanking a list because a poll failed is the bug this file exists
    // to prevent; the user keeps reading the last good data and the error is shown beside it.
    sinks.setError((spec.message ?? defaultMessage)(err));
  } finally {
    // ⚠️ FLAGS ARE LOWERED UNCONDITIONALLY, gate or no gate: whoever raised one must lower it. Gating
    // this too would leave a superseded COLD load's `isLoading` stuck true forever — a permanent
    // spinner — because the newer refresh only lowers its own flag.
    if (cold) sinks.setLoading(false);
    else sinks.setRefreshing(false);
  }
}

/** Injectable timers, so a test can drive the poll without touching globals or a real clock. */
export interface PollTimers {
  setInterval: (handler: () => void, ms: number) => number;
  clearInterval: (id: number) => void;
}

const browserTimers: PollTimers = {
  setInterval: (handler, ms) => window.setInterval(handler, ms),
  clearInterval: (id) => window.clearInterval(id),
};

/**
 * Start a background poll. Returns the cleanup an effect should return.
 *
 * The tick is always a BACKGROUND refresh — that is the entire point, and it is why this helper
 * exists rather than a bare `setInterval` at each call site.
 */
export function startPolling(
  tick: () => void,
  options?: { intervalMs?: number; timers?: PollTimers }
): () => void {
  const timers = options?.timers ?? browserTimers;
  const id = timers.setInterval(tick, options?.intervalMs ?? POLL_INTERVAL_MS);
  return () => timers.clearInterval(id);
}

/**
 * Structural equality over the plain data these hooks produce: arrays, plain objects, and
 * primitives (including `bigint`). Not a general-purpose deep equal — there are no cycles, no
 * `Map`/`Set`/`Date` and no class instances in the decoded content model, and pretending otherwise
 * would cost more than the comparison saves.
 *
 * `NaN` is equal to itself here (`Object.is`), which is what a "did this change?" check wants.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;

  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;

  if (aIsArray) {
    const x = a as unknown[];
    const y = b as unknown[];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) {
      if (!deepEqual(x[i], y[i])) return false;
    }
    return true;
  }

  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  if (keys.length !== Object.keys(y).length) return false;
  for (const key of keys) {
    // `in` rather than `y[key] !== undefined`: `{ a: undefined }` and `{}` are different shapes and
    // the second would otherwise compare equal to the first.
    if (!Object.prototype.hasOwnProperty.call(y, key)) return false;
    if (!deepEqual(x[key], y[key])) return false;
  }
  return true;
}
