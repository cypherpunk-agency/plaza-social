// Walking a CID chain backwards from one or more heads, a page at a time. Pure logic — the only
// I/O is the injected cache's `get`.
//
// This is the read algorithm for every Bulletin-backed surface. Four things make it more than a
// `while (cid) { fetch }` loop:
//
// 1. **A dead link truncates history; it does not break it.** Bulletin objects expire after ~15
//    days, so a long enough walk always ends in an unresolvable CID. That is a NORMAL terminal
//    state (`end: 'expired'`), never an error, and the hole is still emitted — with the author and
//    timestamp its successor recorded, so a hole says who and when instead of being a void.
//
// 2. **A chain truncates at the FIRST HOLE, not from the tail** (architecture.md §4). `prev` lives
//    inside the object that will not load, so one lapsed object orphans everything older than it.
//    Two mitigations, and neither is a fix:
//      - objects carry an ancestor ladder (`skips`, wire.ts) so the walk can step over up to
//        SKIP_LEVELS consecutive dead objects using CIDs it already knows;
//      - when it cannot, the page says so — `end: 'expired'` with `truncatedAt`, so the UI can say
//        "earlier content has expired" rather than pretending the chain ended.
//    Do not let a caller collapse `'expired'` and `'start'` into "no more pages". They are
//    different facts about the world and one of them is data loss.
//
// 3. **Heads fork, and that is not an error.** There is one head per writer (§3), so several valid
//    heads is the normal case for any shared registry. The walk is a k-way merge across every
//    candidate head, ordered by claimed timestamp, deduped by CID, and it reconverges by itself
//    once the branches rejoin.
//
// 4. **Cursors are opaque and encode a FRONTIER** — several CIDs, because of forks, possibly still
//    diverged several objects after the fork point. Anything that parses one will break.
//
// Ordering is by author-claimed `at`. There is no trustworthy clock here (see the self-asserted
// note in wire.ts), so a liar can sort themselves to the top of a page. Ordering is a display
// convenience, not a security property.

import { BODY_RETENTION_MS, PROPAGATION_GRACE_MS, decodeObject } from "./wire.ts";
import type { Attachment, DecodedObject } from "./wire.ts";
import type { BlobCache, LocalBlobStore } from "./blob-cache.ts";

export const DEFAULT_PAGE_LIMIT = 20;
const CURSOR_VERSION = 1;

/* ──────────────────────────────────────────────────────────────────── the seam ── */
//
// Mirrors the index contract's read model (another module owns the implementation):
//
//   heads.get(registry, opts) -> Promise<HeadRef[]>   candidates, newest first
//   heads.set(registry, { cid, prev, block, index })  -> Promise<HeadRef>
//   heads.watch(registry, cb, opts)                   -> Unsubscribe
//
// `block` and `index` are the Bulletin store transaction's position, recorded because
// `renew(block, index)` is POSITIONAL — a CID alone may not be enough to renew (§4a). They come
// from the store receipt (`blockNumber`, `extrinsicIndex`) and this layer only carries them
// through; it never invents them.

export interface HeadRef {
  cid: string;
  prev: string | null;
  at: number | null;
  /** The writer the INDEX attributes this head to. Unlike the object's own `author`, this is not
   *  self-asserted, so it is the only basis for a verified-authorship badge. */
  by: string | null;
  block: number | null;
  index: number | null;
}

export type HeadInput = string | (Partial<HeadRef> & { cid: string });

/* ────────────────────────────────────────────────────────────────────── results ── */

/** Why a CID did not resolve. A guess from age, honestly labelled as such. */
export type UnavailableReason =
  /** Older than the retention window — almost certainly gone for good. */
  | "expired"
  /** Written minutes ago; the host has probably not resolved it yet. Retry is worthwhile. */
  | "pending"
  /** No timestamp to reason from, or an age that explains nothing. */
  | "unknown";

export interface WalkEntry {
  cid: string;
  /** The decoded payload, or null when the CID did not resolve or was not one of ours. */
  object: DecodedObject | null;
  missing: boolean;
  /** Populated for a hole from the successor's recorded `prevAuthor`, when there was one. */
  author: string;
  at: number | null;
  prev: string | null;
  unavailable: UnavailableReason | null;
  /** The index's attribution, when this entry was itself a head. Not self-asserted. */
  head: HeadRef | null;
}

