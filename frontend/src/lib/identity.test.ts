// Tests for the identity report — the DEBUG / IDENTITY panel's data layer.
//
// ⚠️ WHAT IS ACTUALLY WORTH PINNING HERE. Not "does it render a field" — the value of this panel is
// that it never lies, and there are exactly three ways it could:
//
//   1. an absent fact rendered as a blank or a plausible default (absent ≠ empty ≠ zero);
//   2. the `.dot` suffix rule drifting away from the SDK's, which would make the panel report a
//      product identifier that is not the one on the wire — i.e. the exact class of bug it is
//      investigating;
//   3. the COPY ALL block and the on-screen list disagreeing, since the whole point is that a user
//      pastes the block instead of transcribing the screen.
//
// The module is pure and calls no host, so all three are testable with no browser and no SDK.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildIdentityReport,
  emptyEnvironment,
  emptySnapshot,
  formatIdentityReport,
  productIdentifierFromDappName,
  type HostIdentitySnapshot,
  type IdentityField,
} from "./host/identity.ts";

/** Flatten the report so a test can ask for one key without knowing which section holds it. */
function fieldsOf(sections: ReturnType<typeof buildIdentityReport>): Map<string, IdentityField> {
  const map = new Map<string, IdentityField>();
  for (const section of sections) {
    for (const field of section.fields) map.set(field.key, field);
  }
  return map;
}

function report(snapshot: HostIdentitySnapshot | null, backendLabel = "Polkadot host container") {
  return fieldsOf(
    buildIdentityReport({
      snapshot,
      environment: emptyEnvironment(),
      backendLabel,
      capabilityAddress: null,
      capabilityInsideHost: false,
    }),
  );
}

/* ------------------------------------------------------- the suffix rule -- */

test("productIdentifierFromDappName matches the SDK rule verbatim", () => {
  // The three branches of `product-sdk-signer/src/providers/host.ts`.
  assert.equal(productIdentifierFromDappName("plaza"), "plaza.dot");
  assert.equal(productIdentifierFromDappName("plaza-social"), "plaza-social.dot");
  // Already suffixed: left alone, never double-suffixed.
  assert.equal(productIdentifierFromDappName("plaza.dot"), "plaza.dot");
  // Localhost forms are already complete product identifiers, port and all.
  assert.equal(productIdentifierFromDappName("localhost"), "localhost");
  assert.equal(productIdentifierFromDappName("localhost:5173"), "localhost:5173");
  assert.equal(productIdentifierFromDappName("127.0.0.1:5173"), "127.0.0.1:5173");
  assert.equal(productIdentifierFromDappName("app.localhost:3000"), "app.localhost:3000");
});

test("⭐ the landmine is visible: APP_NAME 'plaza' does NOT produce the deployed name", () => {
  // If this ever passes as equal, either APP_NAME was renamed (a migration, not a rename — it
  // orphans the profile and the two threads on chain) or the deploy target moved.
  assert.notEqual(productIdentifierFromDappName("plaza"), "plaza-social.dot");
});

/* ----------------------------------------------- absence is never a blank -- */

test("with no session every account field is unavailable WITH a reason, never empty", () => {
  const fields = report(null);
  for (const key of [
    "account.ss58",
    "account.h160",
    "account.publicKey",
    "account.primaryUsername",
    "account.provider",
    "account.count",
  ]) {
    const field = fields.get(key);
    assert.ok(field, `${key} must exist even with no session`);
    assert.equal(field.value.status, "unavailable", `${key} must not fabricate a value`);
    if (field.value.status === "unavailable") {
      assert.ok(field.value.reason.length > 20, `${key} must explain WHY it is absent`);
    }
  }
});

test("the fake backend gets its own reason rather than the generic one", () => {
  const fields = report(null, "fake backend (can write, no live updates)");
  const ss58 = fields.get("account.ss58")!;
  assert.equal(ss58.value.status, "unavailable");
  if (ss58.value.status === "unavailable") {
    assert.match(ss58.value.reason, /\?backend=fake/);
  }
});

