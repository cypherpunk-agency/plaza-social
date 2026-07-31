// Bulletin content reads. ⭐ THERE IS EXACTLY ONE PATH, AND IT IS THE SDK'S.
//
// This file replaced `lib/gateways.ts`, which raced four public IPFS gateways over plain `fetch`.
// That file is DELETED, and this is the note that has to survive it, because "add a gateway
// fallback" is the single most obvious-looking change anyone will ever propose to this module.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE GATEWAYS WENT, 2026-07-31
//
// Reported from a real phone: opening Plaza inside the Polkadot app made the host prompt the user
// for permission to reach `devnet-ipfs.api.polkadotcommunity.foundation`. It was doing that because
// every post body, thread announcement and reply was fetched by URL from a public IPFS gateway. The
// host asks before letting an app talk to an arbitrary external origin, and it was right to ask —
// the app was talking to one.
//
// It never needed to. `@parity/product-sdk-cloud-storage` retrieves content **through the host's own
// preimage lookup subscription**: no external origin, no permission prompt, host-side caching, and
// automatic reassembly of chunked DAG-PB manifest CIDs. We were already using the same package's
// `store()` for writes and had simply never used its read side.
//
// ⛔ SO: THE HOST CONTAINER IS THE ONLY SURFACE, FOR READS AS WELL AS WRITES. There is no HTTP
// route, no gateway list, no "best effort" second attempt. A CID that the host cannot serve is
// UNAVAILABLE, and the app already renders that honestly — `walk.ts` turns it into a hole with a
// reason, never an error toast. Re-adding an HTTP path would re-add the prompt for content the host
// can serve without one.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE SHAPE, AND WHY IT IS A REGISTRY RATHER THAN AN IMPORT
//
// The SDK may only be imported from `lib/host/sdk.ts` (its own lazily-loaded chunk; it throws
// outside a container). This module is on the READ path, which must stay importable from anywhere
// and must not drag the signing SDK into the first paint. So the direction of the dependency is
// inverted: `lib/host/session.ts` INSTALLS a source here once it has resolved the host's query
// strategy, and this module only ever holds a function.
//
// A module-level singleton is honest here rather than lazy: there is exactly one host per page, and
// the SDK's own entry points (`resolveQueryStrategy()`, `getPreimageManager()`) are themselves
// argument-free module-level functions over that one host. Tests inject a source per call.
//
// ⚠️ THE SOURCE IS RESOLVED AT READ TIME, NOT AT FETCHER-CONSTRUCTION TIME. The list hooks build
// their blob cache in a `useMemo(…, [])` on first render, which happens BEFORE `openBackend()` has
// finished the container handshake. A fetcher that captured the source when it was built would
// capture `null` for the whole session and every body would read as unavailable.

/** How long one host preimage lookup may take before the CID counts as unavailable. */
export const DEFAULT_LOOKUP_TIMEOUT_MS = 8_000;

/**
 * The SDK's own default is **30 000 ms**, applied PER LOOKUP (`QueryOptions.lookupTimeoutMs`), and
 * for a chained walk that is far too slow. Four reasons for 8 s instead:
 *
 *  1. **The budget is paid per link, not per page.** `walkChain` advances one entry per iteration,
 *     so a 20-entry page is up to 20 sequential lookups. At the SDK default one run of expired
 *     history stalls a board for ten minutes with nothing on screen explaining why; at 8 s the same
 *     worst case is bounded at ~160 s, and the realistic case — a page with one or two holes — costs
 *     seconds. (For a chunked body the budget is paid twice, not N times: the manifest, then every
 *     child chunk together under one `Promise.all`.)
 *  2. **8 s is what the read path already had.** It is exactly the `DEFAULT_FETCH_TIMEOUT_MS` the
 *     deleted gateway race used for chain objects, so no surface gets slower than it was.
 *  3. **A lookup that will succeed succeeds far faster than this.** The host lookup is a local
 *     subscription with its own cache and managed IPFS polling; the measured p50 for these same
 *     objects over public gateways — a strictly longer route — was 103–395 ms. 8 s is ~20× that.
 *  4. **A miss is cheap to retry and expensive to wait on.** `blob-cache` remembers a miss for 45 s
 *     and `publish.ts` seeds our own writes with the exact bytes, so nothing depends on a read
 *     sitting still while IPFS propagates. Blocking the walk to wait for it buys nothing.
 *
 * ⚠️ **[I], not [V].** No host preimage lookup has ever been timed on a device — the write half of
 * this channel is verified (2026-07-30) but the read half has never run outside a test. If a phone
 * shows bodies timing out, this constant is the first thing to raise, and the second is to check
 * whether the host is serving from cache at all.
 */

