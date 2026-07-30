// Run: node --experimental-strip-types --test src/lib/walk.test.ts
//
// The walk is pure apart from the injected cache, so the whole algorithm — paging, branch merging,
// hole stepping, first-hole truncation, cursor round-trips — is testable with a Map of blobs.

import { test } from "node:test";
import assert from "node:assert/strict";

import { SKIP_LEVELS, encodeMessage, encodePost, linkFrom } from "./wire.ts";
import type { ChainTip } from "./wire.ts";
import {
  DEFAULT_PAGE_LIMIT,
  decodeCursor,
  describeEntry,
  encodeCursor,
  summarisePage,
  walkChain,
} from "./walk.ts";
import type { HeadInput, WalkEntry, WalkPage } from "./walk.ts";

const ALICE = "0xa11ce";
const BOB = "0xb0b";

interface Tip extends ChainTip {
  cid: string;
  prev: string | null;
  skips: string[];
  author: string;
  at: number;
}

/** A chain fixture: real encoded objects in a Map, keyed by CIDs we assign. */
function fixture() {
  const blobs = new Map<string, string>();
  let counter = 0;

  const append = (
    tip: Tip | null,
    options: { author?: string; at: number; body?: string; attachments?: { cid: string; mime: string }[] },
  ): Tip => {
    const author = options.author ?? ALICE;
    const link = linkFrom(tip);
    const object = options.attachments
      ? encodePost({ body: options.body ?? "post", author, at: options.at, attachments: options.attachments, ...link })
      : encodeMessage({ body: options.body ?? "msg", author, at: options.at, ...link });
    const cid = `cid${(counter += 1)}`;
    blobs.set(cid, JSON.stringify(object));
    return { cid, prev: link.prev, skips: link.skips, author, at: options.at };
  };

  const chain = (count: number, options: { author?: string; base?: number; step?: number } = {}) => {
    const { base = 1_000, step = 1_000 } = options;
    const tips: Tip[] = [];
    let tip: Tip | null = null;
    for (let i = 0; i < count; i += 1) {
      tip = append(tip, { author: options.author, at: base + i * step, body: `m${i}` });
      tips.push(tip);
    }
    return tips;
  };

  const cache = {
    get: async (cid: string) => blobs.get(cid) ?? null,
  };

  return { blobs, append, chain, cache };
}

const bodies = (page: WalkPage) =>
  page.entries.map((entry) => (entry.object && "body" in entry.object ? entry.object.body : `«${entry.cid}»`));

/** Drain every page, the way an infinite scroll would. */
async function drain(cache: { get: (cid: string) => Promise<string | null> }, heads: HeadInput[], limit: number) {
  const all: WalkEntry[] = [];
  const ends: (null | "start" | "expired")[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 50; guard += 1) {
    const page: WalkPage = await walkChain({ heads, cache, limit, cursor });
    all.push(...page.entries);
    ends.push(page.end);
    cursor = page.cursor;
    if (!cursor) break;
  }
  return { all, ends, last: ends[ends.length - 1] };
}

/* ───────────────────────────────────────────────────────── the simple case ── */

test("walks newest-first and reports reaching the start", async () => {
  const f = fixture();
  const tips = f.chain(5);

  const page = await walkChain({ heads: [tips[4].cid], cache: f.cache });

  assert.deepEqual(bodies(page), ["m4", "m3", "m2", "m1", "m0"]);
  assert.equal(page.end, "start");
  assert.equal(page.cursor, null);
  assert.equal(page.holes, 0);
  assert.equal(page.truncated, false);
  assert.equal(page.truncatedAt, null);
});

test("an empty registry has reached the start, and nothing is missing", async () => {
  const f = fixture();
  const page = await walkChain({ heads: [], cache: f.cache });
  assert.deepEqual(page.entries, []);
  assert.equal(page.end, "start");
  assert.equal(page.cursor, null);
  assert.equal(page.truncated, false);
});

test("the default page limit is respected and leaves a cursor", async () => {
  const f = fixture();
  const tips = f.chain(DEFAULT_PAGE_LIMIT + 3);
  const page = await walkChain({ heads: [tips.at(-1)!.cid], cache: f.cache });
  assert.equal(page.entries.length, DEFAULT_PAGE_LIMIT);
  assert.equal(page.end, null);
  assert.ok(page.cursor);
});

