/**
 * Thread deep links.
 *
 * ⚠️ `?thread=N` WAS POSITIONAL AND THEREFORE WRONG. `N` was an index into the page `useForumThread`
 * happened to have loaded — `walkChain` output order — so a link shared today pointed at a different
 * thread the moment anybody else posted. Every thread now carries its announcement `cid`
 * (`types/contracts.ts`), which is the same identity the vote tally is keyed on, so `?cid=` is the
 * only form that survives.
 *
 * `?thread=N` is still PARSED, because links using it have already been published. It is never
 * WRITTEN: as soon as the list resolves the position to a CID, the projection swaps the param. When
 * both are present `cid` wins — the positional one is, by construction, the less trustworthy.
 *
 * ⚠️ THE SHARE URL IS `.dot`, NOT THE `.dev-dot.li` GATEWAY. Verified from `navigateTo`'s contract in
 * `@parity/product-sdk-host` (`src/navigation.ts`): "a `dot`-suffixed deep link routes to another
 * app/route inside the container, an `https://` URL opens externally". A `.dev-dot.li` link would
 * therefore open a browser *next to* the container instead of the thread inside Plaza.
 *
 * These functions are pure so they can be tested without a DOM — the URL projection in `App.tsx` is
 * a `useEffect` that only runs inside React, and this is the part that is worth pinning down.
 */

/** The host-routable origin a shared Plaza link must use. See the `.dot` note above. */
export const THREAD_LINK_ORIGIN = "https://plaza-social.dot";

/**
 * The link to paste into a chat so somebody else lands on this exact thread.
 *
 * Returns `null` for a thread with no CID — a head whose body has not resolved has no identity, and
 * a link to `?cid=` with nothing after it would silently land on the forum root.
 */
export function threadShareUrl(cid: string | null | undefined, origin = THREAD_LINK_ORIGIN): string | null {
  const trimmed = (cid ?? "").trim();
  if (!trimmed) return null;
  return `${origin}/?cid=${encodeURIComponent(trimmed)}`;
}

export interface ThreadSelection {
  /** The canonical selection. */
  cid: string | null;
  /**
   * ⚠️ DEPRECATED. A position in the loaded page, only ever produced by an already-published
   * `?thread=N` link. Resolved to a `cid` by `ForumView` as soon as the list arrives, and dropped.
   */
  legacyIndex: number | null;
}

export const NO_THREAD_SELECTION: ThreadSelection = { cid: null, legacyIndex: null };

/** Read a thread selection out of a query string. `cid` wins whenever both are present. */
export function readThreadSelection(search: string | URLSearchParams): ThreadSelection {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;

  const cid = (params.get("cid") ?? "").trim();
  if (cid) return { cid, legacyIndex: null };

  const raw = params.get("thread");
  if (raw === null) return NO_THREAD_SELECTION;

  // `parseInt` would accept "3abc" and "0x2"; a deep link that is not a plain non-negative integer
  // is a broken link, and silently selecting thread 3 for it is the positional bug all over again.
  if (!/^\d+$/.test(raw.trim())) return NO_THREAD_SELECTION;
  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) ? { cid: null, legacyIndex: parsed } : NO_THREAD_SELECTION;
}

/**
 * Project a selection back onto a query string, in place.
 *
 * ⚠️ Only ever writes `cid`. `thread` is written ONLY while a legacy link has not been resolved yet,
 * so that a reload during that window does not lose the selection; the instant `ForumView` maps the
 * position to a CID the param disappears. Nothing in the app should ever mint a new `?thread=`.
 */
export function writeThreadSelection(params: URLSearchParams, selection: ThreadSelection): void {
  if (selection.cid) {
    params.set("cid", selection.cid);
    params.delete("thread");
    return;
  }
  params.delete("cid");
  if (selection.legacyIndex !== null) {
    params.set("thread", String(selection.legacyIndex));
  } else {
    params.delete("thread");
  }
}