/**
 * A CID that could not be read.
 *
 * ⚠️ THIS IS A NORMAL OUTCOME, NOT AN EXCEPTION IN THE PRODUCT SENSE. Bulletin content expires
 * after ~15 days, so failure here usually means "these bytes are gone", which the read path turns
 * into `bodyState: 'unavailable'`. Never surface it as an error toast.
 *
 * `source` separates the two causes that need different words: `'none'` means there is no read path
 * at all in this session (outside the Polkadot app, or the host refused to open one) and affects
 * EVERY CID; `'host'` means we asked and this one object did not come back.
 */
export class BlobUnavailableError extends Error {
  cid: string;
  source: "none" | "host";

  constructor(cid: string, source: "none" | "host", cause?: unknown) {
    super(
      source === "none"
        ? `No Bulletin read path is available, so ${cid} cannot be loaded.`
        : `The host could not serve ${cid}.`,
    );
    this.name = "BlobUnavailableError";
    this.cid = cid;
    this.source = source;
    this.cause = cause;
  }
}

/**
 * Where bytes come from. Installed by a backend; there is never more than one.
 *
 * `read` REJECTS when the CID cannot be served — it must never resolve with empty bytes, because
 * an empty object decodes to nothing and would be cached as a successful read of a post with no
 * content, which is indistinguishable from a real one.
 */
export interface BulletinSource {
  /** For the diagnostics panel: "host preimage lookup", "fake backend (this session only)". */
  label: string;
  read: (cid: string, options: { timeoutMs: number }) => Promise<Uint8Array>;
}

export interface ReadBlobOptions {
  timeoutMs?: number;
  /** Injected in tests. Production always resolves the installed source at read time. */
  source?: BulletinSource | null;
}

let installed: BulletinSource | null = null;

/**
 * Install (or clear, with `null`) the one read path for this page.
 *
 * Called by `lib/host/session.ts` after the host's query strategy resolves, and by `lib/host/fake.ts`
 * for local development. Clearing it on `destroy()` matters: a stale source would keep answering
 * from a torn-down host.
 */
export function setBulletinSource(source: BulletinSource | null): void {
  installed = source;
}

/** The installed source, or null when this session cannot read Bulletin content at all. */
export function bulletinSource(): BulletinSource | null {
  return installed;
}

/**
 * Read one Bulletin object. Resolves with the bytes, or throws `BlobUnavailableError`.
 *
 * ⛔ ONE ATTEMPT, ONE SOURCE. No retry ladder, no second origin. A caller that wants a retry has
 * `blob-cache`'s miss ttl, which is the right place for it: it is shared across every reader of the
 * same CID instead of being multiplied by them.
 */
export async function readBlob(cid: string, options: ReadBlobOptions = {}): Promise<Uint8Array> {
  const { timeoutMs = DEFAULT_LOOKUP_TIMEOUT_MS } = options;
  const source = options.source !== undefined ? options.source : installed;

  if (typeof cid !== "string" || !cid || /\s/.test(cid)) {
    throw new BlobUnavailableError(String(cid), "host", new Error("not a CID"));
  }
  if (!source) throw new BlobUnavailableError(cid, "none");

  let bytes: Uint8Array;
  try {
    bytes = await source.read(cid, { timeoutMs });
  } catch (error) {
    throw new BlobUnavailableError(cid, "host", error);
  }
  if (!(bytes instanceof Uint8Array)) {
    throw new BlobUnavailableError(cid, "host", new Error("the read path returned no bytes"));
  }
  return bytes;
}

/**
 * The fetcher shape `createBlobCache` wants.
 *
 * The three migrated list hooks inject exactly this and nothing else, which is what keeps the
 * host check in ONE place instead of scattered through them.
 */
export const bulletinFetcher =
  (options: ReadBlobOptions = {}) =>
  (cid: string): Promise<Uint8Array> =>
    readBlob(cid, options);
