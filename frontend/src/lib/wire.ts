// The Bulletin object wire format. Pure: no SDK, no DOM, no I/O, no network.
//
// One envelope, discriminated payloads — architecture.md §2:
//
//   envelope   { kind, author, at, prev }          identical for every object
//   msg        { body }                            chat message
//   post       { body, attachments[], index }      reply, or profile post
//   thread     { title, tags[], excerpt, opCid }   announcement, points at the opening post
//   dir        { id, name, topic }                 registry directory entry
//
// A reply and a chat message carry the same fields; the distinction is whether the thing has a
// subject line. A thread is NOT a post with a title — it is a separate announcement pointing at
// the opening post's CID, and that indirection is what makes cross-posting possible (N
// announcements, one body).
//
// ── ON-WIRE KEYS ARE SHORT, AND THE MAPPING IS HERE ────────────────────────────────────────────
// Bulletin charges bytes and a typical authorization grants 4 MiB, so keys are abbreviated. The
// decoded shape uses the §2 names; nothing outside this file should see a short key.
//
//   v    wire version          k    kind            a   author (self-asserted)
//   t    epoch ms (claimed)    prev previous CID     sk  ancestor ladder, see below
//   pa   previous author       pt   previous `at`     reg optional registry id (provenance only)
//   msg     b  body
//   post    b  body            i    index            x   attachments[]
//   thread  s  title           g    tags[]           e   excerpt        c  opCid
//   dir     id id              n    name             tp  topic
//   attachment  c cid  m mime  w width  h height  al alt
//
// ── THE ANCESTOR LADDER (`sk`) AND WHY IT EXISTS ───────────────────────────────────────────────
// `prev` lives INSIDE the object it points from, so in a pure prev-chain one unresolvable object
// hides all history behind it. Per-object expiry plus backwards walking therefore means a chain
// truncates at the FIRST HOLE, not from the tail (§4). `sk` mitigates that: `sk[i]` is the
// ancestor at distance i + 2, so a walk can step over up to `sk.length` consecutive dead objects
// using CIDs it knows by name.
//
// The ladder is LINEAR, not exponential, and that is forced rather than chosen. Building
// exponential skips would require reading ancestors at write time (the tip only knows its own
// pointers), and the writer of the next link is often a different person. What the tip *does*
// carry is `prev` (its distance 1) and its own ladder (its distances 2, 3, 4…) — which are the new
// object's distances 2, 3, 4, 5…. So `sk` shifts forward for free. See `linkFrom`.
//
// ── `a` IS SELF-ASSERTED ───────────────────────────────────────────────────────────────────────
// Bulletin objects are plain bytes fetched over HTTP; nothing binds `a` to a signature. Authorship
// is only *verified* when the index independently attributes that CID to that writer (HeadRef.by).
// Decoders here must treat every field as untrusted input: a gateway can serve anything.
//
// Versioning: unknown major version DECODES TO NULL — never a throw, never a half-populated
// object that renders as garbage.

export const WIRE_VERSION = 1;

/* ───────────────────────────────────────────────────────────────────── budgets ── */
//
// Sizes are validated BEFORE any optimistic echo, so an over-budget item is refused at the field
// that can fix it instead of appearing in the timeline and then vanishing. Nothing here ever
// truncates silently: the single truncation in this file is `excerptOf`, which a caller invokes
// knowingly to build a preview.

/** Chat bodies, in CODE POINTS — an emoji costs one. A product decision, not a byte limit. */
export const CHAT_BODY_MAX_CHARS = 320;
/** Posts and replies. Bodies live on Bulletin, so this is not squeezed by any statement cap. */
export const POST_BODY_MAX_CHARS = 4_000;
export const TITLE_MAX_CHARS = 120;
export const EXCERPT_MAX_CHARS = 140;
export const TAG_MAX_CHARS = 24;
export const MAX_TAGS = 5;
export const DIR_NAME_MAX_CHARS = 48;
export const DIR_TOPIC_MAX_CHARS = 140;
export const ALT_MAX_CHARS = 420;
/** Format permits N; chat may allow 0–1 by UI convention (§2). */
export const MAX_ATTACHMENTS = 8;

