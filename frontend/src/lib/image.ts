// Turning picked files into bytes that are safe and cheap to put on Bulletin. Pure browser:
// <canvas>, the File API, createImageBitmap. No dependency beyond the shared attachment limit.
//
// Three guarantees, in the order of how badly it hurts when one is missing:
//
//   1. NO CAMERA METADATA EVER LEAVES THE DEVICE. A phone photo carries GPS coordinates in its
//      EXIF block, and **Bulletin has no delete and no takedown** — a mistake here is permanent and
//      public. So the original bytes are NEVER uploaded: every raster is decoded and re-encoded
//      through a canvas, which drops all metadata by construction. That is deliberately not a
//      "strip the tags" pass: a stripping step can be skipped, get a format wrong, or miss a vendor
//      block. A re-encode cannot. Allowing N images per post multiplies the exposure, which is
//      precisely why the re-encode is not negotiable.
//
//      ⚠️ GIF is the one exception and it is a considered one. See processImage.
//
//   2. ORIENTATION IS BAKED IN, NOT CARRIED. A portrait phone photo is usually stored landscape
//      with an EXIF rotation flag. Since we throw the EXIF away (1), a decoder that ignores that
//      flag hands us a sideways bitmap and we upload a permanently sideways image. Both decode
//      paths below are the platform's own auto-orienting path, and which one we get is probed, not
//      assumed.
//
//   3. THE BYTES ARE BOUNDED. An attachment is a Bulletin write the user pays for out of a small
//      quota (~60% of authorizations grant 10 transactions / 4 MiB) and a gateway fetch every
//      reader pays for, on a path measured to degrade sharply with size. A 12 MP phone photo is
//      4–6 MB; the same picture at 1600 px of WebP is 100–300 KB and looks identical in a post.

import { MAX_ATTACHMENTS } from "./wire.ts";
import type { Attachment } from "./wire.ts";

/** What the picker accepts. Anything else is refused BY NAME, never silently. */
export const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const ACCEPT_ATTR = ACCEPTED_TYPES.join(",");

/** Long edge after downscaling. 1600 is generous for a post and cheap to store. */
export const MAX_EDGE = 1600;
/** Fallback edges, tried in order when quality alone cannot reach the budget. */
const FALLBACK_EDGES = [1200, 900];
const QUALITY_LADDER = [0.85, 0.7, 0.55, 0.4];

/** What we try to come in under. Not a hard failure — see HARD_MAX_BYTES. */
export const BYTE_BUDGET = 1_000_000;
/** What we refuse outright. Past this the cost stops being the user's to accept quietly. */
export const HARD_MAX_BYTES = 2_000_000;

export { MAX_ATTACHMENTS };

/**
 * A refusal the UI can render verbatim, next to the attachment control that can fix it. Every
 * message is a sentence about the picked file, not about the code that rejected it.
 */
export class ImageError extends Error {
  /** Always the attachment field — that is where this belongs in a compose form. */
  field: "attachments";
  fileName: string | null;

  constructor(message: string, fileName: string | null = null) {
    super(message);
    this.name = "ImageError";
    this.field = "attachments";
    this.fileName = fileName;
  }
}

export interface ImageMeta {
  width: number;
  height: number;
  bytesIn: number;
  bytesOut: number;
  /** True for a GIF, whose bytes we deliberately did not touch. */
  passthrough: boolean;
}

/**
 * Processed dimensions and sizes, keyed by the File we handed back.
 *
 * A WeakMap rather than properties bolted onto the File: the file travels through the compose state
 * and back after a failed send, and a preview has to reserve its box BEFORE the image loads (a
 * collapsed `<img>` is the bug that makes attachments never load below the fold). Re-measuring by
 * loading the image is exactly the thing that reservation exists to avoid.
 */
const measured = new WeakMap<File, ImageMeta>();

export const imageMeta = (file: File | null | undefined): ImageMeta | null =>
  file ? (measured.get(file) ?? null) : null;

/* ─────────────────────────────────────────────────────────────── pure helpers ── */

export const isAcceptedType = (type: unknown): boolean =>
  typeof type === "string" && (ACCEPTED_TYPES as readonly string[]).includes(type);