test("paging never duplicates or drops an object", async () => {
  const f = fixture();
  const tips = f.chain(7);
  const { all, last } = await drain(f.cache, [tips[6].cid], 2);

  assert.deepEqual(
    all.map((entry) => (entry.object && "body" in entry.object ? entry.object.body : "?")),
    ["m6", "m5", "m4", "m3", "m2", "m1", "m0"],
  );
  assert.equal(new Set(all.map((entry) => entry.cid)).size, 7);
  assert.equal(last, "start");
});

/* ───────────────────────────────────────────────────────── branch merging ── */

test("several valid heads is normal: branches merge, ordered by claimed time", async () => {
  const f = fixture();
  const base = f.chain(3); // shared history: 1000, 2000, 3000

  const a1 = f.append(base[2], { author: ALICE, at: 4_000, body: "a1" });
  const b1 = f.append(base[2], { author: BOB, at: 5_000, body: "b1" });
  const a2 = f.append(a1, { author: ALICE, at: 6_000, body: "a2" });
  const b2 = f.append(b1, { author: BOB, at: 7_000, body: "b2" });

  const page = await walkChain({ heads: [a2.cid, b2.cid], cache: f.cache, limit: 20 });

  assert.deepEqual(bodies(page), ["b2", "a2", "b1", "a1", "m2", "m1", "m0"]);
  assert.equal(page.end, "start");
  assert.equal(new Set(page.entries.map((entry) => entry.cid)).size, 7, "the shared tail is emitted once");
});

test("a fork paged in small pages still emits the shared tail exactly once", async () => {
  const f = fixture();
  const base = f.chain(3);
  const a1 = f.append(base[2], { author: ALICE, at: 4_000, body: "a1" });
  const b1 = f.append(base[2], { author: BOB, at: 5_000, body: "b1" });

  const { all, last } = await drain(f.cache, [a1.cid, b1.cid], 2);

  assert.deepEqual(
    all.map((entry) => (entry.object && "body" in entry.object ? entry.object.body : "?")),
    ["b1", "a1", "m2", "m1", "m0"],
  );
  assert.equal(new Set(all.map((entry) => entry.cid)).size, 5);
  assert.equal(last, "start");
});

test("head order does not matter", async () => {
  const f = fixture();
  const base = f.chain(2);
  const a = f.append(base[1], { at: 3_000, body: "a" });
  const b = f.append(base[1], { author: BOB, at: 4_000, body: "b" });

  const forward = await walkChain({ heads: [a.cid, b.cid], cache: f.cache });
  const reverse = await walkChain({ heads: [b.cid, a.cid], cache: f.cache });
  assert.deepEqual(bodies(forward), bodies(reverse));
});

/* ──────────────────────────────────────────── holes and first-hole truncation ── */

test("one lapsed object is a hole, not the end — and it still says who and when", async () => {
  const f = fixture();
  const tips = f.chain(5);
  f.blobs.delete(tips[2].cid); // the middle object expires

  const page = await walkChain({ heads: [tips[4].cid], cache: f.cache, limit: 20 });

  assert.deepEqual(bodies(page), ["m4", "m3", `«${tips[2].cid}»`, "m1", "m0"]);
  assert.equal(page.end, "start", "the ladder got past a single hole, so the start is genuine");
  assert.equal(page.holes, 1);
  assert.equal(page.truncated, true);
  assert.equal(page.truncatedAt, null);

  const hole = page.entries[2];
  assert.equal(hole.missing, true);
  assert.equal(hole.object, null);
  assert.equal(hole.author, ALICE, "recovered from the successor's prevAuthor");
  assert.equal(hole.at, tips[2].at, "recovered from the successor's prevAt");
});

test("the ladder steps over up to SKIP_LEVELS consecutive holes", async () => {
  const f = fixture();
  const tips = f.chain(8);
  // Exactly SKIP_LEVELS holes: reachable, because the ladder covers distances 2…SKIP_LEVELS+1.
  for (let i = 6; i > 6 - SKIP_LEVELS; i -= 1) f.blobs.delete(tips[i].cid);

  const page = await walkChain({ heads: [tips[7].cid], cache: f.cache, limit: 20 });

  assert.equal(page.holes, SKIP_LEVELS);
  assert.equal(page.end, "start");
  assert.ok(
    bodies(page).includes("m0"),
    "history older than the run of holes is still reachable while the ladder holds",
  );
});

