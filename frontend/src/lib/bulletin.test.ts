// Run: node --experimental-strip-types --test src/lib/bulletin.test.ts
//
// These tests pin the INVERSE of what the old `gateways.test.ts` pinned, and the inversion is the
// point: there is one read path, it is the host's, and a session without it fails LOUDLY rather
// than quietly reaching for something else.
//
// The source is injected, so every case runs offline and off-device. What none of them can prove is
// that a real host preimage lookup returns bytes — that needs a phone, and until someone runs it the
// SDK read path is [I], not [V].
//
// ⚠️ Timeout cases use small REAL timers, never a frozen `now: () => 0` clock. A frozen clock hung a
// test in this repo indefinitely.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BlobUnavailableError,
  DEFAULT_LOOKUP_TIMEOUT_MS,
  bulletinFetcher,
  bulletinSource,
  readBlob,
  setBulletinSource,
  type BulletinSource,
} from "./bulletin.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const decode = (raw: Uint8Array) => new TextDecoder().decode(raw);

/** A source that answers from a map, counting calls so "exactly one attempt" is checkable. */
function stubSource(entries: Record<string, string> = {}): BulletinSource & {
  calls: () => string[];
  timeouts: () => number[];
} {
  const calls: string[] = [];
  const timeouts: number[] = [];
  return {
    label: "stub",
    async read(cid, options) {
      calls.push(cid);
      timeouts.push(options.timeoutMs);
      const found = entries[cid];
      if (found === undefined) throw new Error(`stub has no ${cid}`);
      return bytes(found);
    },
    calls: () => calls,
    timeouts: () => timeouts,
  };
}

/* ───────────────────────────────────────────── there is no second path ── */

test("with no source installed a read FAILS — it never reaches for an alternative", async () => {
  setBulletinSource(null);
  await assert.rejects(
    () => readBlob("bafy1"),
    (error: unknown) => {
      assert.ok(error instanceof BlobUnavailableError);
      assert.equal(error.cid, "bafy1");
      // `'none'` is what lets the UI say "this session cannot read bodies at all" rather than
      // "this one object expired" — two different sentences for two different causes.
      assert.equal(error.source, "none");
      assert.match(error.message, /No Bulletin read path is available/);
      return true;
    },
  );
});

test("⭐ a read makes NO network call — that prompt is what this whole module exists to remove", async () => {
  const original = globalThis.fetch;
  let fetches = 0;
  // Anything that reached for HTTP would be counted here, whatever URL it chose.
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error("the read path must never call fetch");
  }) as typeof fetch;

  try {
    // The success case…
    const source = stubSource({ bafy1: "body" });
    assert.equal(decode(await readBlob("bafy1", { source })), "body");
    // …and the failure case, which is where a fallback would have lived.
    await assert.rejects(() => readBlob("bafyGone", { source }), BlobUnavailableError);
    await assert.rejects(() => readBlob("bafy1", { source: null }), BlobUnavailableError);
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(fetches, 0, "no HTTP request may leave the app for a Bulletin read");
});

test("a source error surfaces as unavailability, with the cause kept and ONE attempt made", async () => {
  const source = stubSource({});
  await assert.rejects(
    () => readBlob("bafyGone", { source }),
    (error: unknown) => {
      assert.ok(error instanceof BlobUnavailableError);
      // `'host'` — we asked, and this object did not come back. A fact about the CID, not the session.
      assert.equal(error.source, "host");
      assert.match((error.cause as Error).message, /stub has no bafyGone/);
      return true;
    },
  );
  assert.deepEqual(source.calls(), ["bafyGone"], "no retry ladder — that lives in blob-cache's miss ttl");
});