/**
 * May these bytes be put in an `<img src>`?
 *
 * ⚠️ SEPARATE FROM `isAcceptedType`, AND BOTH ARE NEEDED. That one guards what WE upload; this one
 * guards what a STRANGER'S post claims. An attachment's `mime` is self-asserted metadata inside an
 * object anyone can write — Bulletin's `store()` takes no content type at all — so the render path
 * must whitelist rather than trust. `image/svg+xml` is the one that matters: an SVG is a document
 * with script, so rendering one from a stranger's chain is an XSS, and it is absent here on purpose.
 */
export const isRenderableImage = (mime: unknown): boolean =>
  typeof mime === "string" && (ACCEPTED_TYPES as readonly string[]).includes(mime.split(";")[0].trim().toLowerCase());

export const extensionFor = (type: string): string =>
  type === "image/webp" ? "webp" : type === "image/gif" ? "gif" : "jpg";

export const renameFor = (base: string, type: string): string =>
  `${String(base || "image").replace(/\.[^.]+$/, "") || "image"}.${extensionFor(type)}`;

/** Never upscales: a small source encodes at its native size. */
export function planScale(
  width: number,
  height: number,
  edge: number,
): { width: number; height: number; scale: number } {
  const longest = Math.max(width, height);
  const scale = longest > 0 ? Math.min(1, edge / longest) : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

/**
 * Local, so this module keeps its zero-dependency property. Decimal units, because the budget is a
 * round decimal number and "1 MB" is a friendlier limit to be told about than "977 KB".
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1_000) return `${Math.round(bytes)} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * "4.3 MB, over the 1.0 MB limit" — except just over the line, where both sides round to the same
 * string and repeating it would read like a bug. Then say the exact number instead.
 */
export function sizeVersusLimit(size: number, limit: number): string {
  const shown = formatBytes(size);
  const allowed = formatBytes(limit);
  return shown === allowed
    ? `${size.toLocaleString("en-US")} bytes, just over the ${allowed} limit`
    : `${shown}, over the ${allowed} limit`;
}

/* ──────────────────────────────────────────────────────────────── orientation ── */

/** 1×1 transparent GIF — the smallest thing every image decoder accepts. */
const PROBE_GIF = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

let orientationProbe: Promise<boolean> | null = null;

/**
 * Does `createImageBitmap` honour `{ imageOrientation: 'from-image' }`?
 *
 * This cannot be feature-detected by asking, because an implementation that does not understand the
 * options dictionary IGNORES it and resolves perfectly happily — with an unrotated bitmap. So we
 * ask it to parse a value that is not in the enum: an implementation that reads the dictionary
 * rejects with a TypeError, and one that does not read it succeeds. Success here therefore means
 * "the option would have been ignored", which is a failure for us.
 */
function supportsOrientationOption(): Promise<boolean> {
  orientationProbe ??= (async () => {
    if (typeof createImageBitmap !== "function" || typeof Blob !== "function") return false;
    try {
      const bytes = Uint8Array.from(atob(PROBE_GIF), (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/gif" }), {
        imageOrientation: "plaza-probe-not-a-real-value" as ImageOrientation,
      });
      bitmap.close?.();
      return false;
    } catch (error) {
      // A decode failure is a DOMException, not a TypeError, and must not be read as "the
      // dictionary was parsed".
      return error instanceof TypeError;
    }
  })();
  return orientationProbe;
}

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

/**
 * Decode to something drawable, right way up.
 *
 * Two paths, and neither can be *verified* at runtime to have applied the rotation — there is no
 * API that reports it. What makes that acceptable is that both are the platform's own auto-orient
 * path, the same one the `<img>` in the rendered post uses, so a browser that gets this wrong gets
 * it wrong consistently and the preview never disagrees with the post.
 */
async function decode(file: File): Promise<Decoded> {
  if (await supportsOrientationOption()) {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close?.() };
  }

  // Fallback: an <img> element. Browsers have defaulted to `image-orientation: from-image` for
  // years and drawImage() reflects the decoded orientation, so this rotates too — it just cannot be
  // probed the way the option above can.
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    if (typeof img.decode === "function") await img.decode();
    else await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("decode failed"));
    });
  } catch {
    URL.revokeObjectURL(url);
    throw new ImageError(
      "That file could not be read as an image. It may be damaged, or not really an image.",
      file.name,
    );
  }
  return {
    source: img,
    width: img.naturalWidth,
    height: img.naturalHeight,
    release: () => URL.revokeObjectURL(url),
  };
}

