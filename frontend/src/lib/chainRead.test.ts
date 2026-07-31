// Run: node --experimental-strip-types --test src/lib/chainRead.test.ts
//
// These tests pin the INVERSE of what the old ethers read path allowed, and the inversion is the
// point: there is ONE chain-read path, it is the SDK's, and a session without it reports that rather
// than reaching for an HTTP endpoint. They are the chain-state twin of `bulletin.test.ts`, which
// does the same job for post bodies.
//
// TWO KINDS OF TEST LIVE HERE, AND ONLY THE FIRST IS ABOUT BEHAVIOUR:
//
//  1. `createReadContract` over an injected reader — decoding, method resolution, error surfacing.
//  2. ⭐ SOURCE INVARIANTS. Grep-style assertions that no module reachable from a read constructs an
//     `ethers.JsonRpcProvider`, names the old third-party RPC host, or exports `DEFAULT_RPC_URL`.
//     A unit test cannot prove the absence of a network call — but the failure mode being guarded
//     against is somebody RE-ADDING one, and that is exactly what a source assertion catches. The
//     same trick is what would have caught the IPFS gateways coming back.
//
// ⚠️ WHAT NONE OF THIS PROVES: that a real host `.query()` returns real data. That needs a phone.
// Until someone runs it, the SDK chain-read path is **[I]**, not **[V]**.
//
// ⚠️ No frozen clocks anywhere. A `now: () => 0` clock hung a test in this repo indefinitely.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createReadContract, createWriteContract, normaliseCallResult } from "../utils/contracts.ts";
import type { ChainReader } from "./host/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const src = (...parts: string[]) => readFileSync(join(here, "..", ...parts), "utf8");

const ADDRESS = "0xF6daC4BC4e721c5C84504A5Bfe033AE63722f8c9";

/** A slice of the real `PostRegistry` ABI — the multi-output case that matters most. */
const POST_REGISTRY_ABI = [
  {
    type: "function",
    name: "getHeadsPaged",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
    outputs: [
      {
        name: "refs",
        type: "tuple[]",
        components: [
          { name: "cid", type: "string" },
          { name: "prev", type: "string" },
          { name: "storeBlock", type: "uint64" },
          { name: "movedAt", type: "uint64" },
          { name: "by", type: "address" },
          { name: "allowed", type: "bool" },
        ],
      },
      { name: "total", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "headOf",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }, { type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "cid", type: "string" },
          { name: "movedAt", type: "uint64" },
        ],
      },
    ],
  },
  // A write function. Present in the ABI, deliberately NOT special-cased by `createReadContract`.
  { type: "function", name: "setHead", stateMutability: "nonpayable", inputs: [], outputs: [] },
];

/** Records every call so "which method, which args, which address" is checkable. */
function recordingReader(answer: (method: string) => unknown): ChainReader & {
  calls: Array<{ address: string; method: string; args: unknown[] }>;
} {
  const calls: Array<{ address: string; method: string; args: unknown[] }> = [];
  return {
    calls,
    label: "test reader",
    async read(address, _abi, method, args) {
      calls.push({ address, method, args });
      return answer(method);
    },
  };
}

/* ───────────────────────────────────────────────────── decoding and shape ── */

test("a multi-output call is destructurable positionally AND by name", async () => {
  // What `product-sdk-contracts` actually hands back for `outputs.length > 1`: an object keyed by
  // output name. ethers handed back a Result, which is array-like — hence the normalisation.
  const reader = recordingReader(() => ({
    refs: [{ cid: "bafyone", prev: "", storeBlock: 0n, movedAt: 7n, by: "0xabc", allowed: true }],
    total: 3n,
  }));
  const contract = createReadContract(ADDRESS, POST_REGISTRY_ABI, reader)!;

  const result = await contract.getHeadsPaged("0x00", 0, 50);

  // ⭐ The line every list hook actually writes. A bare object makes `refs` undefined, which reads
  // as an empty board rather than as a decoding change — the whole reason this normalisation exists.
  const [refs, total] = result;
  assert.equal(refs.length, 1);
  assert.equal(refs[0].cid, "bafyone");
  assert.equal(total, 3n);

  // …and the named spelling still works, so nothing has to choose.
  assert.equal(result.refs.length, 1);
  assert.equal(result.total, 3n);
});