test("a connected session with no username reports the SDK's silence, not an empty name", () => {
  const snapshot: HostIdentitySnapshot = {
    ...emptySnapshot(),
    at: 1,
    dappName: "plaza",
    productIdentifierRequested: "plaza.dot",
    connect: "ok",
    accounts: [
      {
        address: "5EJ3VTQLFVGHh2nrwpD9VyAFhYhhKnHxRTfGsGifFS4sx2rz",
        h160Address: "0x18773c30d65de35027ac8cd19e98c0ddb9c44ef9",
        publicKeyHex: "0x62a4c082",
        name: null,
        source: "host",
      },
    ],
    selected: null,
  };
  const fields = report(snapshot);

  // The address is present and FULL — no truncation anywhere in this module.
  assert.deepEqual(fields.get("account.ss58")!.value, {
    status: "value",
    value: "5EJ3VTQLFVGHh2nrwpD9VyAFhYhhKnHxRTfGsGifFS4sx2rz",
  });
  assert.deepEqual(fields.get("account.h160")!.value, {
    status: "value",
    value: "0x18773c30d65de35027ac8cd19e98c0ddb9c44ef9",
  });

  const username = fields.get("account.primaryUsername")!;
  assert.equal(username.value.status, "unavailable");
  if (username.value.status === "unavailable") {
    // It must say the SDK asked and got nothing — not "no session", which would be a lie here.
    assert.match(username.value.reason, /getUserId/);
  }
});

test("a second account is listed in full rather than counted", () => {
  const snapshot: HostIdentitySnapshot = {
    ...emptySnapshot(),
    at: 1,
    connect: "ok",
    accounts: [
      { address: "5AAA", h160Address: "0xaa", publicKeyHex: "0x01", name: "alice.01", source: "host" },
      { address: "5BBB", h160Address: "0xbb", publicKeyHex: "0x02", name: "alice.02", source: "host" },
    ],
    selected: { address: "5AAA", h160Address: "0xaa", publicKeyHex: "0x01", name: "alice.01", source: "host" },
  };
  const fields = report(snapshot);

  assert.deepEqual(fields.get("account.count")!.value, { status: "value", value: "2" });
  const other = fields.get("account.other[0]")!;
  assert.equal(other.value.status, "value");
  if (other.value.status === "value") {
    assert.match(other.value.value, /5BBB/);
    assert.match(other.value.value, /alice\.02/);
  }
  // And the "none" placeholder must NOT also be present — one or the other, never both.
  assert.equal(fields.get("account.others"), undefined);
});

/* ------------------------------- the reason must match the stage reached -- */
//
// ⛔ THE BUG THIS SUITE EXISTS FOR, caught on a real render: a session whose handshake had NEVER RUN
// reported `account.primaryUsername: unavailable — the SDK fetched it during connect() and got
// nothing back`. That is a confident, false statement about the host, produced by the one screen
// built to stop people making those. The reason has to track `connect`, not merely "is there a
// snapshot".

test("a handshake that never ran does NOT claim the SDK asked and got nothing", () => {
  const fields = report({ ...emptySnapshot(), at: 1, dappName: "plaza", connect: "pending" });
  const username = fields.get("account.primaryUsername")!;
  assert.equal(username.value.status, "unavailable");
  if (username.value.status === "unavailable") {
    assert.match(username.value.reason, /never ran/);
    assert.equal(/getUserId\(\) answered/.test(username.value.reason), false);
  }
  // And nothing counts accounts a handshake never produced.
  assert.equal(fields.get("account.count")!.value.status, "unavailable");
  assert.equal(fields.get("account.others")!.value.status, "unavailable");
});

test("a FAILED handshake reports its own error as the reason for every missing account field", () => {
  const fields = report({
    ...emptySnapshot(),
    at: 1,
    connect: "failed",
    connectError: "Wallet connect timed out after 20s",
  });
  const ss58 = fields.get("account.ss58")!;
  assert.equal(ss58.value.status, "unavailable");
  if (ss58.value.status === "unavailable") {
    assert.match(ss58.value.reason, /FAILED/);
    assert.match(ss58.value.reason, /timed out after 20s/);
  }
  // The error itself is a VALUE, not an "unavailable" — we know it.
  assert.deepEqual(fields.get("signer.connectError")!.value, {
    status: "value",
    value: "Wallet connect timed out after 20s",
  });
});

test('"no error" is a value, not an absence — `unavailable — none` would read as "we could not find out"', () => {
  const fields = report({ ...emptySnapshot(), at: 1, connect: "ok", signerError: null });
  const err = fields.get("signer.error")!;
  assert.equal(err.value.status, "value");
  if (err.value.status === "value") assert.match(err.value.value, /^none/);
});

test("sdk.installed and container.inside stay unavailable until the check has actually run", () => {
  // The snapshot is published BEFORE the container check, so `false` here would be fabricated.
  const early = report({ ...emptySnapshot(), at: 1, connect: "pending" });
  assert.equal(early.get("sdk.installed")!.value.status, "unavailable");
  assert.equal(early.get("container.inside")!.value.status, "unavailable");

  const checked = report({ ...emptySnapshot(), at: 1, connect: "pending", sdkInstalled: true, insideContainer: false });
  assert.deepEqual(checked.get("sdk.installed")!.value, { status: "value", value: "true" });
  assert.deepEqual(checked.get("container.inside")!.value, { status: "value", value: "false" });
});