/* ─────────────────────────────────────────────────────────────────── encoding ── */

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> =>
  new Promise((resolve) => {
    if (typeof canvas.toBlob !== "function") return resolve(null);
    canvas.toBlob(resolve, type, quality);
  });

/**
 * Draw at `edge` (long side, never upscaled) and encode.
 *
 * WebP first, JPEG as the fallback. The check is on the RETURNED blob's type, not on any capability
 * query: a canvas asked for a type it cannot encode does not throw — it silently hands back a PNG,
 * which for a photo is several times larger than the JPEG we would have chosen knowingly.
 */
async function render(
  decoded: Decoded,
  edge: number,
  quality: number,
  options: { hasAlpha: boolean; fileName: string },
): Promise<{ blob: Blob; width: number; height: number }> {
  const { width, height } = planScale(decoded.width, decoded.height, edge);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new ImageError(
      "This browser would not give the page a canvas, so the image cannot be prepared here.",
      options.fileName,
    );
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(decoded.source, 0, 0, width, height);

  let blob = await toBlob(canvas, "image/webp", quality);
  if (!blob || blob.type !== "image/webp") {
    // No WebP encoder. JPEG has no alpha channel, and an unpainted canvas is transparent BLACK — a
    // transparent PNG would come back with a black background rather than the white every viewer
    // expects. Repaint first.
    if (options.hasAlpha) {
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = "source-over";
    }
    blob = await toBlob(canvas, "image/jpeg", quality);
  }
  if (!blob) {
    throw new ImageError(
      "This browser could not encode the image. Try a different one, or post without it.",
      options.fileName,
    );
  }
  return { blob, width, height };
}

/* ──────────────────────────────────────────────────────────────────────── api ── */

/**
 * Pick → uploadable File. Throws ImageError with a renderable sentence.
 *
 * The returned File is what the compose box previews and what the writer uploads; the raw pick is
 * dropped on the floor here and never travels further.
 *
 * ⚠️ GIF IS PASSED THROUGH UNMODIFIED, and that is a deliberate trade. A canvas re-encode silently
 * flattens an animation to its first frame — the user gets back a still with no warning, which is
 * the worst kind of wrong. GIF also has no EXIF block and therefore no GPS, so guarantee (1) has
 * nothing to defend against: the reason we re-encode does not apply to this format. What we cannot
 * do is SHRINK one without destroying it, so an oversized GIF is refused with an honest sentence
 * rather than quietly ruined.
 */
export async function processImage(file: File): Promise<File> {
  if (!file) throw new ImageError("No file was picked.");
  if (!isAcceptedType(file.type)) {
    throw new ImageError(
      file.type
        ? `${file.type} is not a picture format Plaza can post. Use PNG, JPEG, WebP or GIF.`
        : "That file did not say what it is. Use a PNG, JPEG, WebP or GIF image.",
      file.name,
    );
  }

  if (file.type === "image/gif") {
    if (file.size > BYTE_BUDGET) {
      throw new ImageError(
        `That GIF is ${sizeVersusLimit(file.size, BYTE_BUDGET)}. ` +
          "Animated GIFs are posted exactly as they are — shrinking one here would flatten it to a " +
          "single frame — so it has to be smaller before it can go up.",
        file.name,
      );
    }
    // Measured only so a preview can reserve its box; the bytes are untouched.
    const decoded = await decode(file).catch(() => null);
    measured.set(file, {
      width: decoded?.width ?? 0,
      height: decoded?.height ?? 0,
      bytesIn: file.size,
      bytesOut: file.size,
      passthrough: true,
    });
    decoded?.release();
    return file;
  }

  const decoded = await decode(file);
  const hasAlpha = file.type === "image/png" || file.type === "image/webp";

  try {
    if (!decoded.width || !decoded.height) {
      throw new ImageError("That image has no size the browser can read, so it cannot be prepared.", file.name);
    }

    let best: { blob: Blob; width: number; height: number } | null = null;
    // Quality first, then resolution. Dropping quality is invisible on a photo long before dropping
    // pixels is, so the ladder is walked in full at each edge and only then does the picture
    // actually get smaller.
    for (const edge of [MAX_EDGE, ...FALLBACK_EDGES]) {
      for (const quality of QUALITY_LADDER) {
        const out = await render(decoded, edge, quality, { hasAlpha, fileName: file.name });
        if (!best || out.blob.size < best.blob.size) best = out;
        if (out.blob.size <= BYTE_BUDGET) return finish(file, out);
      }
    }

    if (!best || best.blob.size > HARD_MAX_BYTES) {
      throw new ImageError(
        "That image is still too large after being resized and re-encoded. Crop it or save it " +
          "smaller, then try again.",
        file.name,
      );
    }
    return finish(file, best);
  } finally {
    decoded.release();
  }
}

