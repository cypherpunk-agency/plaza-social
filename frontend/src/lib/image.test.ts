// Run: node --experimental-strip-types --test src/lib/image.test.ts
//
// The canvas pipeline itself needs a browser, so what is covered here is everything decided BEFORE
// a canvas exists: the refusals (which must be renderable sentences at the attachment field), the
// scale plan, and the multi-attachment bookkeeping. The re-encode path is verified in the browser.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACCEPTED_TYPES,
  ACCEPT_ATTR,
  BYTE_BUDGET,
  ImageError,
  MAX_ATTACHMENTS,
  MAX_EDGE,
  attachmentFor,
  extensionFor,
  firstImageFile,
  formatBytes,
  imageFilesFrom,
  imageMeta,
  isAcceptedType,
  isRenderableImage,
  planScale,
  processImage,
  processImages,
  renameFor,
  sizeVersusLimit,
} from "./image.ts";

/** Enough of a File for every path that refuses before decoding. */
const file = (name: string, type: string, size = 1_000) => ({ name, type, size }) as unknown as File;

test("only the four formats are accepted, and a refusal names the type", async () => {
  assert.deepEqual([...ACCEPTED_TYPES], ["image/png", "image/jpeg", "image/webp", "image/gif"]);
  assert.equal(ACCEPT_ATTR, "image/png,image/jpeg,image/webp,image/gif");
  assert.ok(isAcceptedType("image/png"));
  assert.ok(!isAcceptedType("image/tiff"));
  assert.ok(!isAcceptedType(undefined));

  await assert.rejects(
    () => processImage(file("scan.tif", "image/tiff")),
    (error: unknown) => {
      assert.ok(error instanceof ImageError);
      assert.equal(error.field, "attachments", "the refusal belongs next to the attachment control");
      assert.equal(error.fileName, "scan.tif");
      assert.match(error.message, /image\/tiff is not a picture format/);
      return true;
    },
  );

  await assert.rejects(() => processImage(file("mystery", "")), /did not say what it is/);
  await assert.rejects(() => processImage(null as never), /No file was picked/);
});

test("an oversized GIF is refused honestly instead of being flattened to one frame", async () => {
  await assert.rejects(
    () => processImage(file("dance.gif", "image/gif", 4_500_000)),
    (error: unknown) => {
      assert.ok(error instanceof ImageError);
      assert.match(error.message, /posted exactly as they are/);
      assert.match(error.message, /4\.5 MB, over the 1\.0 MB limit/);
      return true;
    },
  );
});

test("a size just over the line names the exact bytes instead of repeating itself", () => {
  assert.equal(sizeVersusLimit(4_500_000, BYTE_BUDGET), "4.5 MB, over the 1.0 MB limit");
  assert.equal(
    sizeVersusLimit(BYTE_BUDGET + 1, BYTE_BUDGET),
    "1,000,001 bytes, just over the 1.0 MB limit",
    "'1.0 MB, over the 1.0 MB limit' reads like a bug",
  );
});

test("the render whitelist refuses an SVG a stranger's post claims is an image", () => {
  assert.ok(isRenderableImage("image/webp"));
  assert.ok(isRenderableImage("image/JPEG"));
  assert.ok(isRenderableImage("image/png; charset=binary"));
  assert.ok(!isRenderableImage("image/svg+xml"), "an SVG is a scriptable document, so this is XSS");
  assert.ok(!isRenderableImage("text/html"));
  assert.ok(!isRenderableImage(undefined));
});

test("planScale never upscales and always fits the long edge", () => {
  assert.deepEqual(planScale(4000, 3000, MAX_EDGE), { width: 1600, height: 1200, scale: 0.4 });
  assert.deepEqual(planScale(3000, 4000, MAX_EDGE), { width: 1200, height: 1600, scale: 0.4 });
  assert.deepEqual(planScale(200, 100, MAX_EDGE), { width: 200, height: 100, scale: 1 });
  assert.deepEqual(planScale(0, 0, MAX_EDGE), { width: 1, height: 1, scale: 1 }, "never a zero-size canvas");
});

test("the output name matches the format actually encoded", () => {
  assert.equal(extensionFor("image/webp"), "webp");
  assert.equal(extensionFor("image/jpeg"), "jpg");
  assert.equal(extensionFor("image/png"), "jpg", "a PNG is re-encoded, so it must not keep .png");
  assert.equal(renameFor("holiday.HEIC", "image/webp"), "holiday.webp");
  assert.equal(renameFor("", "image/jpeg"), "image.jpg");
  assert.equal(renameFor(".hidden", "image/webp"), "image.webp");
});

test("formatBytes reads like a sentence, not like a debug print", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(900), "900 B");
  assert.equal(formatBytes(1_000_000), "1.0 MB");
  assert.equal(formatBytes(4_500_000), "4.5 MB");
  assert.equal(formatBytes(Number.NaN), "0 B");
});

test("a drop or paste yields every image, in order — a post carries N", () => {
  const list = [
    { name: "note.txt", type: "text/plain" },
    { name: "one.png", type: "image/png" },
    { name: "two.jpg", type: "image/jpeg" },
    null,
  ] as unknown as File[];

  assert.deepEqual(imageFilesFrom(list).map((entry) => entry.name), ["one.png", "two.jpg"]);
  assert.equal(firstImageFile(list)?.name, "one.png", "chat allows 0–1 by UI convention");
  assert.deepEqual(imageFilesFrom(null), []);
  assert.equal(firstImageFile([]), null);
});

test("too many attachments is a refusal about the post, and it counts the room left", async () => {
  const picked = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => file(`p${i}.png`, "image/png"));
  await assert.rejects(() => processImages(picked), (error: unknown) => {
    assert.ok(error instanceof ImageError);
    assert.match(error.message, /there is room for 8/);
    return true;
  });

  await assert.rejects(
    () => processImages([file("a.png", "image/png")], { already: MAX_ATTACHMENTS }),
    /already has 8/,
  );
});

test("a batch keeps the good files and explains the bad ones", async () => {
  // Both of these are refused before any canvas is needed, so the batch resolves in node.
  const batch = await processImages([file("a.tif", "image/tiff"), file("big.gif", "image/gif", BYTE_BUDGET + 1)]);
  assert.deepEqual(batch.files, []);
  assert.deepEqual(
    batch.rejected.map((entry) => entry.name),
    ["a.tif", "big.gif"],
  );
  assert.ok(batch.rejected.every((entry) => entry.message.length > 20));
});

test("attachmentFor builds the wire reference, dimensions included when known", () => {
  const picked = file("shot.webp", "image/webp");
  assert.equal(imageMeta(picked), null, "nothing measured yet");

  assert.deepEqual(attachmentFor("bafy1", picked), { cid: "bafy1", mime: "image/webp" });
  assert.deepEqual(attachmentFor("bafy1", picked, { width: 1600, height: 900, alt: "  a chart  " }), {
    cid: "bafy1",
    mime: "image/webp",
    width: 1600,
    height: 900,
    alt: "a chart",
  });
  assert.deepEqual(attachmentFor("bafy1", file("x", ""), {}), {
    cid: "bafy1",
    mime: "application/octet-stream",
  });
});
