// Run: node --experimental-strip-types --test src/lib/gateways.test.ts
//
// `fetch` is injected, so the race, the aborts and the failure semantics are testable offline.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BlobUnavailableError,
  DEFAULT_FETCH_TIMEOUT_MS,
  GATEWAYS,
  LARGE_FETCH_TIMEOUT_MS,
  blobUrl,
  blobUrls,
  fetchBlob,
  gatewayFetcher,
} from "./gateways.ts";

const ok = (text: string) =>
  ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(text).buffer }) as unknown as Response;

const failure = (status: number) => ({ ok: false, status }) as unknown as Response;

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/* ─────────────────────────────────────────────────────────── the list ── */

test("the measured-dead gateway is absent and the measured-best is first", () => {
  assert.ok(
    !GATEWAYS.some((gateway) => gateway.includes("paseo-bulletin-next-ipfs.polkadot.io")),
    "1/16 with 504s — survey ships it first and Promise.any masks the failure",
  );
  assert.match(GATEWAYS[0], /devnet-ipfs\.api\.polkadotcommunity\.foundation/);
  for (const host of ["nftstorage.link", "ipfs.io", "dweb.link"]) {
    assert.ok(GATEWAYS.some((gateway) => gateway.includes(host)), `${host} was measured good`);
  }
  assert.ok(GATEWAYS.every((gateway) => gateway.startsWith("https://") && gateway.endsWith("/ipfs/")));
});

test("the large-payload timeout is longer than the object timeout, because size dominates", () => {
  assert.ok(LARGE_FETCH_TIMEOUT_MS > DEFAULT_FETCH_TIMEOUT_MS);
  assert.ok(LARGE_FETCH_TIMEOUT_MS >= 12_400, "measured worst case was 12.4 s");
});

/* ─────────────────────────────────────────────────────────────── URLs ── */

test("blobUrl and blobUrls refuse a shape that cannot be a CID", () => {
  assert.equal(blobUrl("bafy1"), `${GATEWAYS[0]}bafy1`);
  assert.equal(blobUrl(""), null);
  assert.equal(blobUrl(null), null);
  assert.equal(blobUrl("has space"), null);
  assert.deepEqual(blobUrls("bafy1").length, GATEWAYS.length);
  assert.deepEqual(blobUrls(""), []);
  assert.equal(blobUrls("bafy1")[0], `${GATEWAYS[0]}bafy1`, "the retry ladder keeps measured order");
});

/* ────────────────────────────────────────────────────────── the race ── */

test("one healthy gateway is enough, however many are dead", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    seen.push(url);
    return url.includes("nftstorage.link") ? ok("payload") : failure(504);
  }) as unknown as typeof fetch;

  const bytes = await fetchBlob("bafy1", { fetchImpl });
  assert.equal(decode(bytes), "payload");
  assert.equal(seen.length, GATEWAYS.length, "all gateways are raced, not tried in sequence");
});

test("when nothing can serve it, that is BlobUnavailableError and it names the CID", async () => {
  const fetchImpl = (async () => failure(504)) as unknown as typeof fetch;
  await assert.rejects(
    () => fetchBlob("bafyGone", { fetchImpl }),
    (error: unknown) => {
      assert.ok(error instanceof BlobUnavailableError);
      assert.equal(error.cid, "bafyGone");
      assert.equal(error.attempts, GATEWAYS.length);
      assert.match(error.message, /No gateway could serve bafyGone/);
      return true;
    },
  );
});

test("the losers are aborted, so a page of 20 objects does not leak sockets", async () => {
  const signals: AbortSignal[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (init.signal) signals.push(init.signal);
    if (url.includes(GATEWAYS[0])) return ok("fast");
    return new Promise<Response>(() => {}); // never settles
  }) as unknown as typeof fetch;

  assert.equal(decode(await fetchBlob("bafy1", { fetchImpl })), "fast");
  assert.ok(signals.length > 0);
  assert.ok(
    signals.every((signal) => signal.aborted),
    "every in-flight request is cancelled once one wins",
  );
});

test("a timeout is a normal unavailability, not a hang", async () => {
  const fetchImpl = (async (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as unknown as typeof fetch;

  await assert.rejects(() => fetchBlob("bafySlow", { fetchImpl, timeoutMs: 20 }), BlobUnavailableError);
});

test("an already-aborted caller signal short-circuits", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    if (init.signal?.aborted) throw new Error("aborted before send");
    return ok("should not get here");
  }) as unknown as typeof fetch;

  await assert.rejects(() => fetchBlob("bafy1", { fetchImpl, signal: controller.signal }), BlobUnavailableError);
});

test("missing prerequisites fail as unavailability, with the CID attached", async () => {
  await assert.rejects(() => fetchBlob("", {}), BlobUnavailableError);
  await assert.rejects(() => fetchBlob("bafy1", { fetchImpl: undefined as never }), BlobUnavailableError);
  await assert.rejects(
    () => fetchBlob("bafy1", { fetchImpl: (async () => ok("x")) as unknown as typeof fetch, gateways: [] }),
    BlobUnavailableError,
  );
});

test("gatewayFetcher is the shape the blob cache wants", async () => {
  const fetcher = gatewayFetcher({ fetchImpl: (async () => ok("via fetcher")) as unknown as typeof fetch });
  assert.equal(decode(await fetcher("bafy1")), "via fetcher");
});

test("a custom gateway list is honoured, so a test or a host proxy can override", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    seen.push(url);
    return ok("mine");
  }) as unknown as typeof fetch;

  await fetchBlob("bafy1", { fetchImpl, gateways: ["https://example.test/ipfs/"] });
  assert.deepEqual(seen, ["https://example.test/ipfs/bafy1"]);
});