export interface WalkPage {
  entries: WalkEntry[];
  /** Opaque. Pass back as `cursor`. Null means there is no next page. */
  cursor: string | null;
  /**
   * How this page ended:
   *   null       more pages exist — use `cursor`
   *   'start'    the beginning of the chain, genuinely
   *   'expired'  a CID no gateway would serve, and no ladder pointer got past it
   */
  end: null | "start" | "expired";
  /** True when anything in this page was unresolvable, terminal or not. */
  truncated: boolean;
  /** The CID the walk gave up on, when `end === 'expired'`. Useful in a diagnostics view. */
  truncatedAt: string | null;
  /** Count of unresolvable entries in this page. Collapse runs of these in the UI. */
  holes: number;
}

export interface WalkOptions {
  /** Candidate heads, any order. Strings or HeadRefs; HeadRefs carry index attribution through. */
  heads?: HeadInput[];
  limit?: number;
  /** Anything with `get(cid): Promise<string|null>`. See createBlobCache. */
  cache: Pick<BlobCache, "get">;
  /** An opaque cursor from a previous page. Overrides `heads` when it decodes. */
  cursor?: string | null;
  now?: () => number;
  retentionMs?: number;
}

/* ────────────────────────────────────────────────────────────────────── frontier ── */
//
// One slot per live branch. `fallbacks` is the remaining ancestor ladder handed down by the last
// object that resolved, which is what lets a hole be stepped over rather than being terminal.

interface Slot {
  cid: string;
  viaAuthor: string | null;
  viaAt: number | null;
  fallbacks: string[];
  head: HeadRef | null;
}

const asHeadRef = (input: HeadInput): HeadRef | null => {
  if (typeof input === "string") return input ? { cid: input, prev: null, at: null, by: null, block: null, index: null } : null;
  if (!input || typeof input.cid !== "string" || !input.cid) return null;
  return {
    cid: input.cid,
    prev: input.prev ?? null,
    at: typeof input.at === "number" ? input.at : null,
    by: input.by ?? null,
    block: typeof input.block === "number" ? input.block : null,
    index: typeof input.index === "number" ? input.index : null,
  };
};

const slotFromHead = (head: HeadRef): Slot => ({
  cid: head.cid,
  viaAuthor: head.by,
  viaAt: head.at,
  // A head's own ladder is unknown until it is decoded, but the index does record its `prev`, so a
  // head that has ALREADY expired is not automatically the end of the world.
  fallbacks: head.prev ? [head.prev] : [],
  head,
});

/* ────────────────────────────────────────────────────────────────────── the walk ── */