test("a slow source is bounded by the timeout it was handed, and the timeout is honoured", async () => {
  const seen: number[] = [];
  const slow: BulletinSource = {
    label: "slow",
    read: (_cid, options) =>
      new Promise((_resolve, reject) => {
        seen.push(options.timeoutMs);
        // Stands in for the SDK's own `lookupViaHost`, which rejects on its own timer.
        setTimeout(() => reject(new Error(`lookup timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
      }),
  };

  const started = Date.now();
  await assert.rejects(() => readBlob("bafySlow", { source: slow, timeoutMs: 20 }), BlobUnavailableError);
  assert.deepEqual(seen, [20], "the caller's budget reaches the SDK as lookupTimeoutMs");
  assert.ok(Date.now() - started < 2_000, "a timeout is a bounded failure, not a hang");
});

test("bytes are required — a source that resolves with nothing is a failure, not an empty post", async () => {
  const lying: BulletinSource = { label: "lying", read: async () => undefined as unknown as Uint8Array };
  await assert.rejects(() => readBlob("bafy1", { source: lying }), BlobUnavailableError);
});

test("a shape that cannot be a CID never reaches the source", async () => {
  const source = stubSource({ bafy1: "body" });
  for (const bad of ["", "has space", null as unknown as string]) {
    await assert.rejects(() => readBlob(bad, { source }), BlobUnavailableError);
  }
  assert.deepEqual(source.calls(), [], "validation happens before the host is bothered");
});

/* ─────────────────────────────────────────────────── the timeout choice ── */

test("the lookup budget is deliberately far below the SDK's 30 s per-lookup default", () => {
  // 30 s is the documented `QueryOptions.lookupTimeoutMs` default, applied PER LOOKUP. `walkChain`
  // advances one entry per iteration, so a 20-entry page would serialise up to ten minutes of it.
  assert.ok(DEFAULT_LOOKUP_TIMEOUT_MS < 30_000, "the SDK default is a page-killer for a chained walk");
  // …and not so short that it manufactures failures: the same objects measured 103–395 ms p50 over
  // public gateways, a strictly longer route than a local host subscription.
  assert.ok(DEFAULT_LOOKUP_TIMEOUT_MS >= 5_000, "short enough to be brisk, not short enough to invent misses");
});

/* ───────────────────────────────────────────────────── the install seam ── */

test("⭐ the source is resolved PER READ, not captured when the fetcher was built", async () => {
  setBulletinSource(null);
  // This is the ordering the app actually has: the list hooks build their fetcher in a
  // `useMemo(…, [])` on first render, which runs before `openBackend()` finishes the handshake.
  const fetcher = bulletinFetcher();
  await assert.rejects(() => fetcher("bafy1"), BlobUnavailableError);

  setBulletinSource(stubSource({ bafy1: "arrived late" }));
  assert.equal(
    decode(await fetcher("bafy1")),
    "arrived late",
    "a fetcher built before the host opened must still work once it has",
  );
});

test("clearing the source puts the session back into the honest no-read-path state", async () => {
  setBulletinSource(stubSource({ bafy1: "body" }));
  assert.equal(bulletinSource()?.label, "stub");

  // What `destroy()` does on both backends. A stale source would answer from a torn-down host.
  setBulletinSource(null);
  assert.equal(bulletinSource(), null);
  await assert.rejects(
    () => bulletinFetcher()("bafy1"),
    (error: unknown) => (error as BlobUnavailableError).source === "none",
  );
});

test("bulletinFetcher is the shape createBlobCache wants, and passes its budget through", async () => {
  const source = stubSource({ bafy1: "via fetcher" });
  const fetcher = bulletinFetcher({ source, timeoutMs: 1_234 });
  assert.equal(decode(await fetcher("bafy1")), "via fetcher");
  assert.deepEqual(source.timeouts(), [1_234]);

  // The default the app actually runs with.
  const plain = stubSource({ bafy1: "x" });
  await bulletinFetcher({ source: plain })("bafy1");
  assert.deepEqual(plain.timeouts(), [DEFAULT_LOOKUP_TIMEOUT_MS]);
});

// Leave the module in its resting state; these tests share one process with every other lib suite.
test("teardown", () => {
  setBulletinSource(null);
  assert.equal(bulletinSource(), null);
});