test("uint64 stays a bigint, so `ref.movedAt > 0n` still means what it says", async () => {
  const reader = recordingReader(() => ({ cid: "bafy", movedAt: 1_700_000_000n }));
  const contract = createReadContract(ADDRESS, POST_REGISTRY_ABI, reader)!;
  const head = await contract.headOf("0x00", "0xabc");
  assert.equal(typeof head.movedAt, "bigint");
  assert.ok(head.movedAt > 0n);
});

test("a single-output struct passes through untouched, named fields intact", async () => {
  const reader = recordingReader(() => ({ cid: "bafy", movedAt: 0n }));
  const contract = createReadContract(ADDRESS, POST_REGISTRY_ABI, reader)!;
  const head = await contract.headOf("0x00", "0xabc");
  assert.equal(head.cid, "bafy");
  assert.ok(!Array.isArray(head), "a struct must not be turned into an array");
});

test("normaliseCallResult leaves an already-array value alone", () => {
  const entry = { outputs: [{ name: "a", type: "uint256" }, { name: "b", type: "uint256" }] };
  const already = [1n, 2n];
  assert.equal(normaliseCallResult(entry, already), already);
});

test("the address and the args reach the reader verbatim", async () => {
  const reader = recordingReader(() => ({ refs: [], total: 0n }));
  const contract = createReadContract(ADDRESS, POST_REGISTRY_ABI, reader)!;
  await contract.getHeadsPaged("0xdeadbeef", 0, 50);
  assert.deepEqual(reader.calls, [
    { address: ADDRESS, method: "getHeadsPaged", args: ["0xdeadbeef", 0, 50] },
  ]);
});

/* ─────────────────────────────────────────────────── refusing, not faking ── */

test("no reader means no contract — the out-of-host state, and it is a null, not a throw", () => {
  assert.equal(createReadContract(ADDRESS, POST_REGISTRY_ABI, null), null);
  assert.equal(createReadContract(null, POST_REGISTRY_ABI, recordingReader(() => 0)), null);
});

test("a failed read PROPAGATES — it never becomes a plausible empty list", async () => {
  // ⛔ The rule this pins: `lib/poll.ts` keeps the last good list on a failed background poll and
  // `walk.ts` renders an unreadable body as a hole with a reason. Both need to be TOLD.
  const reader: ChainReader = {
    label: "broken",
    async read() {
      throw new Error("the host refused");
    },
  };
  const contract = createReadContract(ADDRESS, POST_REGISTRY_ABI, reader)!;
  await assert.rejects(() => contract.getHeadsPaged("0x00", 0, 50), /the host refused/);
});

test("a method the ABI does not have is absent, so calling it fails in JS naming the method", () => {
  const contract = createReadContract(ADDRESS, POST_REGISTRY_ABI, recordingReader(() => 0))!;
  // The friendliest disguise of this codebase's most common bug — see frontend/CLAUDE.md's table of
  // four. A catch-all proxy would have turned it into an opaque chain error instead.
  assert.equal(typeof contract.getThreadCount, "undefined");
});

test("createWriteContract always returns null — there is no ethers signing arm", async () => {
  assert.equal(await createWriteContract(ADDRESS, POST_REGISTRY_ABI, null, null), null);
});

/* ────────────────────────────────────────────────────── source invariants ── */
//
// ⭐ THE POINT OF THIS BLOCK. The removed thing is a network path, and the way it comes back is a
// one-line edit that no behavioural test would notice. So assert on the source.

const READ_PATH_MODULES = [
  "utils/contracts.ts",
  "lib/host/session.ts",
  "lib/host/backend.ts",
  "lib/host/fake.ts",
  "lib/host/contracts.ts",
  "lib/host/delegate.ts",
  "hooks/usePublisher.tsx",
  "hooks/useForumThread.ts",
  "hooks/useUserPosts.ts",
  "hooks/useReplies.ts",
  "hooks/useUserRegistry.ts",
  "hooks/useVoting.ts",
  "hooks/useFollowRegistry.ts",
  "hooks/useFeed.ts",
];

