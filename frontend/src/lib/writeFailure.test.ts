// The reply that failed on a real phone, pinned so it cannot come back silently.
//
// On 2026-07-31 06:46Z a forum reply failed with, verbatim on the user's screen:
//
//     TxError: createTransaction failed: HostFailure: Submit failed, no allowance set for account
//
// Two independent defects produced that, and each gets its own section below.
//
//   1. The persisted allowance claim had no way to die. A claim written at 22:22 the night before
//      was still inside its 24 h TTL, so the first write of the morning reused it and never asked
//      the host — even though the host had just told us, in as many words, that there is no
//      allowance. `AllowanceGate.invalidate()` is the fix and §2 is what proves it works.
//   2. `lib/host/errors.ts` knew exactly what that string meant and NOTHING CALLED IT. Its only
//      importer was a re-export list. `WriteFailure` is the fix and §1 is what proves it is on the
//      path.
//
// Both are testable without a host, which is the point: this write path only runs inside a
// container, i.e. on a phone, where every bug costs a deploy to see.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { createPublisher, type HeadRow } from "./publish.ts";
import {
  WriteFailure,
  asWriteFailure,
  classifyWriteFailure,
  isAllowanceFailure,
} from "./host/errors.ts";
import { createAllowanceGate } from "./host/allowance.ts";

/** The exact string the phone showed, kept as a literal so a regex change cannot quietly miss it. */
const REAL_FAILURE =
  "createTransaction failed: HostFailure: Submit failed, no allowance set for account";

const AUTHOR = "0x18773c30d65de35027ac8cd19e98c0ddb9c44ef9";
const REGISTRY = `0x${"11".repeat(32)}`;

/* ============================================================ 1. the message == */

describe("the host's allowance string becomes something a user can act on", () => {
  it("classifies it as a missing statement-store allowance, not a gas or contract problem", () => {
    const { code, confidence } = classifyWriteFailure(new Error(REAL_FAILURE));
    // Verified 2026-07-31 against the live host bundle: `noAllowance` is a STATEMENT-STORE submit
    // rejection, and the statement store is the transport of the SSO channel to the phone.
    // Verified the same day against the Individuality chain: that allowance is personhood-gated,
    // which is why the code is no longer called `stale_session`.
    assert.equal(code, "no_statement_allowance");
    assert.equal(confidence, "high");
  });

  it("does not mistake it for the pre-warmed-PGAS refusal, which reads similarly", () => {
    assert.equal(classifyWriteFailure(new Error("SmartContractAllowance was Rejected")).code, "no_contract_allowance");
  });

  it("turns it into one actionable line that a toast can hold", () => {
    const failure = new WriteFailure(new Error(REAL_FAILURE), { stored: true });

    // The three things that make it actionable, and nothing about "createTransaction".
    assert.match(failure.message, /saved/i, "must lead with the words not being lost");
    assert.match(failure.message, /Polkadot app/i, "must name the remedy that actually works");
    // ⛔ AND MUST NOT NAME THE ONE THAT DOES NOT. We shipped "signing in again refreshes it" on
    // 2026-07-31 and it was false: pairing is read-only on the browser side, so a fresh login mints a
    // new statement account that needs the same personhood-gated on-chain slot the old one lacked.
    assert.doesNotMatch(failure.message, /sign(ing)? in again/i);
    assert.doesNotMatch(failure.message, /no allowance set for account/i);
    assert.doesNotMatch(failure.message, /HostFailure|TxError|createTransaction/);

    // `lib/errors.ts` `summarise()` puts this straight into a toast, and only the first line of it.
    assert.ok(failure.message.length < 200, `message is ${failure.message.length} chars`);
    assert.equal(failure.message.split("\n").length, 1);
  });

  it("keeps the raw host text as the cause, so a bug report still carries it", () => {
    const raw = new Error(REAL_FAILURE);
    const failure = new WriteFailure(raw, { stored: true });
    assert.equal(failure.cause, raw);
  });

  it("never promises a retry that travels the same dead channel", () => {
    const failure = new WriteFailure(new Error(REAL_FAILURE), { stored: true });
    // `requestResourceAllocation` goes over the SSO/statement-store channel that just refused the
    // write, so "we re-request the allowance and it often clears it" — the `no_contract_allowance`
    // copy — must never be shown for this code.
    assert.doesNotMatch(failure.steps, /re-requests the allowance/i);
    // The remedy that removes the channel rather than repairing it must be step one.
    assert.match(failure.steps, /^1\. Open Plaza from inside the Polkadot app/m);
    // And the steps must actively DISOWN the old advice, because it shipped and people read it.
    assert.match(failure.steps, /Signing in again on its own will not help/);
  });

  it("does not tell someone their words are safe when the BODY is what failed", () => {
    const failure = new WriteFailure(new Error("Bulletin write failed: no authorized write path"), {
      stored: false,
    });
    assert.equal(failure.stored, false);
    // Every matcher title in `host/errors.ts` reads "your post is saved". That is a lie for a body
    // failure, and `stored` is what overrides it.
    assert.doesNotMatch(failure.message, /saved|not lost/i);
  });

  it("passes validation errors through untouched — they are already the best message", () => {
    const tooLong = Object.assign(new Error("That message is 341 characters, 21 over the limit."), {
      code: "too_long",
    });
    assert.equal(asWriteFailure(tooLong, { stored: false }), tooLong);
  });

  it("does not double-wrap", () => {
    const once = asWriteFailure(new Error(REAL_FAILURE), { stored: true });
    assert.equal(asWriteFailure(once, { stored: true }), once);
  });

  it("knows which codes a cached allowance claim could be responsible for", () => {
    assert.equal(isAllowanceFailure("no_statement_allowance"), true);
    assert.equal(isAllowanceFailure("no_contract_allowance"), true);
    // Invalidating on any failure would discard a good grant every time an RPC hiccuped.
    for (const code of ["no_funds", "not_mapped", "unknown", "validation"] as const) {
      assert.equal(isAllowanceFailure(code), false, code);
    }
  });
});