/**
 * Whole-object byte budget.
 *
 * Not a chain limit — it is a read-latency guard plus alignment with the contract layer. Measured
 * gateway behaviour degrades sharply on large payloads (9/10 success, up to 12.4 s), and
 * `UserPosts`/`ForumThread` cap content at 40,000 bytes (§9), so the two layers cannot disagree
 * if we use the same number.
 */
export const MAX_OBJECT_BYTES = 40_000;

/** How many ancestor pointers past `prev` an object carries. 0 reproduces a pure prev-chain. */
export const SKIP_LEVELS = 3;

/**
 * Measured Bulletin retention: 201,600 blocks at 6.457 s = 15.06 days.
 *
 * The chain's unit is BLOCKS; days are derived convenience and drift with block production. Prefer
 * blocks wherever an exact answer matters.
 */
export const RETENTION_BLOCKS = 201_600;
export const BLOCK_MS = 6_457;
export const BODY_RETENTION_MS = RETENTION_BLOCKS * BLOCK_MS;

/** A freshly stored CID takes minutes to reach public gateways; below this age, absence ≠ expiry. */
export const PROPAGATION_GRACE_MS = 5 * 60 * 1000;

const encoder = new TextEncoder();

/** Never assume characters equal bytes: UTF-8 makes them differ and byte caps are in bytes. */
export const byteLength = (text: unknown): number => encoder.encode(String(text ?? "")).length;

/** Counts code points, not code units, so an emoji costs one. */
export const countChars = (text: unknown): number => [...String(text ?? "")].length;

/* ─────────────────────────────────────────────────────────────────────── errors ── */

export type WireErrorCode = "empty" | "too_long" | "too_many" | "too_large" | "invalid";

/**
 * Which compose field this refusal belongs next to. The UI attaches the message to that control;
 * that is the whole point of validating before the echo.
 */
export type WireField =
  | "body"
  | "title"
  | "tags"
  | "excerpt"
  | "attachments"
  | "alt"
  | "name"
  | "topic"
  | "id"
  | "author"
  | "object";

export class WireError extends Error {
  code: WireErrorCode;
  field: WireField;

  constructor(message: string, options: { code?: WireErrorCode; field?: WireField } = {}) {
    super(message);
    this.name = "WireError";
    this.code = options.code ?? "invalid";
    this.field = options.field ?? "object";
  }
}

/* ───────────────────────────────────────────────────────────────────────── types ── */

export type Kind = "msg" | "post" | "thread" | "dir";

export interface Attachment {
  cid: string;
  mime: string;
  width?: number;
  height?: number;
  alt?: string;
}

/** What every object carries. `author`/`at` are author-claimed; see the header. */
export interface Envelope {
  kind: Kind;
  author: string;
  at: number;
  prev: string | null;
}

/** The chain metadata a writer needs from the tip in order to append one link. */
export interface ChainLink {
  prev: string | null;
  /** `skips[i]` is the ancestor at distance i + 2. */
  skips: string[];
  prevAuthor: string | null;
  prevAt: number | null;
}

/** A tip, as far as `linkFrom` is concerned. Satisfied by a decoded object or a HeadRef. */
export interface ChainTip {
  cid: string;
  prev?: string | null;
  skips?: string[] | null;
  author?: string | null;
  at?: number | null;
}

interface DecodedCommon {
  author: string;
  /** null when the object claimed no usable timestamp — do not substitute `Date.now()` here. */
  at: number | null;
  prev: string | null;
  skips: string[];
  prevAuthor: string | null;
  prevAt: number | null;
  registry: string | null;
}

export type DecodedMessage = DecodedCommon & { kind: "msg"; body: string };
export type DecodedPost = DecodedCommon & {
  kind: "post";
  body: string;
  attachments: Attachment[];
  index: number;
};
export type DecodedThread = DecodedCommon & {
  kind: "thread";
  title: string;
  tags: string[];
  excerpt: string;
  opCid: string;
};
export type DecodedDirectory = DecodedCommon & {
  kind: "dir";
  id: string;
  name: string;
  topic: string;
};

export type DecodedObject = DecodedMessage | DecodedPost | DecodedThread | DecodedDirectory;

/** An encoded object, ready to hand to the Bulletin store. Opaque JSON; do not read its keys. */
export type WireObject = Record<string, unknown>;

interface LinkInput extends Partial<ChainLink> {
  author: string;
  at?: number;
  registry?: string | null;
}

