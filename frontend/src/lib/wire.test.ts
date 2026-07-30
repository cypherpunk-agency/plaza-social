// Run: node --experimental-strip-types --test src/lib/wire.test.ts
//
// These are pure functions, so they are genuinely testable without a host, a container, or a
// network. Nothing here mocks the SDK because nothing here touches it.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALT_MAX_CHARS,
  CHAT_BODY_MAX_CHARS,
  MAX_ATTACHMENTS,
  MAX_OBJECT_BYTES,
  MAX_TAGS,
  POST_BODY_MAX_CHARS,
  SKIP_LEVELS,
  TITLE_MAX_CHARS,
  WIRE_VERSION,
  WireError,
  assertObjectSize,
  byteLength,
  countChars,
  decodeObject,
  encodeDirectory,
  encodeMessage,
  encodePost,
  encodeThread,
  excerptOf,
  expiresAt,
  linkFrom,
  validatePostDraft,
  validateThreadDraft,
} from "./wire.ts";
import type { DecodedPost, DecodedThread, WireObject } from "./wire.ts";

const AUTHOR = "0x1111111111111111111111111111111111111111";
const CID_A = "bafyaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const CID_B = "bafyaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2";
const CID_C = "bafyaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3";

const roundTrip = (object: WireObject) => decodeObject(JSON.stringify(object));

const throwsWire = (fn: () => unknown, expected: { code: string; field: string }) => {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof WireError, `expected a WireError, got ${String(error)}`);
    assert.equal(error.code, expected.code);
    assert.equal(error.field, expected.field);
    assert.ok(error.message.length > 10, "a refusal must be a renderable sentence");
    return true;
  });
};

/* ─────────────────────────────────────────────────────────── round trips ── */

test("msg round-trips through the envelope", () => {
  const object = encodeMessage({ body: "  hello  ", author: AUTHOR, at: 1_700_000_000_000, prev: CID_A });
  const decoded = decodeObject(JSON.stringify(object));

  assert.ok(decoded);
  assert.equal(decoded.kind, "msg");
  assert.equal(decoded.author, AUTHOR);
  assert.equal(decoded.at, 1_700_000_000_000);
  assert.equal(decoded.prev, CID_A);
  assert.equal(decoded.kind === "msg" && decoded.body, "hello"); // trimmed, not truncated
});

test("post carries an ARRAY of attachments, each with its own metadata", () => {
  const object = encodePost({
    body: "look at these",
    author: AUTHOR,
    at: 5,
    index: 7,
    attachments: [
      { cid: CID_A, mime: "image/webp", width: 1600, height: 900, alt: "a chart" },
      { cid: CID_B, mime: "image/gif" },
    ],
  });
  const decoded = roundTrip(object) as DecodedPost | null;

  assert.ok(decoded);
  assert.equal(decoded.kind, "post");
  assert.equal(decoded.index, 7);
  assert.equal(decoded.attachments.length, 2);
  assert.deepEqual(decoded.attachments[0], {
    cid: CID_A,
    mime: "image/webp",
    width: 1600,
    height: 900,
    alt: "a chart",
  });
  assert.deepEqual(decoded.attachments[1], { cid: CID_B, mime: "image/gif" });
});

test("thread is an announcement pointing at the opening post, not a post with a title", () => {
  const object = encodeThread({
    title: "Renewal UX",
    tags: ["Retention", "retention", " ux "],
    excerpt: excerptOf("Bulletin content expires after roughly fifteen days unless renewed."),
    opCid: CID_C,
    author: AUTHOR,
    at: 9,
  });
  const decoded = roundTrip(object) as DecodedThread | null;

  assert.ok(decoded);
  assert.equal(decoded.kind, "thread");
  assert.equal(decoded.title, "Renewal UX");
  assert.equal(decoded.opCid, CID_C);
  assert.deepEqual(decoded.tags, ["retention", "ux"], "tags normalise and dedupe");
  assert.match(decoded.excerpt, /^Bulletin content expires/);
});

test("dir round-trips id, name and topic", () => {
  const decoded = roundTrip(
    encodeDirectory({ id: "room:general", name: "General", topic: "Anything", author: AUTHOR, at: 1 }),
  );
  assert.ok(decoded && decoded.kind === "dir");
  assert.equal(decoded.id, "room:general");
  assert.equal(decoded.name, "General");
  assert.equal(decoded.topic, "Anything");
});

