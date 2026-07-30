// A CID-keyed cache. Pure logic, storage injected.
//
// This is the single biggest performance lever in the read path, and it is only sound because of
// one property: **Bulletin objects are immutable**. A CID names its own content, so a cached hit
// can never be stale, there is no invalidation problem, and a returning reader re-fetches almost
// nothing. Walking 20 objects back costs seconds cold and ~0 warm.
//
// Two tiers:
//   memory   — this page load. Also dedupes concurrent fetches of the same CID.
//   persist  — across page loads. Injected, and deliberately best-effort: host local storage
//              inside a container, browser localStorage outside, nothing at all in a privacy mode
//              that blocks both. A cache that cannot write is slow, not broken.
//
// Negative results are cached too, with a SHORT ttl. An expired body will not come back, and
// re-racing four gateways for it on every scroll is wasted time and a wasted spinner. The ttl is
// short because the other reason a CID does not resolve is that we wrote it 30 seconds ago.
//
// ── SEEDING OUR OWN WRITES IS NOT AN OPTIMISATION ──────────────────────────────────────────────
// A freshly stored CID takes MINUTES to propagate to public gateways. Without `put`, a user's own
// post reliably renders as unavailable for its first few minutes — the single worst first-run
// impression the app can make. The write path must call `put(cid, text)` with the exact bytes it
// stored, and `rememberBlob(cid, blob)` for each attachment it uploaded.

const DEFAULT_MEMORY_LIMIT = 600;
const DEFAULT_MISS_TTL_MS = 45_000;
/** localStorage is ~5 MB total; a single huge value in it evicts everything useful. */
const DEFAULT_MAX_PERSIST_BYTES = 32_000;

export interface Persistence {
  get(cid: string): string | null;
  set(cid: string, text: string): void;
  delete?(cid: string): void;
  /** Best-effort: drop everything under this persistence's own prefix. */
  clear?(): void;
}

/** localStorage, wrapped so a privacy mode or a full quota degrades instead of throwing. */
export function browserPersistence(prefix = "plaza.blob.v1"): Persistence {
  const key = (cid: string) => `${prefix}:${cid}`;

  const evictSome = () => {
    // Quota is full. Drop a slice of our own keys rather than clearing storage we do not own —
    // localStorage is shared with the session wallet and UI preferences.
    try {
      const store = globalThis.localStorage;
      if (!store) return;
      const ours: string[] = [];
      for (let i = 0; i < store.length; i += 1) {
        const found = store.key(i);
        if (found?.startsWith(`${prefix}:`)) ours.push(found);
      }
      for (const found of ours.slice(0, Math.max(1, Math.floor(ours.length / 4)))) {
        store.removeItem(found);
      }
    } catch {
      // Nothing further to try.
    }
  };

  return {
    get(cid) {
      try {
        return globalThis.localStorage?.getItem(key(cid)) ?? null;
      } catch {
        return null;
      }
    },
    set(cid, text) {
      try {
        globalThis.localStorage?.setItem(key(cid), text);
      } catch {
        evictSome();
        try {
          globalThis.localStorage?.setItem(key(cid), text);
        } catch {
          // Quota exceeded or storage blocked. Both survivable; memory still has it.
        }
      }
    },
    delete(cid) {
      try {
        globalThis.localStorage?.removeItem(key(cid));
      } catch {
        /* ignore */
      }
    },
    clear() {
      try {
        const store = globalThis.localStorage;
        if (!store) return;
        const ours: string[] = [];
        for (let i = 0; i < store.length; i += 1) {
          const found = store.key(i);
          if (found?.startsWith(`${prefix}:`)) ours.push(found);
        }
        for (const found of ours) store.removeItem(found);
      } catch {
        /* ignore */
      }
    },
  };
}

export const nullPersistence: Persistence = { get: () => null, set: () => {} };

/** For tests, and for a host that hands us its own async storage we do not want to block on. */
export function memoryPersistence(): Persistence {
  const store = new Map<string, string>();
  return {
    get: (cid) => store.get(cid) ?? null,
    set: (cid, text) => void store.set(cid, text),
    delete: (cid) => void store.delete(cid),
    clear: () => store.clear(),
  };
}

export interface BlobCacheOptions {
  /** Throws (BlobUnavailableError) when no gateway can serve the CID. */
  fetcher: (cid: string) => Promise<Uint8Array>;
  persist?: Persistence;
  memoryLimit?: number;
  missTtlMs?: number;
  maxPersistBytes?: number;
  now?: () => number;
}

export interface BlobCacheStats {
  memory: number;
  misses: number;
  inFlight: number;
  hits: number;
  fetches: number;
}

export interface BlobCache {
  /** Synchronous probe. The text, or `undefined` when we would have to fetch. */
  peek(cid: string): string | undefined;
  /** True when we already know this CID does not resolve and the answer is still fresh. */
  knownMissing(cid: string): boolean;
  /** The object text, or null when no gateway can serve it. Never throws. */
  get(cid: string): Promise<string | null>;
  /** Seed with something we just wrote, so our own content never round-trips. */
  put(cid: string, text: string): void;
  /**
   * Record a failure discovered elsewhere — an `<img onError>`, typically, since attachment bytes
   * are fetched by the browser and not through `get`. Without this, every re-render retries a dead
   * image and the placeholder flickers.
   */
  noteMissing(cid: string): void;
  /** Forget one CID, positive and negative. For a retry the user explicitly asked for. */
  forget(cid: string): void;
  stats(): BlobCacheStats;
  clear(options?: { persist?: boolean }): void;
}

