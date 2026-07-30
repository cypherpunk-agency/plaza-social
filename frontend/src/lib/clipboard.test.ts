import test from "node:test";
import assert from "node:assert/strict";

import { copyTextVerified, type ClipboardLike, type CopyDeps } from "./clipboard.ts";

const TEXT = "https://plaza-social.dot/?cid=bafkreiaaaa";

/** No DOM in `node --test`, so the synchronous fallback is always injected. */
const noExec: Pick<CopyDeps, "execCopy"> = { execCopy: () => false };
const readBackAllowed = { canReadBack: async () => true };
const readBackBlocked = { canReadBack: async () => false };

/** A clipboard that works. */
function realClipboard(): ClipboardLike {
  let held = "";
  return {
    writeText: async (t: string) => {
      held = t;
    },
    readText: async () => held,
  };
}

test("a verified write reports copied", async () => {
  const outcome = await copyTextVerified(TEXT, {
    clipboard: realClipboard(),
    ...readBackAllowed,
    ...noExec,
  });
  assert.equal(outcome, "copied");
});

test("a rejected write with no fallback reports failed", async () => {
  const clip: ClipboardLike = {
    writeText: async () => {
      throw new Error("NotAllowedError");
    },
  };
  assert.equal(
    await copyTextVerified(TEXT, { clipboard: clip, ...readBackAllowed, ...noExec }),
    "failed",
  );
});

test("a write that RESOLVES but does not take is caught as failed", async () => {
  // ⚠️ THE WHOLE POINT. Inside the host container a missing `Clipboard` device permission fails
  // silently — the promise resolves and nothing lands. An optimistic "Copied!" here is the failure
  // mode `gotchas.md` keeps billing us for.
  const clip: ClipboardLike = {
    writeText: async () => {},
    readText: async () => "something the user copied earlier",
  };
  assert.equal(
    await copyTextVerified(TEXT, { clipboard: clip, ...readBackAllowed, ...noExec }),
    "failed",
  );
});

test("no readback capability is unverified, never copied", async () => {
  const clip: ClipboardLike = { writeText: async () => {} };
  assert.equal(
    await copyTextVerified(TEXT, { clipboard: clip, ...readBackAllowed, ...noExec }),
    "unverified",
  );
});

test("readback is SKIPPED, not attempted, when it would prompt the user", async () => {
  // ⚠️ Calling `readText()` speculatively pops Chrome's paste-permission bubble, so a COPY button
  // would interrogate the user about pasting. `canReadBack: false` must mean "do not call it",
  // not "call it and see".
  let readCalls = 0;
  const clip: ClipboardLike = {
    writeText: async () => {},
    readText: async () => {
      readCalls++;
      return TEXT;
    },
  };
  const outcome = await copyTextVerified(TEXT, { clipboard: clip, ...readBackBlocked, ...noExec });
  assert.equal(outcome, "unverified");
  assert.equal(readCalls, 0);
});

test("a denied readback is unverified, because read is a separate grant from write", async () => {
  const clip: ClipboardLike = {
    writeText: async () => {},
    readText: async () => {
      throw new Error("NotAllowedError");
    },
  };
  assert.equal(
    await copyTextVerified(TEXT, { clipboard: clip, ...readBackAllowed, ...noExec }),
    "unverified",
  );
});

test("the synchronous fallback rescues a rejected async write", async () => {
  let execArg: string | null = null;
  const clip: ClipboardLike = {
    writeText: async () => {
      throw new Error("NotAllowedError");
    },
  };
  const outcome = await copyTextVerified(TEXT, {
    clipboard: clip,
    ...readBackAllowed,
    execCopy: (t) => {
      execArg = t;
      return true;
    },
  });
  assert.equal(outcome, "unverified");
  assert.equal(execArg, TEXT);
});

test("no clipboard at all falls through to the fallback, and fails if that fails too", async () => {
  assert.equal(
    await copyTextVerified(TEXT, { clipboard: null, ...readBackAllowed, ...noExec }),
    "failed",
  );
  assert.equal(
    await copyTextVerified(TEXT, {
      clipboard: null,
      ...readBackAllowed,
      execCopy: () => true,
    }),
    "unverified",
  );
});

test("the clipboard is compared byte for byte, not loosely", async () => {
  const clip: ClipboardLike = {
    writeText: async () => {},
    readText: async () => `${TEXT} `,
  };
  assert.equal(
    await copyTextVerified(TEXT, { clipboard: clip, ...readBackAllowed, ...noExec }),
    "failed",
  );
});
