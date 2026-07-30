// Public IPFS gateway reads. Plain `fetch`, no SDK, no container.
//
// WHY THIS EXISTS: the SDK's own fetch is container-only, so public gateways are the only path for
// anonymous reads — and anonymous reading inside the host is a supported state (no wallet
// connected ⇒ canWrite: false, reads still succeed).
//
// The list and its ORDER are measured, not guessed — 16 live CIDs (71–166 bytes), from outside any
// container, per yolodot/docs/platform/bulletin-vs-contract-storage.md:
//
//   devnet-ipfs.api.polkadotcommunity.foundation   16/16   p50 136 ms
//   nftstorage.link                                16/16   p50 103 ms
//   ipfs.io                                        15/16   p50 169 ms
//   dweb.link                                      16/16   p50 395 ms
//   Promise.any race over all of them              16/16   p50  30 ms
//
// `paseo-bulletin-next-ipfs.polkadot.io` is DELIBERATELY ABSENT: measured 1/16, returning 504s.
// Parity's own `survey` app ships it FIRST and only appears to work because `Promise.any` masks the
// failure. Do not add it back, and do not copy a gateway list from a reference app without
// measuring it.
//
// Two calibrated timeouts, because payload size dominates: small objects race fine (16 fully
// parallel in 203 ms, zero failures) while bundle-sized payloads degrade sharply — 9/10 success,
// mean 2.2 s, max 12.4 s, and one CID that failed on all five gateways after 20 s.

export const GATEWAYS: readonly string[] = Object.freeze([
  "https://devnet-ipfs.api.polkadotcommunity.foundation/ipfs/",
  "https://nftstorage.link/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
]);

/** Chain objects: small JSON. If four gateways cannot answer in 8 s, none of them will. */
export const DEFAULT_FETCH_TIMEOUT_MS = 8_000;
/** Attachments: measured worst case is 12.4 s, so a short timeout here manufactures failures. */
export const LARGE_FETCH_TIMEOUT_MS = 25_000;

export interface FetchBlobOptions {
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
  signal?: AbortSignal;
  gateways?: readonly string[];
}

/**
 * A single best-effort URL, for an `<img src>` or a link — anything that cannot race.
 *
 * Racing is strictly better whenever the caller controls the fetch; use `fetchBlob` there. For an
 * `<img>`, prefer a locally-remembered object URL if the session has one (see blob-cache) because a
 * CID we just wrote will not be on any gateway yet.
 */
export function blobUrl(cid: string | null | undefined, gateway: string = GATEWAYS[0]): string | null {
  if (typeof cid !== "string" || !cid || /\s/.test(cid)) return null;
  return `${gateway}${encodeURIComponent(cid)}`;
}

/** Every gateway URL for one CID, in measured preference order — for an `<img>` retry ladder. */
export function blobUrls(cid: string | null | undefined): string[] {
  if (typeof cid !== "string" || !cid || /\s/.test(cid)) return [];
  return GATEWAYS.map((prefix) => `${prefix}${encodeURIComponent(cid)}`);
}

/**
 * No gateway could serve this CID.
 *
 * This is a NORMAL outcome, not an exception in the product sense: Bulletin content expires after
 * ~15 days, so failure here usually means "these bytes are gone", which the read path turns into
 * `bodyState: 'unavailable'` or an unavailable attachment. Never surface it as an error toast.
 */
export class BlobUnavailableError extends Error {
  cid: string;
  attempts: number;

  constructor(cid: string, cause?: unknown, attempts = 0) {
    super(`No gateway could serve ${cid}.`);
    this.name = "BlobUnavailableError";
    this.cid = cid;
    this.attempts = attempts;
    this.cause = cause;
  }
}

/**
 * Race every gateway for one CID. Resolves with the bytes, or throws BlobUnavailableError.
 *
 * `Promise.any`: first success wins, and a slow or dead gateway costs nothing as long as one other
 * answers. The losers are aborted together in the `finally`, so a page of 20 objects does not leave
 * 60 sockets open.
 */
export async function fetchBlob(cid: string, options: FetchBlobOptions = {}): Promise<Uint8Array> {
  const {
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    signal,
    gateways = GATEWAYS,
  } = options;

  if (typeof cid !== "string" || !cid) throw new BlobUnavailableError(String(cid));
  if (typeof fetchImpl !== "function") {
    throw new BlobUnavailableError(cid, new Error("No fetch implementation available."));
  }
  if (gateways.length === 0) throw new BlobUnavailableError(cid, new Error("No gateways configured."));

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);

  try {
    return await Promise.any(
      gateways.map(async (prefix) => {
        const response = await fetchImpl(`${prefix}${encodeURIComponent(cid)}`, {
          signal: controller.signal,
          headers: { accept: "application/json, application/octet-stream;q=0.9, */*;q=0.8" },
        });
        if (!response.ok) throw new Error(`${prefix} returned ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      }),
    );
  } catch (error) {
    throw new BlobUnavailableError(cid, error, gateways.length);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort(); // cancel the losers
  }
}

/** `fetchBlob` with the attachment-sized timeout. Same failure semantics. */
export const fetchLargeBlob = (cid: string, options: FetchBlobOptions = {}): Promise<Uint8Array> =>
  fetchBlob(cid, { timeoutMs: LARGE_FETCH_TIMEOUT_MS, ...options });

/** The fetcher shape `createBlobCache` wants, bound to a gateway race. */
export const gatewayFetcher =
  (options: FetchBlobOptions = {}) =>
  (cid: string): Promise<Uint8Array> =>
    fetchBlob(cid, options);