/* ───────────────────────────────────────────────── hostile input decoding ── */

test("an unknown wire version decodes to null rather than rendering garbage", () => {
  const object = { ...encodeMessage({ body: "hi", author: AUTHOR }), v: WIRE_VERSION + 1 };
  assert.equal(decodeObject(JSON.stringify(object)), null);
});

test("non-Plaza bytes decode to null, never throw", () => {
  for (const input of ["", "not json", "[]", "null", "42", JSON.stringify({ v: 1, k: "nope" }), undefined]) {
    assert.equal(decodeObject(input), null, `input: ${String(input)}`);
  }
});

test("a malformed attachment entry is dropped without sinking the post", () => {
  const object = encodePost({ body: "text survives", author: AUTHOR, at: 1 }) as Record<string, unknown>;
  object.x = [{ m: "image/webp" }, { c: CID_A, m: "image/webp" }, "garbage"];
  const decoded = roundTrip(object) as DecodedPost | null;

  assert.ok(decoded);
  assert.equal(decoded.body, "text survives");
  assert.deepEqual(decoded.attachments.map((a) => a.cid), [CID_A]);
});

test("Uint8Array input decodes", () => {
  const bytes = new TextEncoder().encode(JSON.stringify(encodeMessage({ body: "bytes", author: AUTHOR })));
  const decoded = decodeObject(bytes);
  assert.ok(decoded && decoded.kind === "msg" && decoded.body === "bytes");
});

/* ──────────────────────────────────────────────────────── size validation ── */

test("an over-length chat body is refused at the body field, with the overage counted", () => {
  const body = "x".repeat(CHAT_BODY_MAX_CHARS + 5);
  throwsWire(() => encodeMessage({ body, author: AUTHOR }), { code: "too_long", field: "body" });
  assert.throws(
    () => encodeMessage({ body, author: AUTHOR }),
    /325 characters, 5 over the 320-character limit/,
    "the message must name the overage so the field can show it",
  );
});

test("nothing is silently truncated: a valid maximum encodes intact", () => {
  const body = "x".repeat(POST_BODY_MAX_CHARS);
  const decoded = roundTrip(encodePost({ body, author: AUTHOR, at: 1 })) as DecodedPost | null;
  assert.ok(decoded);
  assert.equal(countChars(decoded.body), POST_BODY_MAX_CHARS);
});

test("an emoji costs one character but several bytes", () => {
  const body = "🙂".repeat(CHAT_BODY_MAX_CHARS);
  assert.equal(countChars(body), CHAT_BODY_MAX_CHARS);
  assert.ok(byteLength(body) > CHAT_BODY_MAX_CHARS);
  assert.doesNotThrow(() => encodeMessage({ body, author: AUTHOR }));
});

test("empty bodies are refused before anything is echoed", () => {
  throwsWire(() => encodeMessage({ body: "   ", author: AUTHOR }), { code: "empty", field: "body" });
  throwsWire(() => validatePostDraft({ body: "\r\n" }), { code: "empty", field: "body" });
});

test("titles, tags and alt text each fail at their own field", () => {
  throwsWire(() => encodeThread({ title: "x".repeat(TITLE_MAX_CHARS + 1), opCid: CID_A, author: AUTHOR }), {
    code: "too_long",
    field: "title",
  });
  throwsWire(
    () =>
      encodeThread({
        title: "ok",
        opCid: CID_A,
        author: AUTHOR,
        tags: Array.from({ length: MAX_TAGS + 1 }, (_, i) => `tag${i}`),
      }),
    { code: "too_many", field: "tags" },
  );
  throwsWire(
    () =>
      encodePost({
        body: "ok",
        author: AUTHOR,
        attachments: [{ cid: CID_A, mime: "image/webp", alt: "x".repeat(ALT_MAX_CHARS + 1) }],
      }),
    { code: "too_long", field: "alt" },
  );
});

test("attachment count and shape are enforced at the attachment field", () => {
  const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({
    cid: `${CID_A}${i}`,
    mime: "image/webp",
  }));
  throwsWire(() => encodePost({ body: "ok", author: AUTHOR, attachments: many }), {
    code: "too_many",
    field: "attachments",
  });
  throwsWire(
    () => encodePost({ body: "ok", author: AUTHOR, attachments: [{ mime: "image/webp" } as never] }),
    { code: "invalid", field: "attachments" },
  );
});