export function createBlobCache(options: BlobCacheOptions): BlobCache {
  const {
    fetcher,
    persist = browserPersistence(),
    memoryLimit = DEFAULT_MEMORY_LIMIT,
    missTtlMs = DEFAULT_MISS_TTL_MS,
    maxPersistBytes = DEFAULT_MAX_PERSIST_BYTES,
    now = Date.now,
  } = options;

  const memory = new Map<string, string>();
  const misses = new Map<string, number>();
  const inFlight = new Map<string, Promise<string | null>>();
  let hits = 0;
  let fetches = 0;

  const remember = (cid: string, text: string) => {
    memory.set(cid, text);
    // Insertion-ordered eviction. Not a true LRU, but the access pattern is a backwards walk, so
    // oldest-inserted is a good proxy for least-useful and the bookkeeping is free.
    if (memory.size > memoryLimit) {
      const oldest = memory.keys().next().value;
      if (oldest !== undefined) memory.delete(oldest);
    }
    // Guarded even though `browserPersistence` guards itself: a caller-supplied layer that throws
    // must not turn a SUCCESSFUL fetch into a cached miss, which is what an unguarded throw here
    // would do — the failure would be indistinguishable from an expired body.
    if (text.length <= maxPersistBytes) {
      try {
        persist.set(cid, text);
      } catch {
        /* a cache that cannot write is slow, not broken */
      }
    }
  };

  const fromPersistence = (cid: string): string | null => {
    try {
      return persist.get(cid);
    } catch {
      return null;
    }
  };

  const cache: BlobCache = {
    peek(cid) {
      if (memory.has(cid)) return memory.get(cid);
      const stored = fromPersistence(cid);
      if (typeof stored === "string") {
        memory.set(cid, stored);
        return stored;
      }
      return undefined;
    },

    knownMissing(cid) {
      const at = misses.get(cid);
      if (at === undefined) return false;
      if (now() - at > missTtlMs) {
        misses.delete(cid);
        return false;
      }
      return true;
    },

    async get(cid) {
      if (typeof cid !== "string" || !cid) return null;

      const cached = cache.peek(cid);
      if (cached !== undefined) {
        hits += 1;
        return cached;
      }
      if (cache.knownMissing(cid)) return null;

      // Two posts referencing the same CID, or a re-render mid-walk, must not double-fetch.
      const existing = inFlight.get(cid);
      if (existing) return existing;

      const request = (async () => {
        try {
          fetches += 1;
          const bytes = await fetcher(cid);
          const text = new TextDecoder().decode(bytes);
          remember(cid, text);
          return text;
        } catch {
          misses.set(cid, now());
          return null;
        } finally {
          inFlight.delete(cid);
        }
      })();

      inFlight.set(cid, request);
      return request;
    },

    put(cid, text) {
      if (typeof cid !== "string" || !cid) return;
      misses.delete(cid);
      remember(cid, String(text));
    },

    noteMissing(cid) {
      if (typeof cid === "string" && cid) misses.set(cid, now());
    },

    forget(cid) {
      memory.delete(cid);
      misses.delete(cid);
      persist.delete?.(cid);
    },

    stats: () => ({ memory: memory.size, misses: misses.size, inFlight: inFlight.size, hits, fetches }),

    clear(clearOptions = {}) {
      memory.clear();
      misses.clear();
      inFlight.clear();
      if (clearOptions.persist) persist.clear?.();
    },
  };

  return cache;
}

/* ─────────────────────────────────────────────────────── attachments we uploaded ── */

export interface LocalBlobStore {
  /** Remember bytes we just uploaded and return a URL that works immediately. */
  remember(cid: string, blob: Blob): string | null;
  /** A same-session URL for this CID, or null. Callers fall back to a gateway URL. */
  url(cid: string): string | null;
  has(cid: string): boolean;
  size(): number;
  /** Revoke every object URL. Call on unmount; a leaked object URL pins its bytes. */
  destroy(): void;
}

/**
 * Object URLs for attachments THIS session uploaded.
 *
 * Separate from the text cache on purpose. Image bytes must not go into localStorage (a single
 * 1 MB attachment would evict the whole object cache), and an `<img src>` cannot consume a
 * promise — it needs a URL that resolves *now*, which a gateway URL does not for a CID that is
 * still propagating.
 */
export function createLocalBlobStore(): LocalBlobStore {
  const urls = new Map<string, string>();

  return {
    remember(cid, blob) {
      if (typeof cid !== "string" || !cid || !blob) return null;
      const existing = urls.get(cid);
      if (existing) return existing;
      try {
        const url = URL.createObjectURL(blob);
        urls.set(cid, url);
        return url;
      } catch {
        return null; // no URL factory (SSR, or a test environment) — the gateway path still works
      }
    },
    url: (cid) => urls.get(cid) ?? null,
    has: (cid) => urls.has(cid),
    size: () => urls.size,
    destroy() {
      for (const url of urls.values()) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* ignore */
        }
      }
      urls.clear();
    },
  };
}
