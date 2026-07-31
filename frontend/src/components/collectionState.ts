// The DECIDING half of the three-way rule. The RENDERING half is `CollectionStatus.tsx`.
//
// ⚠️ THE SPLIT IS NOT TIDINESS: `react-refresh/only-export-components` makes a file that exports
// both a hook and a component a lint error, and mixing them also breaks Fast Refresh in dev.

import { useEffect, useState } from 'react';

/**
 * ⭐ NEVER TELL A READER A COLLECTION IS EMPTY UNTIL A READ HAS ACTUALLY COMPLETED.
 *
 * ⚠️ WHY THIS FILE EXISTS — a bug reported from a real phone: the forum said *"No threads yet. Be
 * the first to start a discussion!"* over a board that had threads on it. It was still starting up.
 * That is the worst possible thing an app can say: a confident, wrong, ACTIONABLE statement about
 * somebody else's data, and the reader has no way to tell it apart from the truth.
 *
 * The cause was a two-state model. Every list rendered `isLoading ? spinner : empty`, and
 * `isLoading` is the **cold-load** flag — it is raised by `lib/poll.ts` `refresh()`, which the list
 * hooks only reach *after* their own guard:
 *
 * ```ts
 * if (!getReadContract() || !registryId) { if (mode === "cold") commitThreads([]); return; }
 * ```
 *
 * While the host session is still coming up there is no chain reader, so that guard returns
 * immediately, `isLoading` is never raised, the array is `[]` — and the "empty" branch renders. On a
 * phone that window is long: the container handshake, an 881 kB chain-metadata chunk and a fresh
 * chainHead subscription all happen before the first read.
 *
 * So SESSION-NOT-READY IS A THIRD STATE, distinct from loading and from empty:
 *
 * | state | means | the reader is told |
 * |---|---|---|
 * | `connecting` | no chain reader yet — nothing has been asked, let alone answered | "connecting" |
 * | `loading` | a cold read is in flight against a real reader | "loading X..." |
 * | `empty` | a read COMPLETED and found nothing | the empty message |
 * | `ready` | there are rows to render (or an error the caller owns) | the list |
 *
 * ⛔ **`isRefreshing` IS NOT AN INPUT HERE AND MUST NOT BECOME ONE.** It is the background poll,
 * which runs every 30 seconds with data already on screen. Deriving a loading state from it is
 * exactly the flicker `lib/poll.ts` was written to remove. A subtle inline hint is fine; replacing
 * or unmounting content is not.
 */
export type CollectionState = 'connecting' | 'loading' | 'empty' | 'ready';

export interface CollectionStateInput {
  /**
   * Can a read even be attempted right now? This must mirror the hook's OWN guard, which for every
   * migrated list hook is `createReadContract(address, abi, provider) !== null` plus whatever else
   * its cold effect requires — so in practice `!!provider && !!address && !!<subject>`.
   *
   * ⚠️ `provider` is the SDK chain reader (`utils/contracts.ts`), null until the host session is up.
   * It is the signal every one of these components already receives as a prop.
   */
  ready: boolean;
  /** The hook's COLD-load flag. ⛔ Never pass `isRefreshing` here. */
  isLoading: boolean;
  /** How many rows are currently committed. */
  count: number;
  /**
   * The hook's error slot. A failed read is not an empty collection, so this suppresses `empty`
   * and hands the screen back to the caller's own error branch.
   */
  error?: string | null;
  /**
   * WHAT is being read — a registry id, a profile address, a parent CID. Changing it re-arms the
   * decision, so a new subject cannot inherit the previous one's "a read finished".
   */
  subject?: string | null;
}

/**
 * The three-way decision, in one place so six call sites cannot drift.
 *
 * The only non-obvious part is `seenKey`. `refresh()` raises `isLoading` **synchronously**, inside
 * the same effect flush that starts the cold load, so the only render in which a ready session can
 * show `isLoading === false` with nothing loaded is the single render *before* effects have run for
 * the current `(ready, subject)`. `seenKey` is exactly that one-render latch: until the effect for
 * this key has fired, we say `loading` rather than `empty`.
 */
export function useCollectionState({
  ready,
  isLoading,
  count,
  error = null,
  subject = null,
}: CollectionStateInput): CollectionState {
  const key = `${ready ? 'r' : '-'}:${subject ?? ''}`;
  const [seenKey, setSeenKey] = useState<string | null>(null);

  useEffect(() => {
    setSeenKey(key);
  }, [key]);

  // Rows on screen win over everything — the list stays mounted through polls, errors and
  // reconnects. This is what keeps `isRefreshing` from ever needing to be consulted.
  if (count > 0) return 'ready';
  // A failed read is not an empty collection. The caller's error branch owns the screen; with zero
  // rows its list renders nothing, so the banner stands alone.
  if (error) return 'ready';
  if (!ready) return 'connecting';
  if (isLoading || seenKey !== key) return 'loading';
  return 'empty';
}