test("the same CID twice is one attachment", () => {
  const decoded = roundTrip(
    encodePost({
      body: "ok",
      author: AUTHOR,
      at: 1,
      attachments: [
        { cid: CID_A, mime: "image/webp" },
        { cid: CID_A, mime: "image/webp" },
      ],
    }),
  ) as DecodedPost | null;
  assert.equal(decoded?.attachments.length, 1);
});

test("the whole-object budget is a real gate, and the field caps keep it out of reach", () => {
  throwsWire(() => assertObjectSize({ v: 1, k: "msg", b: "x".repeat(MAX_OBJECT_BYTES + 1) }), {
    code: "too_large",
    field: "object",
  });

  // A maximum legal post — 4,000 four-byte code points, MAX_ATTACHMENTS attachments, full alt text
  // — must still fit, or the field caps and the object cap would contradict each other.
  const maximal = encodePost({
    body: "𝕏".repeat(POST_BODY_MAX_CHARS),
    author: AUTHOR,
    at: 1,
    attachments: Array.from({ length: MAX_ATTACHMENTS }, (_, i) => ({
      cid: `${CID_A}${i}`,
      mime: "image/webp",
      width: 1600,
      height: 1200,
      alt: "𝕏".repeat(ALT_MAX_CHARS),
    })),
  });
  assert.ok(byteLength(JSON.stringify(maximal)) < MAX_OBJECT_BYTES);
});

test("an object needs an author", () => {
  throwsWire(() => encodeMessage({ body: "hi", author: "" }), { code: "empty", field: "author" });
});

test("a thread must point at a real CID", () => {
  throwsWire(() => encodeThread({ title: "t", opCid: "", author: AUTHOR }), {
    code: "invalid",
    field: "object",
  });
});

test("validateThreadDraft reports the title before the body", () => {
  throwsWire(() => validateThreadDraft({ title: "", body: "x".repeat(POST_BODY_MAX_CHARS + 1) }), {
    code: "empty",
    field: "title",
  });
});

/* ──────────────────────────────────────────────────── the ancestor ladder ── */

test("linkFrom shifts the ladder forward, so distances stay 2, 3, 4…", () => {
  const link = linkFrom({ cid: CID_A, prev: CID_B, skips: [CID_C], author: AUTHOR, at: 3 });
  assert.equal(link.prev, CID_A, "distance 1 is the tip itself");
  assert.deepEqual(link.skips, [CID_B, CID_C], "distance 2 is the tip's prev; 3 is the tip's own first skip");
  assert.equal(link.prevAuthor, AUTHOR);
  assert.equal(link.prevAt, 3);
});

test("linkFrom caps the ladder at SKIP_LEVELS and truncates at the first gap", () => {
  const long = linkFrom({ cid: CID_A, prev: CID_B, skips: [CID_C, "x1", "x2", "x3", "x4"] });
  assert.equal(long.skips.length, SKIP_LEVELS);

  const atStart = linkFrom({ cid: CID_A, prev: null, skips: [] });
  assert.deepEqual(atStart.skips, [], "the first object in a chain has no ancestors to offer");

  const fresh = linkFrom(null);
  assert.deepEqual(fresh, { prev: null, skips: [], prevAuthor: null, prevAt: null });
});

test("the ladder and prev metadata survive a round trip", () => {
  const link = linkFrom({ cid: CID_A, prev: CID_B, skips: [CID_C], author: AUTHOR, at: 3 });
  const decoded = decodeObject(JSON.stringify(encodeMessage({ body: "hi", author: AUTHOR, at: 4, ...link })));
  assert.ok(decoded);
  assert.deepEqual(decoded.skips, [CID_B, CID_C]);
  assert.equal(decoded.prevAuthor, AUTHOR);
  assert.equal(decoded.prevAt, 3);
});

/* ────────────────────────────────────────────────────────────────── utils ── */

test("excerptOf is the one deliberate truncation, and it is lossless about being lossy", () => {
  assert.equal(excerptOf("  a   b  "), "a b");
  const long = excerptOf("y".repeat(300), 10);
  assert.equal(countChars(long), 10);
  assert.ok(long.endsWith("…"));
});

test("expiresAt derives a deadline, or null when there is no clock", () => {
  assert.equal(expiresAt(1_000, 500), 1_500);
  assert.equal(expiresAt(null), null);
  assert.equal(expiresAt(0), null);
});
