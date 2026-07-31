// The two-signature write, tested where it cannot be observed.
//
// This path only runs inside a host container — on a phone — where every bug costs a deploy to see.
// That is the whole reason `createPublisher` takes its chain access as functions: the invariants
// below (body before pointer, the right `prev`, the cache seeded with our own bytes) are the ones
// that produce silent, permanent damage when they are wrong, and none of them needs a chain to check.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPublisher, NO_GROUP, type HeadRow, type WriteHeadArgs } from "./publish.ts";
import { encodeMessage, decodeObject } from "./wire.ts";
import type { BlobCache } from "./blob-cache.ts";

const AUTHOR = "0x18773c30d65de35027ac8cd19e98c0ddb9c44ef9";
const REGISTRY = `0x${"11".repeat(32)}`;

interface Recorder {
  calls: string[];
  stored: Uint8Array[];
  writes: WriteHeadArgs[];
}

/** A publisher over a fake chain. `heads` is mutated by the write, so the confirm poll is real. */
function harness(options: { head?: HeadRow | null; confirmAfter?: number; cache?: BlobCache } = {}) {
  const rec: Recorder = { calls: [], stored: [], writes: [] };
  let head: HeadRow | null = options.head ?? null;
  let pending: HeadRow | null = null;
  let reads = 0;
  const confirmAfter = options.confirmAfter ?? 0;
  let cidCounter = 0;

  const publisher = createPublisher({
    author: AUTHOR,
    async readHead() {
      rec.calls.push("readHead");
      reads += 1;
      // The head the chain reports lags the write by `confirmAfter` reads — the real behaviour, where
      // the host settles at best-block and a native extrinsic returns no receipt to await.
      if (pending && reads > confirmAfter) {
        head = pending;
        pending = null;
      }
      return head;
    },
    async putBlob(bytes) {
      rec.calls.push("putBlob");
      rec.stored.push(bytes);
      cidCounter += 1;
      return `bafytest${cidCounter}`;
    },
    async writeHead(args) {
      rec.calls.push("writeHead");
      rec.writes.push(args);
      reads = 0;
      pending = { cid: args.cid, prev: args.prev || null, at: 1_000, by: AUTHOR };
      return { txHash: "0xdeadbeef" };
    },
    now: () => 0, // the deadline never passes; `confirmAfter` decides when confirmation happens
    sleep: async () => {},
  });

  assert.ok(publisher, "the harness must produce a publisher");
  return { publisher, rec };
}

const draft = (body: string) => encodeMessage({ author: AUTHOR, body, at: 1 });