test("A CHAIN TRUNCATES AT THE FIRST HOLE, not from the tail — and says so", async () => {
  const f = fixture();
  const tips = f.chain(8);
  // One more than the ladder can bridge. Objects 0–2 are still perfectly available on the
  // gateways; they are simply unreachable, because every pointer to them was inside a dead object.
  const dead = [6, 5, 4, 3].slice(0, SKIP_LEVELS + 1);
  for (const i of dead) f.blobs.delete(tips[i].cid);

  const page = await walkChain({ heads: [tips[7].cid], cache: f.cache, limit: 20 });

  assert.equal(page.end, "expired", "this is a terminal state, and it is NOT 'start'");
  assert.equal(page.truncatedAt, tips[3].cid, "the CID the walk gave up on");
  assert.equal(page.holes, SKIP_LEVELS + 1);

  const reachable = new Set(page.entries.map((entry) => entry.cid));
  for (const i of [0, 1, 2]) {
    assert.ok(f.blobs.has(tips[i].cid), "the older object is still servable");
    assert.ok(!reachable.has(tips[i].cid), "…but orphaned behind the hole, which is the whole point");
  }

  const summary = summarisePage(page);
  assert.equal(summary.historyLost, true);
  assert.match(summary.message ?? "", /earlier content has expired/);
});

test("a dead head with an index-recorded prev is not the end of the world", async () => {
  const f = fixture();
  const tips = f.chain(3);
  f.blobs.delete(tips[2].cid);

  // heads.get() returns the CID *and* its prev, so the index can bridge an expired head object.
  const page = await walkChain({
    heads: [{ cid: tips[2].cid, prev: tips[1].cid, at: tips[2].at, by: ALICE, block: 42, index: 3 }],
    cache: f.cache,
    limit: 10,
  });

  assert.deepEqual(bodies(page), [`«${tips[2].cid}»`, "m1", "m0"]);
  assert.equal(page.end, "start");
  assert.equal(page.entries[0].head?.block, 42, "block/index ride along for renew(block, index)");
  assert.equal(page.entries[0].head?.index, 3);
  assert.equal(page.entries[0].author, ALICE, "the index's attribution, not a self-assertion");
});

test("bytes that are not one of our objects count as a hole, not a crash", async () => {
  const f = fixture();
  const tips = f.chain(2);
  f.blobs.set(tips[1].cid, "<!doctype html><html>a gateway error page</html>");

  const page = await walkChain({ heads: [tips[1].cid], cache: f.cache });
  assert.equal(page.entries[0].missing, true);
  assert.equal(page.holes, 1);
  assert.equal(page.end, "expired", "with no decodable successor there is no prev to follow");
});

test("a hole's cause is guessed from age and labelled honestly", async () => {
  const f = fixture();
  const now = 10_000_000_000;

  const fresh = f.chain(2, { base: now - 30_000, step: 1_000 });
  f.blobs.delete(fresh[0].cid);
  const pending = await walkChain({ heads: [fresh[1].cid], cache: f.cache, now: () => now });
  assert.equal(pending.entries[1].unavailable, "pending", "written seconds ago: propagation, not expiry");

  const g = fixture();
  const old = g.chain(2, { base: 1_000, step: 1_000 });
  g.blobs.delete(old[0].cid);
  const expired = await walkChain({ heads: [old[1].cid], cache: g.cache, now: () => now });
  assert.equal(expired.entries[1].unavailable, "expired");
});

/* ─────────────────────────────────────────────────────────────── cursors ── */

test("a cursor round-trips, and re-encoding a decoded cursor is stable", async () => {
  const f = fixture();
  const tips = f.chain(6);

  const first = await walkChain({ heads: [tips[5].cid], cache: f.cache, limit: 2 });
  assert.ok(first.cursor);

  const slots = decodeCursor(first.cursor);
  assert.ok(slots);
  assert.equal(slots.length, 1);
  assert.equal(encodeCursor(slots), first.cursor, "decode ∘ encode is the identity");

  const resumed = await walkChain({ heads: [], cache: f.cache, limit: 2, cursor: encodeCursor(slots) });
  assert.deepEqual(bodies(resumed), ["m3", "m2"]);
});

