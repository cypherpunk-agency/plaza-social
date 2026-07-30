// Run: node --experimental-strip-types --test src/lib/blob-cache.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { createBlobCache, createLocalBlobStore, memoryPersistence, nullPersistence } from "./blob-cache.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

/** A fetcher that counts calls and can be made to fail. */
function stubFetcher(contents: Record<string, string>) {
  let calls = 0;
  const fetcher = async (cid: string) => {
    calls += 1;
    const text = contents[cid];
    if (text === undefined) throw new Error(`no gateway could serve ${cid}`);
    return bytes(text);
  };
  return { fetcher, calls: () => calls };
}

test("a CID is fetched once, then served from memory — immutability makes that safe", async () => {
  const stub = stubFetcher({ a: "alpha" });
  const cache = createBlobCache({ fetcher: stub.fetcher, persist: nullPersistence });

  assert.equal(await cache.get("a"), "alpha");
  assert.equal(await cache.get("a"), "alpha");
  assert.equal(stub.calls(), 1);
  assert.equal(cache.stats().hits, 1);
});

test("concurrent reads of the same CID share one fetch", async () => {
  const stub = stubFetcher({ a: "alpha" });
  const cache = createBlobCache({ fetcher: stub.fetcher, persist: nullPersistence });

  const [x, y, z] = await Promise.all([cache.get("a"), cache.get("a"), cache.get("a")]);
  assert.deepEqual([x, y, z], ["alpha", "alpha", "alpha"]);
  assert.equal(stub.calls(), 1);
});

test("persistence survives a page load, so a returning reader re-fetches nothing", async () => {
  const persist = memoryPersistence();
  const stub = stubFetcher({ a: "alpha" });

  const first = createBlobCache({ fetcher: stub.fetcher, persist });
  await first.get("a");

  const reload = createBlobCache({ fetcher: stub.fetcher, persist });
  assert.equal(reload.peek("a"), "alpha", "a synchronous hit, available during render");
  assert.equal(await reload.get("a"), "alpha");
  assert.equal(stub.calls(), 1, "no second fetch across the simulated reload");
});

test("seeding our own write means it never round-trips while it propagates", async () => {
  const stub = stubFetcher({}); // nothing is on any gateway yet — the realistic case
  const cache = createBlobCache({ fetcher: stub.fetcher, persist: nullPersistence });

  cache.put("fresh", '{"v":1}');
  assert.equal(await cache.get("fresh"), '{"v":1}');
  assert.equal(stub.calls(), 0, "a fresh CID must not be raced against gateways that cannot have it");
});

test("a known miss is remembered briefly, then retried", async () => {
  let now = 1_000;
  const stub = stubFetcher({});
  const cache = createBlobCache({
    fetcher: stub.fetcher,
    persist: nullPersistence,
    missTtlMs: 100,
    now: () => now,
  });

  assert.equal(await cache.get("gone"), null, "a failure is null, not a throw");
  assert.equal(cache.knownMissing("gone"), true);
  assert.equal(await cache.get("gone"), null);
  assert.equal(stub.calls(), 1, "no re-racing four gateways on every scroll");

  now += 200;
  assert.equal(cache.knownMissing("gone"), false);
  assert.equal(await cache.get("gone"), null);
  assert.equal(stub.calls(), 2, "…but the ttl is short, because the other cause is propagation");
});

test("put clears a remembered miss", async () => {
  const stub = stubFetcher({});
  const cache = createBlobCache({ fetcher: stub.fetcher, persist: nullPersistence });
  await cache.get("x");
  assert.equal(cache.knownMissing("x"), true);
  cache.put("x", "now here");
  assert.equal(cache.knownMissing("x"), false);
  assert.equal(await cache.get("x"), "now here");
});

test("noteMissing lets an <img> onError feed back into the cache", () => {
  const cache = createBlobCache({ fetcher: async () => bytes(""), persist: nullPersistence });
  assert.equal(cache.knownMissing("img"), false);
  cache.noteMissing("img");
  assert.equal(cache.knownMissing("img"), true);
});