/* ─────────────────────────────────────────────────────────────────── predicates ── */

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
/** A CID is opaque to us; we only refuse shapes that could not be one. */
export const isCid = (value: unknown): value is string =>
  isNonEmptyString(value) && value.length <= 128 && !/\s/.test(value);
const isEpoch = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const isPositiveNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const optionalCid = (value: unknown): boolean => value === null || value === undefined || isCid(value);

const cidLadder = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => isCid(entry)) : [];

/* ────────────────────────────────────────────────────────────────────── linking ── */

/**
 * Everything a writer must know about the tip of a chain to append one link to it.
 *
 * The ladder shift: the new object's distance-2 ancestor is the tip's `prev`, and its distances
 * 3, 4, 5… are the tip's own ladder. Truncating at the first missing entry is sound — a tip with
 * no `prev` is the start of the chain, so it has no ladder either.
 */
export function linkFrom(tip: ChainTip | null | undefined, levels: number = SKIP_LEVELS): ChainLink {
  if (!tip || !isCid(tip.cid)) return { prev: null, skips: [], prevAuthor: null, prevAt: null };

  const ladder: string[] = [];
  for (const candidate of [tip.prev, ...(tip.skips ?? [])]) {
    if (!isCid(candidate) || ladder.length >= Math.max(0, levels)) break;
    ladder.push(candidate);
  }

  return {
    prev: tip.cid,
    skips: ladder,
    prevAuthor: isNonEmptyString(tip.author) ? tip.author : null,
    prevAt: isEpoch(tip.at) ? tip.at : null,
  };
}

const base = (input: LinkInput): WireObject => {
  const author = String(input.author ?? "");
  if (!author) throw new WireError("An object needs an author address.", { code: "empty", field: "author" });

  const object: WireObject = {
    v: WIRE_VERSION,
    a: author,
    t: Math.round(isEpoch(input.at) ? input.at : Date.now()),
    prev: isCid(input.prev) ? input.prev : null,
  };
  const ladder = cidLadder(input.skips);
  if (ladder.length > 0) object.sk = ladder;
  // `pa`/`pt` are what make "a dead body must never hide a post" implementable: when a CID no
  // longer resolves, its successor still says who wrote it and when.
  if (isNonEmptyString(input.prevAuthor)) object.pa = input.prevAuthor;
  if (isEpoch(input.prevAt)) object.pt = input.prevAt;
  // Optional provenance only. §2's envelope has no scope field, and it must not: a cross-posted
  // body belongs to N registries at once. Recorded when a caller knows it, never required.
  if (isNonEmptyString(input.registry)) object.reg = input.registry;
  return object;
};

/* ───────────────────────────────────────────────────────────────────── encoders ── */

export interface MessageDraft extends LinkInput {
  body: string;
}

export interface PostDraft extends LinkInput {
  body: string;
  attachments?: Attachment[];
  index?: number;
}

export interface ThreadDraft extends LinkInput {
  title: string;
  excerpt?: string;
  tags?: string[];
  opCid: string;
}

export interface DirectoryDraft extends LinkInput {
  id: string;
  name: string;
  topic?: string;
}

/** A chat message object. */
export function encodeMessage(draft: MessageDraft): WireObject {
  const body = normalizeBody(draft.body);
  assertChatBody(body);
  return assertObjectSize({ ...base(draft), k: "msg", b: body });
}

/**
 * A post — the opening post of a thread, a reply, or a profile post.
 *
 * `i` is the post's own index in its registry, so a reply count is readable from the head object
 * alone. Without it, counting replies means walking the whole chain to render one listing row.
 */
export function encodePost(draft: PostDraft): WireObject {
  const body = normalizeBody(draft.body);
  assertPostBody(body);
  const attachments = assertAttachments(draft.attachments ?? []);
  const object: WireObject = {
    ...base(draft),
    k: "post",
    b: body,
    i: Number.isFinite(draft.index) ? Math.max(0, Math.round(draft.index as number)) : 0,
  };
  if (attachments.length > 0) object.x = attachments.map(encodeAttachment);
  return assertObjectSize(object);
}