export async function walkChain(options: WalkOptions): Promise<WalkPage> {
  const { heads = [], cache, cursor: cursorIn = null, now = Date.now, retentionMs = BODY_RETENTION_MS } = options;
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_PAGE_LIMIT));

  const resumed = decodeCursor(cursorIn);
  const headRefs = heads.map(asHeadRef).filter((head): head is HeadRef => head !== null);
  let slots: Slot[] = resumed ?? headRefs.map(slotFromHead);

  const entries: WalkEntry[] = [];
  const seen = new Set<string>();
  let truncatedAt: string | null = null;
  let reachedStart = false;
  let holes = 0;

  while (entries.length < limit && slots.length > 0) {
    // Resolve every branch head in parallel — at most a handful, and usually cache hits after the
    // first page.
    const resolved = await Promise.all(slots.map((slot) => resolveSlot(slot, cache)));

    // k-way merge: emit the newest across all branches, then advance only that branch.
    let pick = 0;
    for (let i = 1; i < resolved.length; i += 1) {
      if (sortKey(resolved[i]) > sortKey(resolved[pick])) pick = i;
    }

    const node = resolved[pick];

    if (seen.has(node.slot.cid)) {
      // This branch has merged into one already walked, so from here down the two are the same
      // chain. DROP it rather than keep walking it in parallel: the surviving branch's frontier
      // already covers the shared tail, and a redundant branch would re-emit that tail on the next
      // page, because `seen` cannot persist across a cursor.
      slots = withoutSlot(slots, pick);
      continue;
    }

    seen.add(node.slot.cid);
    const next = advance(node);

    if (node.object) {
      entries.push({
        cid: node.slot.cid,
        object: node.object,
        missing: false,
        author: node.object.author || node.slot.viaAuthor || "",
        at: node.object.at ?? node.slot.viaAt,
        prev: node.object.prev,
        unavailable: null,
        head: node.slot.head,
      });
      if (next === null && node.object.prev === null) reachedStart = true;
    } else {
      holes += 1;
      entries.push({
        cid: node.slot.cid,
        object: null,
        missing: true,
        author: node.slot.viaAuthor ?? "",
        at: node.slot.viaAt,
        prev: null,
        unavailable: reasonFor(node.slot.viaAt, now(), retentionMs),
        head: node.slot.head,
      });
      // Terminal only when the ladder is exhausted too. Until then this is one hole, not the end.
      if (next === null) truncatedAt = node.slot.cid;
    }

    slots = replaceSlot(slots, pick, next);
  }

  // A branch can still be sitting on an object another branch emitted in this same page — a page
  // can end at any point, including between the emit and the next look at that branch. Left in the
  // cursor it would re-emit that object as the first row of the next page, which reads as a
  // duplicated message. Prune before encoding.
  //
  // This cannot empty a non-empty frontier by itself: whichever branch emitted the object either
  // advanced past it (and is still in `slots`) or ended, and ending is what sets the flags above.
  slots = slots.filter((slot) => !seen.has(slot.cid));

  return {
    entries,
    cursor: slots.length > 0 ? encodeCursor(slots) : null,
    end: endState({ open: slots.length > 0, truncatedAt, reachedStart, emptyStart: headRefs.length === 0 && !resumed }),
    truncated: holes > 0,
    truncatedAt,
    holes,
  };
}

/**
 * 'expired' outranks 'start': if any branch died on a dead link, the history being shown is
 * incomplete, and saying "this is the beginning" would be a lie about data loss.
 *
 * The default when nothing is known is 'expired', not 'start' — we only claim to have reached the
 * beginning when we actually read an object whose `prev` was null.
 */
function endState(state: {
  open: boolean;
  truncatedAt: string | null;
  reachedStart: boolean;
  emptyStart: boolean;
}): null | "start" | "expired" {
  if (state.open) return null;
  if (state.truncatedAt) return "expired";
  if (state.reachedStart) return "start";
  // No heads at all: the registry has never been written to. Nothing is missing.
  if (state.emptyStart) return "start";
  return "expired";
}

interface ResolvedNode {
  slot: Slot;
  object: DecodedObject | null;
}

async function resolveSlot(slot: Slot, cache: Pick<BlobCache, "get">): Promise<ResolvedNode> {
  const text = await cache.get(slot.cid);
  // A CID that resolves to bytes we cannot decode is treated exactly like one that does not
  // resolve: a stranger's chain is untrusted input, and content-addressing proves only that the
  // bytes are the ones the CID names — never that they are one of ours.
  return { slot, object: text === null ? null : decodeObject(text) };
}

/** The next slot for this branch, or null when the branch is finished. */
function advance(node: ResolvedNode): Slot | null {
  if (node.object) {
    if (!node.object.prev) return null;
    return {
      cid: node.object.prev,
      viaAuthor: node.object.prevAuthor,
      viaAt: node.object.prevAt,
      fallbacks: [...node.object.skips],
      head: null,
    };
  }
  // The hole's own CID was known, and so are its ancestors' — the ladder is by CID, not by
  // distance guessing, so stepping over a hole skips nothing invisibly. When the ladder runs out,
  // the branch is genuinely over.
  const [next, ...rest] = node.slot.fallbacks;
  if (!next) return null;
  return { cid: next, viaAuthor: null, viaAt: null, fallbacks: rest, head: null };
}

/** Newest first. A hole sorts by the timestamp its successor recorded for it. */
const sortKey = (node: ResolvedNode): number => node.object?.at ?? node.slot.viaAt ?? 0;