test("a forked cursor carries a frontier of several CIDs", async () => {
  const f = fixture();
  const base = f.chain(4);
  const a = f.append(base[3], { at: 5_000, body: "a" });
  const b = f.append(base[3], { author: BOB, at: 6_000, body: "b" });

  const page = await walkChain({ heads: [a.cid, b.cid], cache: f.cache, limit: 1 });
  const slots = decodeCursor(page.cursor);
  assert.ok(slots);
  assert.equal(slots.length, 2, "a cursor is a frontier, not a position");
});

test("a mangled or foreign cursor restarts the walk instead of throwing", async () => {
  for (const cursor of ["", "!!!!", "e30", btoa('{"v":99,"f":[{"c":"x"}]}'), null, undefined]) {
    assert.equal(decodeCursor(cursor), null, `cursor: ${String(cursor)}`);
  }
  const f = fixture();
  const tips = f.chain(2);
  const page = await walkChain({ heads: [tips[1].cid], cache: f.cache, cursor: "garbage" });
  assert.deepEqual(bodies(page), ["m1", "m0"]);
});

test("the cursor is opaque: nothing in it is a bare CID a caller could parse", () => {
  const encoded = encodeCursor([
    { cid: "cid9", viaAuthor: ALICE, viaAt: 5, fallbacks: ["cid8"], head: null },
  ]);
  assert.ok(encoded);
  assert.ok(!encoded.includes("cid9"), "base64url, so a caller cannot pattern-match a CID out of it");
  assert.equal(encodeCursor([]), null);
});

/* ────────────────────────────────────────── per-field availability ── */

test("a post can lose its images and keep its text", async () => {
  const f = fixture();
  const post = f.append(null, {
    at: 5_000,
    body: "two pictures",
    attachments: [
      { cid: "img-live", mime: "image/webp" },
      { cid: "img-gone", mime: "image/webp" },
    ],
  });

  const page = await walkChain({ heads: [post.cid], cache: f.cache });
  const view = describeEntry(page.entries[0], {
    cache: { knownMissing: (cid: string) => cid === "img-gone" },
    urlFor: (cid) => `https://gw/${cid}`,
    urlsFor: (cid) => [`https://gw/${cid}`],
    now: () => 5_000,
  });

  assert.equal(view.bodyState, "loaded");
  assert.equal(view.attachments.length, 2);
  assert.equal(view.attachments[0].state, "remote");
  assert.equal(view.attachments[0].url, "https://gw/img-live");
  assert.equal(view.attachments[1].state, "unavailable");
  assert.ok(view.expiresAt && view.expiresAt > 5_000, "a deadline, not a checkmark");
});

test("our own upload renders immediately, before any gateway has seen it", async () => {
  const f = fixture();
  const post = f.append(null, { at: 1, body: "just posted", attachments: [{ cid: "mine", mime: "image/webp" }] });
  const page = await walkChain({ heads: [post.cid], cache: f.cache });

  const view = describeEntry(page.entries[0], {
    localBlobs: { url: (cid: string) => (cid === "mine" ? "blob:local" : null) },
    cache: { knownMissing: () => true }, // even though a gateway race already failed
    urlFor: () => "https://gw/mine",
  });

  assert.equal(view.attachments[0].state, "local");
  assert.equal(view.attachments[0].url, "blob:local");
});

test("a hole describes as an unavailable body with a reason", async () => {
  const f = fixture();
  const tips = f.chain(2);
  f.blobs.delete(tips[0].cid);
  const page = await walkChain({ heads: [tips[1].cid], cache: f.cache, now: () => 10_000_000_000 });

  const view = describeEntry(page.entries[1]);
  assert.equal(view.bodyState, "unavailable");
  assert.equal(view.reason, "expired");
  assert.deepEqual(view.attachments, []);
});

test("summarisePage separates 'no more pages' from 'history is gone'", async () => {
  const f = fixture();
  const tips = f.chain(3);
  const clean = summarisePage(await walkChain({ heads: [tips[2].cid], cache: f.cache }));
  assert.equal(clean.historyLost, false);
  assert.equal(clean.message, null);

  f.blobs.delete(tips[1].cid);
  const holed = summarisePage(await walkChain({ heads: [tips[2].cid], cache: f.cache }));
  assert.equal(holed.holes, 1);
  assert.match(holed.message ?? "", /1 item is no longer available/);
});
