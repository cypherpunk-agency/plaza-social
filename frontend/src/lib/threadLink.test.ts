import test from "node:test";
import assert from "node:assert/strict";

import {
  THREAD_LINK_ORIGIN,
  readThreadSelection,
  threadShareUrl,
  writeThreadSelection,
} from "./threadLink.ts";

const CID_A = "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("the share origin is the .dot deep link, not the .dev-dot.li gateway", () => {
  // ⚠️ FIXED VECTOR, NOT A TAUTOLOGY. `navigateTo` routes a `.dot` link INSIDE the container and an
  // ordinary https:// host EXTERNALLY, so swapping this for the gateway host silently turns every
  // shared thread into "opens a browser next to Plaza".
  assert.equal(THREAD_LINK_ORIGIN, "https://plaza-social.dot");
});

test("a share url carries the cid and nothing positional", () => {
  assert.equal(threadShareUrl(CID_A), `https://plaza-social.dot/?cid=${CID_A}`);
});

test("a thread with no cid has no share url", () => {
  assert.equal(threadShareUrl(""), null);
  assert.equal(threadShareUrl(null), null);
  assert.equal(threadShareUrl(undefined), null);
  assert.equal(threadShareUrl("   "), null);
});

test("cid round-trips through the query string", () => {
  const url = threadShareUrl(CID_A)!;
  assert.equal(readThreadSelection(new URL(url).search).cid, CID_A);
});

test("?thread=N still resolves, as a legacy position", () => {
  assert.deepEqual(readThreadSelection("?thread=3"), { cid: null, legacyIndex: 3 });
  assert.deepEqual(readThreadSelection("?thread=0"), { cid: null, legacyIndex: 0 });
});

test("cid wins when both params are present", () => {
  assert.deepEqual(readThreadSelection(`?thread=7&cid=${CID_A}`), {
    cid: CID_A,
    legacyIndex: null,
  });
});

test("a malformed ?thread= selects nothing rather than something plausible", () => {
  // `parseInt("3abc")` is 3. Silently selecting the fourth thread for a broken link is exactly the
  // positional bug this change exists to remove.
  for (const bad of ["?thread=3abc", "?thread=", "?thread=-1", "?thread=0x2", "?thread=1.5"]) {
    assert.deepEqual(readThreadSelection(bad), { cid: null, legacyIndex: null }, bad);
  }
});

test("no params selects nothing", () => {
  assert.deepEqual(readThreadSelection(""), { cid: null, legacyIndex: null });
  assert.deepEqual(readThreadSelection("?profile=0xabc"), { cid: null, legacyIndex: null });
});

test("projecting a cid drops the legacy param", () => {
  const params = new URLSearchParams("thread=7&profile=0xabc");
  writeThreadSelection(params, { cid: CID_A, legacyIndex: 7 });
  assert.equal(params.get("cid"), CID_A);
  assert.equal(params.get("thread"), null);
  // Unrelated params are left alone — this function owns two keys and no others.
  assert.equal(params.get("profile"), "0xabc");
});

test("an unresolved legacy selection keeps ?thread= so a reload does not lose it", () => {
  const params = new URLSearchParams();
  writeThreadSelection(params, { cid: null, legacyIndex: 2 });
  assert.equal(params.get("thread"), "2");
  assert.equal(params.get("cid"), null);
});

test("no selection removes both params", () => {
  const params = new URLSearchParams(`cid=${CID_A}&thread=1`);
  writeThreadSelection(params, { cid: null, legacyIndex: null });
  assert.equal(params.get("cid"), null);
  assert.equal(params.get("thread"), null);
});

test("selection survives a full projection/parse round trip", () => {
  const params = new URLSearchParams();
  writeThreadSelection(params, { cid: CID_A, legacyIndex: null });
  assert.deepEqual(readThreadSelection(params), { cid: CID_A, legacyIndex: null });
});