function finish(original: File, out: { blob: Blob; width: number; height: number }): File {
  const file = new File([out.blob], renameFor(original.name, out.blob.type), { type: out.blob.type });
  measured.set(file, {
    width: out.width,
    height: out.height,
    bytesIn: original.size,
    bytesOut: out.blob.size,
    passthrough: false,
  });
  return file;
}

export interface ProcessedBatch {
  files: File[];
  /** One entry per refusal, so a picker can keep the good files and explain the bad ones. */
  rejected: { name: string; message: string }[];
}

/**
 * Several picks at once. Partial success on purpose: refusing an entire drop because the fourth
 * image was a 9 MB GIF loses the user work they cannot get back.
 *
 * Only "too many attachments" is thrown, because that one is about the post rather than any file.
 */
export async function processImages(
  input: Iterable<File> | ArrayLike<File> | null | undefined,
  options: { max?: number; already?: number } = {},
): Promise<ProcessedBatch> {
  const max = options.max ?? MAX_ATTACHMENTS;
  const already = options.already ?? 0;
  const picked = Array.from(input ?? []);
  const room = Math.max(0, max - already);

  if (picked.length > room) {
    throw new ImageError(
      room === 0
        ? `A post can carry ${max} images, and this one already has ${already}.`
        : `That is ${picked.length} images and there is room for ${room}. Remove ${picked.length - room}.`,
    );
  }

  const files: File[] = [];
  const rejected: { name: string; message: string }[] = [];
  // Sequential, not Promise.all: each pass allocates a full-size canvas, and decoding eight phone
  // photos at once is how a mobile browser kills the tab.
  for (const file of picked) {
    try {
      files.push(await processImage(file));
    } catch (error) {
      rejected.push({
        name: file?.name ?? "that file",
        message: error instanceof Error ? error.message : "That image could not be prepared.",
      });
    }
  }
  return { files, rejected };
}

/**
 * Build the wire-format reference for an attachment we just uploaded.
 *
 * Dimensions come from the processing pass, not from a fresh measurement, so a reader can reserve
 * the box before the bytes arrive.
 */
export function attachmentFor(
  cid: string,
  file: File,
  extra: { alt?: string; width?: number; height?: number } = {},
): Attachment {
  const meta = imageMeta(file);
  const attachment: Attachment = { cid, mime: file?.type || "application/octet-stream" };
  const width = extra.width ?? meta?.width;
  const height = extra.height ?? meta?.height;
  if (width && height) {
    attachment.width = Math.round(width);
    attachment.height = Math.round(height);
  }
  const alt = String(extra.alt ?? "").trim();
  if (alt) attachment.alt = alt;
  return attachment;
}

/**
 * Every image in a drop or a paste, in order.
 *
 * `DataTransferItemList` and `clipboardData.files` both hand back everything on the clipboard — a
 * screenshot paste in most browsers also carries an HTML fragment and a text/plain fallback — so
 * this filters by type rather than trusting position. Unlike the single-attachment original, it
 * returns them all: a post carries N.
 */
export function imageFilesFrom(list: Iterable<File> | ArrayLike<File> | null | undefined): File[] {
  return Array.from(list ?? []).filter(
    (file): file is File => !!file && typeof file.type === "string" && file.type.startsWith("image/"),
  );
}

/** The first image only — for chat, which allows 0–1 by UI convention. */
export const firstImageFile = (list: Iterable<File> | ArrayLike<File> | null | undefined): File | null =>
  imageFilesFrom(list)[0] ?? null;