/** Strip comments, so the long explanatory notes ABOUT the removed path do not trip the check. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("no module on the read path constructs an ethers provider", () => {
  for (const module of READ_PATH_MODULES) {
    const body = code(src(module));
    assert.ok(
      !/new\s+ethers\.(JsonRpc|WebSocket|Browser|Fallback|Alchemy|Infura)\w*Provider/.test(body),
      `${module} constructs an ethers Provider — chain reads go through the SDK. See gotchas.md ` +
        "§ THE SDK PATH IS THE ONLY PATH.",
    );
  }
});

test("no module on the read path names an HTTP or WebSocket endpoint", () => {
  for (const module of READ_PATH_MODULES) {
    const body = code(src(module));
    const found = body.match(/["'`](https?|wss?):\/\/[^"'`]+["'`]/g);
    assert.equal(
      found,
      null,
      `${module} contains a literal endpoint ${found?.join(", ")}. An external origin is what the ` +
        "host prompts the user about; that is how the IPFS gateways and the public RPC both got in.",
    );
  }
});

test("no module on the read path constructs an ethers Wallet", () => {
  for (const module of READ_PATH_MODULES) {
    const body = code(src(module));
    assert.ok(
      !/new\s+ethers\.Wallet\b/.test(body),
      `${module} constructs an ethers.Wallet — the delegate arm was removed and cannot sign. See ` +
        "lib/host/types.ts SignerSeam.",
    );
  }
});

test("DEFAULT_RPC_URL is gone from the seam's public surface", () => {
  assert.ok(
    !/DEFAULT_RPC_URL/.test(src("lib/host/index.ts")),
    "lib/host/index.ts still exports DEFAULT_RPC_URL. There is no endpoint to configure.",
  );
  assert.ok(
    !/export\s+const\s+DEFAULT_RPC_URL/.test(src("lib/host/backend.ts")),
    "backend.ts still declares DEFAULT_RPC_URL. An endpoint constant is an invitation to make it " +
      "overridable, which is how ?rpc=<url> happened.",
  );
});

/**
 * ⚠️ A SOURCE ASSERTION RATHER THAN A CALL, AND NOT BY CHOICE. `backend.ts` imports `./fake` and
 * `./session` without file extensions, which Vite resolves and bare Node ESM does not — so
 * `parseBackendSelection` cannot be imported into a `node --test` run at all. The invariant is worth
 * pinning anyway, because it is a SECURITY one, so it is pinned the only way available here.
 *
 * ⛔ THE SECURITY CASE: `frontend/CLAUDE.md` records **[V]** that the dot.li shell forwards query
 * params INBOUND, so a shared `?rpc=https://evil.example` used to point the whole app at an
 * attacker-chosen origin — fabricated heads, profiles and vote tallies, and arbitrary CIDs handed to
 * the host's preimage lookup.
 */
test("?rpc= is a boolean switch and cannot carry a value", () => {
  const body = src("lib/host/backend.ts");
  assert.match(
    body,
    /chainReads:\s*params\.get\(['"]rpc['"]\)\s*!==\s*['"]off['"]/,
    "backend.ts no longer parses ?rpc= as a plain boolean switch.",
  );
  assert.ok(
    !/rpcUrl/.test(code(body)),
    "backend.ts mentions rpcUrl again — ?rpc= must never carry a value, and there is no endpoint " +
      "left for an allowlist to allow.",
  );
});

test("the SignerSeam has exactly one arm", () => {
  const body = src("lib/host/types.ts");
  assert.ok(
    !/^\s*delegateSigner\s*:/m.test(body),
    "SignerSeam has a delegateSigner again. It was an ethers.Wallet on a public RPC, unfunded, and " +
      "every call site named vote()/follow() rather than voteFor()/followFor().",
  );
});

test("the six migrated write call sites go through the host writer, not a signer", () => {
  for (const module of ["hooks/useVoting.ts", "hooks/useFollowRegistry.ts", "hooks/useUserRegistry.ts"]) {
    const body = code(src(module));
    assert.ok(
      /useHostWrite\(\)/.test(body),
      `${module} does not reach for the host-signed writer.`,
    );
    assert.ok(
      !/createWriteContract\s*\(/.test(body),
      `${module} still builds an ethers write contract. Contract writes are host-signed; see ` +
        "gotchas.md § no allowance: a delegate key is not an escape route.",
    );
    assert.ok(
      !/\.wait\(\)/.test(body),
      `${module} awaits an Ethereum receipt. writeContract returns a SUBSTRATE extrinsic hash, ` +
        "already watched to best-block — there is no receipt, and read-after-write must poll.",
    );
  }
});