/** A thread announcement — durable, separate from the body it points at. */
export function encodeThread(draft: ThreadDraft): WireObject {
  const title = assertTitle(draft.title);
  const tags = assertTags(draft.tags ?? []);
  const excerpt = assertExcerpt(draft.excerpt ?? "");
  if (!isCid(draft.opCid)) {
    throw new WireError("A thread must point at the CID of its opening post.", {
      code: "invalid",
      field: "object",
    });
  }
  const object: WireObject = { ...base(draft), k: "thread", s: title, c: draft.opCid };
  // The excerpt rides on the durable announcement so a board renders from ONE chain walk instead
  // of a gateway fetch per thread — and so a thread whose body expired still shows what it was.
  if (excerpt) object.e = excerpt;
  if (tags.length > 0) object.g = tags;
  return assertObjectSize(object);
}

/** A room, board, or feed directory entry. */
export function encodeDirectory(draft: DirectoryDraft): WireObject {
  if (!isNonEmptyString(draft.id)) {
    throw new WireError("A directory entry needs an id.", { code: "empty", field: "id" });
  }
  const object: WireObject = {
    ...base(draft),
    k: "dir",
    id: draft.id,
    n: assertDirName(draft.name),
  };
  const topic = assertDirTopic(draft.topic ?? "");
  if (topic) object.tp = topic;
  return assertObjectSize(object);
}

const encodeAttachment = (attachment: Attachment): WireObject => {
  const record: WireObject = { c: attachment.cid, m: attachment.mime };
  if (Number.isFinite(attachment.width)) record.w = Math.round(attachment.width as number);
  if (Number.isFinite(attachment.height)) record.h = Math.round(attachment.height as number);
  if (isNonEmptyString(attachment.alt)) record.al = attachment.alt;
  return record;
};

/**
 * Last gate before a store: refuse an object the read path would struggle to serve.
 *
 * With the field caps above this is currently UNREACHABLE — a maximum post (4,000 code points, 8
 * attachments, full alt text) tops out around 30 KB even in four-byte characters. It is a backstop
 * against a future cap being raised without anyone re-checking the total, which is exactly the kind
 * of drift §9 documents in the contract docstrings. Exported so it can be tested directly.
 */
export function assertObjectSize(object: WireObject): WireObject {
  const bytes = byteLength(JSON.stringify(object));
  if (bytes > MAX_OBJECT_BYTES) {
    throw new WireError(
      `That encodes to ${bytes} bytes, over the ${MAX_OBJECT_BYTES}-byte object budget. ` +
        "Shorten it, or split it across two posts.",
      { code: "too_large", field: "object" },
    );
  }
  return object;
}

export const encodeObjectBytes = (object: WireObject): Uint8Array => encoder.encode(JSON.stringify(object));

export const objectByteLength = (object: WireObject): number => byteLength(JSON.stringify(object));

/* ───────────────────────────────────────────────────────────────────── decoders ── */

/**
 * Decode any object. Returns null when the bytes are not a Plaza object of a known version — a
 * gateway can serve anything, and a stranger's CID chain is untrusted input.
 */
export function decodeObject(input: unknown): DecodedObject | null {
  const payload =
    input instanceof Uint8Array
      ? safeParse(new TextDecoder().decode(input))
      : typeof input === "string"
        ? safeParse(input)
        : input;

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (record.v !== WIRE_VERSION) return null; // unknown version: reject, never guess
  if (!optionalCid(record.prev)) return null;

  const common: DecodedCommon = {
    author: typeof record.a === "string" ? record.a : "",
    at: isEpoch(record.t) ? record.t : null,
    prev: isCid(record.prev) ? record.prev : null,
    skips: cidLadder(record.sk),
    prevAuthor: typeof record.pa === "string" && record.pa ? record.pa : null,
    prevAt: isEpoch(record.pt) ? record.pt : null,
    registry: typeof record.reg === "string" && record.reg ? record.reg : null,
  };

  switch (record.k) {
    case "msg":
      if (typeof record.b !== "string") return null;
      return { ...common, kind: "msg", body: record.b };

    case "post":
      if (typeof record.b !== "string") return null;
      return {
        ...common,
        kind: "post",
        body: record.b,
        attachments: decodeAttachments(record.x),
        index: Number.isFinite(record.i) ? Math.max(0, Math.round(record.i as number)) : 0,
      };

    case "thread":
      if (!isCid(record.c)) return null;
      return {
        ...common,
        kind: "thread",
        title: typeof record.s === "string" ? record.s : "",
        tags: Array.isArray(record.g)
          ? record.g.filter((tag): tag is string => isNonEmptyString(tag)).slice(0, MAX_TAGS)
          : [],
        excerpt: typeof record.e === "string" ? record.e : "",
        opCid: record.c,
      };

    case "dir":
      if (!isNonEmptyString(record.id)) return null;
      return {
        ...common,
        kind: "dir",
        id: record.id,
        name: typeof record.n === "string" ? record.n : "",
        topic: typeof record.tp === "string" ? record.tp : "",
      };

    default:
      return null;
  }
}