test("memory is bounded, and eviction falls back to persistence", async () => {
  const persist = memoryPersistence();
  const stub = stubFetcher({ a: "A", b: "B", c: "C" });
  const cache = createBlobCache({ fetcher: stub.fetcher, persist, memoryLimit: 2 });

  await cache.get("a");
  await cache.get("b");
  await cache.get("c");
  assert.equal(cache.stats().memory, 2);
  assert.equal(cache.peek("a"), "A", "evicted from memory, recovered from persistence");
});

test("an oversized value stays out of persistence but still serves from memory", async () => {
  const persist = memoryPersistence();
  const big = "x".repeat(500);
  const cache = createBlobCache({
    fetcher: async () => bytes(big),
    persist,
    maxPersistBytes: 100,
  });

  assert.equal(await cache.get("big"), big);
  assert.equal(persist.get("big"), null, "one huge value must not evict the whole object cache");
  assert.equal(cache.peek("big"), big);
});

test("forget drops both the value and the miss; clear can spare persistence", async () => {
  const persist = memoryPersistence();
  const stub = stubFetcher({ a: "A" });
  const cache = createBlobCache({ fetcher: stub.fetcher, persist });

  await cache.get("a");
  cache.forget("a");
  assert.equal(persist.get("a"), null);
  assert.equal(await cache.get("a"), "A");
  assert.equal(stub.calls(), 2);

  cache.clear();
  assert.equal(cache.stats().memory, 0);
  assert.equal(persist.get("a"), "A", "clear() without { persist: true } leaves storage alone");
  cache.clear({ persist: true });
  assert.equal(persist.get("a"), null);
});

test("a broken persistence layer is slow, not fatal", async () => {
  // A privacy mode that blocks storage, or a full quota. Neither may turn a successful fetch into a
  // cached miss — that failure would be indistinguishable from an expired body.
  const hostile = {
    get() {
      throw new Error("storage disabled by privacy mode");
    },
    set() {
      throw new Error("quota exceeded");
    },
  };
  const cache = createBlobCache({ fetcher: async () => bytes("value"), persist: hostile as never });

  assert.equal(cache.peek("a"), undefined);
  assert.equal(await cache.get("a"), "value");
  assert.equal(cache.knownMissing("a"), false);
  assert.equal(cache.peek("a"), "value", "memory still has it");
});

test("an empty CID is a null, never a fetch", async () => {
  const stub = stubFetcher({ "": "nope" });
  const cache = createBlobCache({ fetcher: stub.fetcher, persist: nullPersistence });
  assert.equal(await cache.get(""), null);
  assert.equal(stub.calls(), 0);
});

/* ─────────────────────────────────────────── attachments we uploaded ── */

test("the local blob store hands out a URL that works before propagation", () => {
  const created: string[] = [];
  const revoked: string[] = [];
  const original = globalThis.URL.createObjectURL;
  const originalRevoke = globalThis.URL.revokeObjectURL;
  globalThis.URL.createObjectURL = ((blob: unknown) => {
    const url = `blob:local/${created.length}`;
    created.push(String(blob && typeof blob === "object" ? "blob" : blob));
    return url;
  }) as typeof URL.createObjectURL;
  globalThis.URL.revokeObjectURL = ((url: string) => void revoked.push(url)) as typeof URL.revokeObjectURL;

  try {
    const store = createLocalBlobStore();
    const url = store.remember("cid1", new Blob(["bytes"]));
    assert.equal(url, "blob:local/0");
    assert.equal(store.remember("cid1", new Blob(["bytes"])), "blob:local/0", "one URL per CID");
    assert.equal(store.url("cid1"), "blob:local/0");
    assert.equal(store.url("other"), null);
    assert.equal(store.has("cid1"), true);
    assert.equal(store.size(), 1);

    store.destroy();
    assert.deepEqual(revoked, ["blob:local/0"], "a leaked object URL pins its bytes");
    assert.equal(store.size(), 0);
  } finally {
    globalThis.URL.createObjectURL = original;
    globalThis.URL.revokeObjectURL = originalRevoke;
  }
});