describe("createPublisher", () => {
  it("refuses to exist when any half of the write path is missing", () => {
    const io = {
      author: AUTHOR,
      readHead: async () => null,
      putBlob: async () => "cid",
      writeHead: async () => ({ txHash: "0x" }),
    };
    assert.equal(createPublisher({}), null);
    assert.equal(createPublisher({ ...io, author: undefined }), null);
    assert.equal(createPublisher({ ...io, putBlob: undefined }), null);
    assert.equal(createPublisher({ ...io, writeHead: undefined }), null, "no pointer write, no publish");
    assert.ok(createPublisher(io));
  });

  it("stores the body BEFORE moving the pointer", async () => {
    const { publisher, rec } = harness();
    await publisher.publish({ registry: REGISTRY, build: () => draft("hello") });

    // The other order would move a head to a CID no gateway can serve — a permanent hole that every
    // later reader walks into. An orphaned body, by contrast, just expires.
    assert.ok(
      rec.calls.indexOf("putBlob") < rec.calls.indexOf("writeHead"),
      `body must precede pointer, got ${rec.calls.join(" → ")}`,
    );
  });

  it("does not move the pointer when the body write fails", async () => {
    const rec: string[] = [];
    const publisher = createPublisher({
      author: AUTHOR,
      readHead: async () => null,
      putBlob: async () => {
        throw new Error("Bulletin rejected the write");
      },
      writeHead: async () => {
        rec.push("writeHead");
        return { txHash: "0x" };
      },
    });
    const error = await publisher!.publish({ registry: REGISTRY, build: () => draft("hi") }).then(
      () => null,
      (e: unknown) => e,
    );

    // ⭐ THE INVARIANT THIS TEST EXISTS FOR, and it is the assertion below, not the message. The
    // reverse ordering moves a head to a CID no gateway can serve — a permanent hole every later
    // reader walks into.
    assert.deepEqual(rec, [], "a failed body must never leave a dangling pointer");

    // `publish()` now wraps write failures for the user (`lib/host/errors.ts`), so the raw text is no
    // longer the message. It is WRAPPED, NOT REPLACED — assert on both halves, because a wrapper that
    // loses the cause is how a debuggable failure becomes an unactionable one.
    assert.equal((error as { name?: string })?.name, "WriteFailure");
    assert.match(String((error as { cause?: unknown })?.cause), /Bulletin rejected/);

    // And the half that matters to the person: nothing was stored, so retrying is safe. A body
    // failure must never inherit the "your post is saved" copy the pointer failures use.
    assert.equal((error as { stored?: boolean })?.stored, false);
    assert.doesNotMatch(String((error as { message?: string })?.message), /saved|not lost/i);
  });

  it("links a new object to the current head, and passes that head as `prev` on chain", async () => {
    const { publisher, rec } = harness({
      head: { cid: "bafyOLD", prev: "bafyOLDER", at: 900, by: AUTHOR },
    });

    let seenPrev: string | null | undefined;
    await publisher.publish({
      registry: REGISTRY,
      build: (link) => {
        seenPrev = link.prev;
        return draft("next");
      },
    });

    assert.equal(seenPrev, "bafyOLD", "the new object links back to the head it is replacing");
    assert.equal(rec.writes[0].prev, "bafyOLD", "and the contract records the same link");
    assert.equal(rec.writes[0].group, NO_GROUP, "no group means the registry routes to itself");
    assert.equal(rec.writes[0].storeBlock, 0n, "0 is 'unknown', which is the truth for a preimage write");
  });

  it("starts a chain with an empty `prev` when the author holds no head", async () => {
    const { publisher, rec } = harness({ head: null });
    let seenPrev: string | null | undefined = "unset";
    await publisher.publish({
      registry: REGISTRY,
      build: (link) => {
        seenPrev = link.prev;
        return draft("first");
      },
    });
    assert.equal(seenPrev, null);
    assert.equal(rec.writes[0].prev, "", "the contract's empty string means 'start of chain'");
  });

  it("seeds the cache with the exact bytes it stored", async () => {
    const seeded = new Map<string, string>();
    const cache = {
      put: (cid: string, text: string) => void seeded.set(cid, text),
      get: async () => null,
    } as unknown as BlobCache;

    const { publisher } = harness();
    const { cid } = await publisher.publish({
      registry: REGISTRY,
      cache,
      build: () => draft("mine"),
    });

    // Without this a user's own post renders as "(content no longer available)" for the first few
    // minutes, because a fresh CID takes that long to reach public gateways.
    const text = seeded.get(cid);
    assert.ok(text, "the CID we just wrote must be readable without a gateway");
    const decoded = decodeObject(text!);
    assert.equal(decoded?.kind, "msg");
    assert.equal(decoded?.kind === "msg" ? decoded.body : null, "mine");
  });

  it("recovers the skip ladder from the cached tip, and shifts it forward", async () => {
    // A tip that already carries a ladder: its `prev` becomes the new object's distance 2, and its
    // own ladder becomes distances 3, 4… — the shift is free, which is why the ladder is linear.
    const tip = encodeMessage({
      author: AUTHOR,
      body: "tip",
      at: 5,
      prev: "bafyA",
      skips: ["bafyB", "bafyC"],
    });
    const cache = {
      put: () => {},
      get: async () => JSON.stringify(tip),
    } as unknown as BlobCache;

    const { publisher } = harness({ head: { cid: "bafyTIP", prev: "bafyA", at: 5, by: AUTHOR } });
    let ladder: string[] = [];
    await publisher.publish({
      registry: REGISTRY,
      cache,
      build: (link) => {
        ladder = link.skips;
        return draft("next");
      },
    });
    assert.deepEqual(ladder, ["bafyA", "bafyB", "bafyC"]);
  });

  it("falls back to a one-rung ladder when the tip's body cannot be read", async () => {
    const cache = { put: () => {}, get: async () => null } as unknown as BlobCache;
    const { publisher } = harness({ head: { cid: "bafyTIP", prev: "bafyA", at: 5, by: AUTHOR } });
    let ladder: string[] = [];
    await publisher.publish({
      registry: REGISTRY,
      cache,
      build: (link) => {
        ladder = link.skips;
        return draft("next");
      },
    });
    // Degraded, never wrong: the chain still reads, it just cannot step over as many dead objects.
    assert.deepEqual(ladder, ["bafyA"]);
  });

  it("reports `confirmed: false` rather than pretending, when the read side lags past the deadline", async () => {
    let clock = 0;
    const publisher = createPublisher({
      author: AUTHOR,
      readHead: async () => null, // never catches up
      putBlob: async () => "bafyNEW",
      writeHead: async () => ({ txHash: "0xabc" }),
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
    });

    const result = await publisher!.publish({ registry: REGISTRY, build: () => draft("slow") });
    assert.equal(result.txHash, "0xabc", "the write DID land — only the read is behind");
    assert.equal(result.confirmed, false);
  });

  it("confirms once the read side catches up", async () => {
    const { publisher } = harness({ confirmAfter: 3 });
    const result = await publisher.publish({ registry: REGISTRY, build: () => draft("eventual") });
    assert.equal(result.confirmed, true);
  });

  it("publishes even when the head read fails outright", async () => {
    // A read failure must not block a write. The worst case is a new branch, and several heads per
    // registry is the normal case — the client merges them.
    const writes: WriteHeadArgs[] = [];
    let clock = 0;
    const publisher = createPublisher({
      author: AUTHOR,
      readHead: async () => {
        throw new Error("RPC down");
      },
      putBlob: async () => "bafyNEW",
      writeHead: async (args) => {
        writes.push(args);
        return { txHash: "0x1" };
      },
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
    });

    const result = await publisher!.publish({ registry: REGISTRY, build: () => draft("anyway") });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].prev, "");
    assert.equal(result.confirmed, false);
  });
});
