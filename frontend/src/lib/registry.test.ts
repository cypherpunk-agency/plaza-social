import test from "node:test";
import assert from "node:assert/strict";

import {
  FEED_REGISTRY,
  FORUM_REGISTRY,
  THREAD_REGISTRY_PREFIX,
  openRegistryId,
  threadRegistryId,
} from "./registry.ts";

const CID_A = "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CID_B = "bafkreibbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

test("an open registry id is 32 bytes of hex", () => {
  const id = openRegistryId("forum");
  assert.match(id, /^0x[0-9a-f]{64}$/);
});

test("the well-known ids are pinned to their on-chain values", () => {
  // ⚠️ FIXED VECTORS, NOT A TAUTOLOGY. If either of these changes, every thread and profile feed
  // already on chain becomes unreadable: the head rows are keyed on the old value and nothing
  // migrates them. Compare against the literal, never against another call to the same function.
  assert.equal(FORUM_REGISTRY, "0x95b1bbd6e620d4d2a2c3ae208bf375ced6d73e66682a9327db27386507ceb970");
  assert.equal(FEED_REGISTRY, "0x4258863e2d81c316e4a4dd381c3c50f57f933be22afba98b4485a605da0f7811");
  assert.notEqual(FORUM_REGISTRY, FEED_REGISTRY);
});

test("a thread's replies live in the open id derived from its CID", () => {
  assert.equal(threadRegistryId(CID_A), openRegistryId(`${THREAD_REGISTRY_PREFIX}${CID_A}`));
});

test("different parents get different reply registries", () => {
  assert.notEqual(threadRegistryId(CID_A), threadRegistryId(CID_B));
});

test("the same parent always gets the same reply registry", () => {
  assert.equal(threadRegistryId(CID_A), threadRegistryId(CID_A));
});

test("a reply registry can never collide with a board or feed", () => {
  // The prefix is what guarantees this: a board would have to be literally named "thread:<cid>".
  assert.notEqual(threadRegistryId(CID_A), FORUM_REGISTRY);
  assert.notEqual(threadRegistryId(CID_A), FEED_REGISTRY);
  assert.notEqual(threadRegistryId("forum"), FORUM_REGISTRY);
});

test("a missing CID yields null, NOT a hash of the bare prefix", () => {
  // Hashing "thread:" would be a single valid registry id, so every unresolved parent's replies
  // would merge into one shared conversation. Null forces the caller to render nothing instead.
  for (const absent of [null, undefined, ""]) {
    assert.equal(threadRegistryId(absent), null);
  }
  assert.notEqual(threadRegistryId(CID_A), openRegistryId(THREAD_REGISTRY_PREFIX));
});