const withoutSlot = (slots: Slot[], index: number): Slot[] => slots.filter((_, i) => i !== index);

const replaceSlot = (slots: Slot[], index: number, next: Slot | null): Slot[] =>
  next === null ? withoutSlot(slots, index) : slots.map((slot, i) => (i === index ? next : slot));

function reasonFor(at: number | null, nowMs: number, retentionMs: number): UnavailableReason {
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return "unknown";
  const age = nowMs - at;
  if (age > retentionMs) return "expired";
  if (age < PROPAGATION_GRACE_MS) return "pending";
  return "unknown";
}

/* ─────────────────────────────────────────────────────────────────────── cursor ── */
//
// Opaque BY CONTRACT. It is a frontier, not a position: several CIDs, each with the ladder and the
// metadata needed to keep stepping. Keys are single letters so a fork of four branches still fits
// comfortably in a URL.

export function encodeCursor(slots: Slot[]): string | null {
  if (!Array.isArray(slots) || slots.length === 0) return null;
  try {
    const payload = {
      v: CURSOR_VERSION,
      f: slots.map((slot) => {
        const packed: Record<string, unknown> = { c: slot.cid };
        if (slot.viaAuthor) packed.a = slot.viaAuthor;
        if (typeof slot.viaAt === "number") packed.t = slot.viaAt;
        if (slot.fallbacks.length > 0) packed.k = slot.fallbacks;
        if (slot.head) packed.h = slot.head;
        return packed;
      }),
    };
    return toBase64Url(JSON.stringify(payload));
  } catch {
    return null;
  }
}

export function decodeCursor(cursor: string | null | undefined): Slot[] | null {
  if (typeof cursor !== "string" || !cursor) return null;
  try {
    const parsed = JSON.parse(fromBase64Url(cursor)) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const payload = parsed as { v?: unknown; f?: unknown };
    if (payload.v !== CURSOR_VERSION) return null; // a cursor from another format restarts the walk
    if (!Array.isArray(payload.f)) return null;

    const slots: Slot[] = [];
    for (const raw of payload.f) {
      if (!raw || typeof raw !== "object") continue;
      const packed = raw as Record<string, unknown>;
      if (typeof packed.c !== "string" || !packed.c) continue;
      slots.push({
        cid: packed.c,
        viaAuthor: typeof packed.a === "string" ? packed.a : null,
        viaAt: typeof packed.t === "number" ? packed.t : null,
        fallbacks: Array.isArray(packed.k) ? packed.k.filter((entry): entry is string => typeof entry === "string") : [],
        head: isHeadRef(packed.h) ? packed.h : null,
      });
    }
    return slots.length > 0 ? slots : null;
  } catch {
    return null; // a mangled cursor restarts the walk rather than throwing at the UI
  }
}