/**
 * Attachments decode leniently and INDIVIDUALLY: a malformed entry is dropped, it does not sink
 * the post. Each surviving attachment has its own retention clock and its own unavailable state,
 * so the caller must be able to render a body whose images are half gone.
 */
function decodeAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return [];
  const out: Attachment[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (!isCid(record.c)) continue;
    const attachment: Attachment = {
      cid: record.c,
      mime: typeof record.m === "string" && record.m ? record.m : "application/octet-stream",
    };
    if (isPositiveNumber(record.w)) attachment.width = Math.round(record.w);
    if (isPositiveNumber(record.h)) attachment.height = Math.round(record.h);
    if (isNonEmptyString(record.al)) attachment.alt = record.al;
    out.push(attachment);
    if (out.length >= MAX_ATTACHMENTS) break;
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────────── validation ── */

export const normalizeBody = (body: unknown): string =>
  String(body ?? "")
    .replace(/\r\n/g, "\n")
    .trim();

const overBy = (chars: number, limit: number) => `${chars - limit} over the ${limit}-character limit`;

export function assertChatBody(text: string): string {
  if (!text) throw new WireError("Type something first.", { code: "empty", field: "body" });
  const chars = countChars(text);
  if (chars > CHAT_BODY_MAX_CHARS) {
    throw new WireError(`That message is ${chars} characters, ${overBy(chars, CHAT_BODY_MAX_CHARS)}.`, {
      code: "too_long",
      field: "body",
    });
  }
  return text;
}

export function assertPostBody(text: string): string {
  if (!text) throw new WireError("Write something first.", { code: "empty", field: "body" });
  const chars = countChars(text);
  if (chars > POST_BODY_MAX_CHARS) {
    throw new WireError(`That post is ${chars} characters, ${overBy(chars, POST_BODY_MAX_CHARS)}.`, {
      code: "too_long",
      field: "body",
    });
  }
  return text;
}

export function assertTitle(value: unknown): string {
  const title = String(value ?? "").trim();
  if (!title) throw new WireError("A thread needs a title.", { code: "empty", field: "title" });
  const chars = countChars(title);
  if (chars > TITLE_MAX_CHARS) {
    throw new WireError(`That title is ${chars} characters, ${overBy(chars, TITLE_MAX_CHARS)}.`, {
      code: "too_long",
      field: "title",
    });
  }
  return title;
}

/** Tags are normalised (trimmed, lowercased, deduped) but never truncated or silently dropped. */
export function assertTags(value: unknown): string[] {
  const input = Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const raw of input) {
    const tag = String(raw ?? "").trim().toLowerCase();
    if (!tag) continue;
    const chars = countChars(tag);
    if (chars > TAG_MAX_CHARS) {
      throw new WireError(`The tag "${tag}" is ${chars} characters, ${overBy(chars, TAG_MAX_CHARS)}.`, {
        code: "too_long",
        field: "tags",
      });
    }
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > MAX_TAGS) {
    throw new WireError(`That is ${out.length} tags; ${MAX_TAGS} is the limit. Remove ${out.length - MAX_TAGS}.`, {
      code: "too_many",
      field: "tags",
    });
  }
  return out;
}

/**
 * Excerpts are a *derived preview*, so the truncation lives in `excerptOf`, which a caller invokes
 * knowingly. Handing this an over-length string is a bug in the caller, so it throws.
 */
export function assertExcerpt(value: unknown): string {
  const excerpt = String(value ?? "").trim();
  const chars = countChars(excerpt);
  if (chars > EXCERPT_MAX_CHARS) {
    throw new WireError(
      `That excerpt is ${chars} characters, ${overBy(chars, EXCERPT_MAX_CHARS)}. Build it with excerptOf().`,
      { code: "too_long", field: "excerpt" },
    );
  }
  return excerpt;
}