/* ================================================ 1b. it is actually ON the path == */

describe("publish() wraps both legs, so no raw host string can reach a screen", () => {
  /** A publisher over a fake chain. Nothing here polls, so no clock is needed. */
  const publisherWith = (io: { putBlob?: () => Promise<string>; writeHead?: () => Promise<{ txHash: string }> }) =>
    createPublisher({
      author: AUTHOR,
      readHead: async (): Promise<HeadRow | null> => null,
      putBlob: io.putBlob ?? (async () => "bafyfake"),
      writeHead: io.writeHead ?? (async () => ({ txHash: "0xdead" })),
    })!;

  const draft = () => ({
    registry: REGISTRY,
    build: () => ({ v: 1, kind: "post", at: 1, author: AUTHOR, body: "hi" }) as never,
  });

  it("wraps a POINTER failure as stored — the words are on Bulletin already", async () => {
    const publisher = publisherWith({
      writeHead: async () => {
        throw new Error(REAL_FAILURE);
      },
    });

    const error = await publisher.publish(draft()).then(
      () => null,
      (e: unknown) => e,
    );

    assert.ok(error instanceof WriteFailure, `got ${String(error)}`);
    assert.equal(error.stored, true);
    assert.equal(error.code, "no_statement_allowance");
    assert.doesNotMatch(error.message, /no allowance set for account/i);
  });

  it("wraps a BODY failure as not stored — nothing was written, retrying is free", async () => {
    const publisher = publisherWith({
      putBlob: async () => {
        throw new Error("Bulletin write failed: preimage channel failed");
      },
    });

    const error = await publisher.publish(draft()).then(
      () => null,
      (e: unknown) => e,
    );

    assert.ok(error instanceof WriteFailure);
    assert.equal(error.stored, false);
  });
});

/* ====================================================== 2. the latch that lied == */

interface Store {
  [key: string]: string;
}