const isHeadRef = (value: unknown): value is HeadRef =>
  !!value && typeof value === "object" && typeof (value as { cid?: unknown }).cid === "string";

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(cursor: string): string {
  const padded = cursor.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* ──────────────────────────────────────────────────────── availability, per field ── */
//
// A post can lose its images while keeping its text, or the reverse: every attachment is a separate
// Bulletin object with its own retention clock (§2). So availability is per FIELD, never per post,
// and the UI needs both halves independently.

export type BodyState = "loaded" | "unavailable";

export type AttachmentState =
  /** We uploaded these bytes this session — renders immediately, even mid-propagation. */
  | "local"
  /** Not yet known to be missing. Needs a read through the host to become renderable. */
  | "remote"
  /** A read already failed for this CID within the miss ttl. */
  | "unavailable";

export interface AttachmentView extends Attachment {
  state: AttachmentState;
  /** The URL to put in `src` now. Null only when there is nothing to try. */
  url: string | null;
  /** Alternative URLs to try, in order. Empty since the gateway ladder was removed — see above. */
  urls: string[];
  /** When these bytes stop being servable absent a renewal, or null if unknown. */
  expiresAt: number | null;
  reason: UnavailableReason | null;
}

export interface EntryView {
  cid: string;
  bodyState: BodyState;
  /** Set only when `bodyState === 'unavailable'`. */
  reason: UnavailableReason | null;
  author: string;
  at: number | null;
  /** When this object's own bytes lapse. The deadline a "keep this alive" screen sorts on (§4a). */
  expiresAt: number | null;
  attachments: AttachmentView[];
}

export interface DescribeOptions {
  cache?: Pick<BlobCache, "knownMissing">;
  localBlobs?: Pick<LocalBlobStore, "url">;
  /**
   * ⚠️ NOTHING SUPPLIES THESE ANY MORE, AND THAT IS A KNOWN GAP RATHER THAN AN OVERSIGHT.
   *
   * They used to be `blobUrl`/`blobUrls` from `lib/gateways.ts`, which built public IPFS gateway
   * URLs an `<img src>` could consume directly. That module is deleted (see `lib/bulletin.ts`):
   * Bulletin content is now read as BYTES through the host's preimage lookup, and there is no URL
   * for a host subscription — so a remote attachment has no `src` to point at.
   *
   * Consequence: only attachments THIS session uploaded render, via `localBlobs`. Making a remote
   * one renderable means reading its bytes through the same fetcher the bodies use and wrapping
   * them in an object URL — a change in the attachment component, not here. Left as optional
   * parameters rather than removed so that change has somewhere to plug in.
   *
   * ⛔ Do not "fix" this by reintroducing a gateway URL builder. That is exactly the HTTP path
   * whose removal this whole change is about.
   */
  urlFor?: (cid: string) => string | null;
  urlsFor?: (cid: string) => string[];
  now?: () => number;
  retentionMs?: number;
}

/**
 * Turn a walk entry into what a renderer needs, with the body and each attachment carrying their
 * own state. Synchronous on purpose: it must be callable during render, so it only consults caches
 * that answer immediately and never starts a fetch.
 */
export function describeEntry(entry: WalkEntry, options: DescribeOptions = {}): EntryView {
  const { cache, localBlobs, urlFor, urlsFor, now = Date.now, retentionMs = BODY_RETENTION_MS } = options;
  const nowMs = now();

  const attachments: AttachmentView[] =
    entry.object && entry.object.kind === "post"
      ? entry.object.attachments.map((attachment) => {
          const localUrl = localBlobs?.url(attachment.cid) ?? null;
          const missing = !localUrl && (cache?.knownMissing(attachment.cid) ?? false);
          const state: AttachmentState = localUrl ? "local" : missing ? "unavailable" : "remote";
          return {
            ...attachment,
            state,
            url: localUrl ?? urlFor?.(attachment.cid) ?? null,
            urls: urlsFor?.(attachment.cid) ?? [],
            // An attachment is stored at roughly the same moment as its post, so the post's claimed
            // timestamp is the best clock available for it. Approximate, and labelled as such.
            expiresAt: typeof entry.at === "number" ? entry.at + retentionMs : null,
            reason: missing ? reasonFor(entry.at, nowMs, retentionMs) : null,
          };
        })
      : [];

  return {
    cid: entry.cid,
    bodyState: entry.missing ? "unavailable" : "loaded",
    reason: entry.missing ? entry.unavailable : null,
    author: entry.author,
    at: entry.at,
    expiresAt: typeof entry.at === "number" ? entry.at + retentionMs : null,
    attachments,
  };
}

/**
 * A page-level summary, so a UI can render one honest sentence instead of a run of grey boxes:
 * "3 earlier items have expired", or "earlier content has expired" at the truncation point.
 */
export function summarisePage(page: WalkPage): {
  holes: number;
  end: WalkPage["end"];
  /** True when older content exists but cannot be reached. Not the same as "no more pages". */
  historyLost: boolean;
  message: string | null;
} {
  const historyLost = page.end === "expired";
  const parts: string[] = [];
  if (page.holes === 1) parts.push("1 item is no longer available");
  else if (page.holes > 1) parts.push(`${page.holes} items are no longer available`);
  if (historyLost) parts.push("earlier content has expired");
  return {
    holes: page.holes,
    end: page.end,
    historyLost,
    message: parts.length > 0 ? `${parts.join(", and ")}.` : null,
  };
}