/* -------------------------------------- the negative findings are findings -- */

test("the host's silence about the product identifier is stated as a fact, not omitted", () => {
  const fields = report(null);
  const reported = fields.get("host.reportedProductIdentifier")!;
  assert.equal(reported.value.status, "unavailable");
  if (reported.value.status === "unavailable") {
    // It must name the wire shape, so nobody has to re-derive the finding from the SDK typings.
    assert.match(reported.value.reason, /publicKey/);
  }
});

test("the h160 → AccountId32 prohibition is on the screen, not just in a comment", () => {
  const fields = report(null);
  const rule = fields.get("notDerived.accountId32FromH160")!;
  assert.equal(rule.value.status, "unavailable");
  if (rule.value.status === "unavailable") {
    assert.match(rule.value.reason, /OriginalAccount/);
  }
});

test("every field carries a source, in every state", () => {
  for (const sections of [
    buildIdentityReport({
      snapshot: null,
      environment: emptyEnvironment(),
      backendLabel: "x",
      capabilityAddress: null,
      capabilityInsideHost: false,
    }),
    buildIdentityReport({
      snapshot: { ...emptySnapshot(), at: 1, connect: "ok" },
      environment: emptyEnvironment(),
      backendLabel: "x",
      capabilityAddress: "0xabc",
      capabilityInsideHost: true,
    }),
  ]) {
    for (const section of sections) {
      for (const field of section.fields) {
        assert.ok(field.source.length > 0, `${field.key} has no source`);
      }
    }
  }
});

/* ---------------------------------------------------- the COPY ALL block -- */

test("COPY ALL emits one key: value line per field, with the source as a trailing comment", () => {
  const sections = buildIdentityReport({
    snapshot: { ...emptySnapshot(), at: 1, dappName: "plaza", productIdentifierRequested: "plaza.dot", connect: "ok" },
    environment: emptyEnvironment(),
    backendLabel: "Polkadot host container",
    capabilityAddress: "0xabc",
    capabilityInsideHost: true,
  });
  const text = formatIdentityReport(sections, { generatedAt: 0 });

  assert.match(text, /^PLAZA DEBUG \/ IDENTITY\n/);
  assert.match(text, /^generated: 1970-01-01T00:00:00\.000Z$/m);
  assert.match(text, /^asked\.dappName: plaza {3}# /m);
  assert.match(text, /^asked\.productIdentifier: plaza\.dot {3}# /m);
  assert.match(text, /^deployed\.dotName: plaza-social\.dot {3}# /m);
  // Unavailable renders as prose on the same line, never as a blank value.
  assert.match(text, /^host\.reportedProductIdentifier: unavailable — /m);

  // ⛔ No box-drawing characters: this gets pasted into a chat and must survive as plain text.
  assert.equal(/[─-╿]/.test(text), false);
});

test("COPY ALL carries every field the panel shows — the two cannot drift", () => {
  const sections = buildIdentityReport({
    snapshot: { ...emptySnapshot(), at: 1, connect: "ok" },
    environment: emptyEnvironment(),
    backendLabel: "Polkadot host container",
    capabilityAddress: null,
    capabilityInsideHost: true,
  });
  const text = formatIdentityReport(sections, { generatedAt: 0 });
  for (const section of sections) {
    assert.ok(text.includes(`== ${section.title}`), `section ${section.title} missing from the block`);
    for (const field of section.fields) {
      assert.ok(text.includes(`\n${field.key}: `), `field ${field.key} missing from the block`);
    }
  }
});

test("COPY ALL appends the diagnostics record when there is one", () => {
  const sections = buildIdentityReport({
    snapshot: null,
    environment: emptyEnvironment(),
    backendLabel: "x",
    capabilityAddress: null,
    capabilityInsideHost: false,
  });
  const withRecord = formatIdentityReport(sections, {
    generatedAt: 0,
    diagnostics: [
      { id: "container", status: "ok", detail: "identifier plaza-social.app.dev-dot.li" },
      { id: "connect", status: "fail", detail: "Wallet connect timed out after 20s" },
    ],
  });
  assert.match(withRecord, /^diag\.container: ok — identifier plaza-social\.app\.dev-dot\.li$/m);
  assert.match(withRecord, /^diag\.connect: fail — Wallet connect timed out after 20s$/m);

  // An empty record adds no SECTION — a "DIAGNOSTICS" heading over nothing reads as a broken panel.
  // (The word itself appears in a field's reason, which is why this checks the `==` header form.)
  const withoutRecord = formatIdentityReport(sections, { generatedAt: 0, diagnostics: [] });
  assert.equal(/^== DIAGNOSTICS/m.test(withoutRecord), false);
  assert.equal(/^diag\./m.test(withoutRecord), false);
});