/** Minimal `localStorage`. `allowance.ts` reads `globalThis.localStorage` at call time. */
function installStorage(initial: Store = {}): Store {
  const data: Store = { ...initial };
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
    removeItem: (k: string) => {
      delete data[k];
    },
  };
  return data;
}

const silentDiagnostics = () => ({
  step: () => {},
  get: () => null,
  list: () => [],
  hasFailure: () => false,
  reset: () => {},
  subscribe: () => () => {},
});

/** Counts host requests so "did we ask?" is directly observable. */
function gateHarness(store: Store = {}) {
  installStorage(store);
  const asked: Array<Array<{ tag: string; value?: number }>> = [];
  const gate = createAllowanceGate({
    address: () => AUTHOR,
    diagnostics: silentDiagnostics(),
    request: async (resources) => {
      asked.push(resources);
      return ["Allocated", "Allocated", "Allocated"];
    },
  });
  return { gate, asked };
}

const claimKey = `plaza.allowance.v1:${AUTHOR}`;

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("a persisted claim can be destroyed by evidence", () => {
  it("reuses a claim from 8 hours ago — the behaviour that broke replies", async () => {
    // The real timeline: claim written 2026-07-30 22:22, reply attempted 06:46 the next morning.
    const eightHoursAgo = Date.now() - 8 * 60 * 60 * 1000;
    const { gate, asked } = gateHarness({
      [claimKey]: JSON.stringify({ at: eightHoursAgo, outcomes: "all=Allocated" }),
    });

    await gate.ensure();
    assert.equal(asked.length, 0, "an 8h-old claim is inside the 24h TTL and is still trusted");
  });

  it("after invalidate(), the NEXT write asks the host again", async () => {
    const eightHoursAgo = Date.now() - 8 * 60 * 60 * 1000;
    const store: Store = {
      [claimKey]: JSON.stringify({ at: eightHoursAgo, outcomes: "all=Allocated" }),
    };
    const { gate, asked } = gateHarness(store);

    await gate.ensure();
    assert.equal(asked.length, 0);

    // This is what `session.ts` does when a contract write comes back naming an allowance.
    gate.invalidate('setHead failed with "no_statement_allowance"');

    await gate.ensure();
    assert.equal(asked.length, 1, "the refuted claim must not survive into the next write");
    assert.equal(store[claimKey] !== undefined, true, "and the fresh answer is persisted");
  });

  it("invalidate() clears BOTH halves — the persisted claim and the in-memory latch", async () => {
    const { gate, asked } = gateHarness();

    await gate.ensure();
    assert.equal(asked.length, 1, "no claim, so the first write asks");
    await gate.ensure();
    assert.equal(asked.length, 1, "the in-memory latch covers the rest of the page load");

    gate.invalidate("test");

    await gate.ensure();
    assert.equal(asked.length, 2, "in-memory latch cleared too, not just localStorage");
  });

  it("invalidate() never requests — it must not stack a dialog on top of an error", () => {
    const { gate, asked } = gateHarness();
    gate.invalidate("test");
    assert.equal(asked.length, 0);
  });

  it("invalidate() never throws, even with no storage at all", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    const gate = createAllowanceGate({
      address: () => AUTHOR,
      diagnostics: silentDiagnostics(),
      request: async () => ["Allocated"],
    });
    assert.doesNotThrow(() => gate.invalidate("no storage"));
  });

  it("still never gates: a request that rejects resolves to null rather than throwing", async () => {
    installStorage();
    const gate = createAllowanceGate({
      address: () => AUTHOR,
      diagnostics: silentDiagnostics(),
      request: async () => {
        throw new Error("the host never answered");
      },
    });
    // The host may still allocate implicitly on submission, so a refusal must never stop a write.
    assert.equal(await gate.ensure(), null);
  });

  it("a refused request writes no claim, so the next load is free to ask again", async () => {
    const store = installStorage();
    const gate = createAllowanceGate({
      address: () => AUTHOR,
      diagnostics: silentDiagnostics(),
      request: async () => {
        throw new Error("the host never answered");
      },
    });
    await gate.ensure();
    assert.equal(store[claimKey], undefined);
  });
});