export function assertDirName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (!name) throw new WireError("Give it a name.", { code: "empty", field: "name" });
  const chars = countChars(name);
  if (chars > DIR_NAME_MAX_CHARS) {
    throw new WireError(`That name is ${chars} characters, ${overBy(chars, DIR_NAME_MAX_CHARS)}.`, {
      code: "too_long",
      field: "name",
    });
  }
  return name;
}

export function assertDirTopic(value: unknown): string {
  const topic = String(value ?? "").trim();
  const chars = countChars(topic);
  if (chars > DIR_TOPIC_MAX_CHARS) {
    throw new WireError(`That topic is ${chars} characters, ${overBy(chars, DIR_TOPIC_MAX_CHARS)}.`, {
      code: "too_long",
      field: "topic",
    });
  }
  return topic;
}

/**
 * Attachment references. Every image is its own Bulletin object with its own CID; the post body
 * holds only references, and the reference list lives inside the Bulletin object rather than in
 * contract storage — so an array costs nothing on chain (§2).
 */
export function assertAttachments(value: unknown): Attachment[] {
  const input = Array.isArray(value) ? value : [];
  if (input.length > MAX_ATTACHMENTS) {
    throw new WireError(
      `That is ${input.length} attachments; ${MAX_ATTACHMENTS} is the limit. Remove ${input.length - MAX_ATTACHMENTS}.`,
      { code: "too_many", field: "attachments" },
    );
  }

  const out: Attachment[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const entry = (raw ?? {}) as Partial<Attachment>;
    if (!isCid(entry.cid)) {
      throw new WireError("An attachment is missing its CID, so it could never be fetched back.", {
        code: "invalid",
        field: "attachments",
      });
    }
    if (!isNonEmptyString(entry.mime)) {
      throw new WireError("An attachment is missing its media type.", {
        code: "invalid",
        field: "attachments",
      });
    }
    if (seen.has(entry.cid)) continue; // the same bytes twice is one attachment
    seen.add(entry.cid);

    const attachment: Attachment = { cid: entry.cid, mime: entry.mime };
    if (Number.isFinite(entry.width)) attachment.width = Math.round(entry.width as number);
    if (Number.isFinite(entry.height)) attachment.height = Math.round(entry.height as number);
    if (isNonEmptyString(entry.alt)) {
      const chars = countChars(entry.alt);
      if (chars > ALT_MAX_CHARS) {
        throw new WireError(`That description is ${chars} characters, ${overBy(chars, ALT_MAX_CHARS)}.`, {
          code: "too_long",
          field: "alt",
        });
      }
      attachment.alt = entry.alt.trim();
    }
    out.push(attachment);
  }
  return out;
}

/* ───────────────────────────────────────────────────── pre-echo draft validators ── */
//
// Call these from the compose handler BEFORE the optimistic echo. They throw the same WireError the
// encoder would, with the same `field`, so nothing over budget ever reaches the timeline and then
// disappears when the encode fails.

export function validateMessageDraft(draft: { body: unknown }): string {
  return assertChatBody(normalizeBody(draft.body));
}

export function validatePostDraft(draft: { body: unknown; attachments?: unknown }): {
  body: string;
  attachments: Attachment[];
} {
  const body = assertPostBody(normalizeBody(draft.body));
  return { body, attachments: assertAttachments(draft.attachments ?? []) };
}

export function validateThreadDraft(draft: { title: unknown; body: unknown; tags?: unknown }): {
  title: string;
  body: string;
  tags: string[];
} {
  // Title first: it is the field a user fills first, and reporting the last failure of three would
  // send them to the wrong control.
  const title = assertTitle(draft.title);
  const tags = assertTags(draft.tags ?? []);
  const body = assertPostBody(normalizeBody(draft.body));
  return { title, body, tags };
}

/* ──────────────────────────────────────────────────────────────────────── utils ── */

/** First-pass listing preview. The one deliberate truncation in this file; never hides content. */
export function excerptOf(body: unknown, limit: number = EXCERPT_MAX_CHARS): string {
  const text = String(body ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...text];
  return chars.length <= limit ? text : `${chars.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

/** When this object's bytes stop being servable, absent a renewal. */
export const expiresAt = (at: number | null | undefined, retentionMs = BODY_RETENTION_MS): number | null =>
  isEpoch(at) ? at + retentionMs : null;

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
