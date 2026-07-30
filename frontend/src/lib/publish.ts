// The two-signature write: sequencing and policy. Pure — no ethers, no ABI, no React, no I/O.
//
// Every piece of content in Plaza is published the same way, and it takes TWO different signers:
//
//   1. the BODY goes to Bulletin           — signed by the host (`putBlob`)
//   2. the POINTER goes to PostRegistry    — a contract call (`writeHead`)
//
// Nothing else in the app should know that. A hook says "publish this object into this registry" and
// this module owns the ordering, the `prev` link, the read-after-write wait and the failure text.
//
// ⚠️ THE CHAIN PLUMBING IS INJECTED, and that is not ceremony: it is the only way this file can be
// exercised at all. The write path runs inside a host container, which means it runs on a phone,
// which means every bug in it costs a deploy to see. `readHead`/`writeHead`/`putBlob` come in as
// functions so the ordering invariants below have tests. The ethers and ABI wiring lives one level
// up in `hooks/usePublisher.tsx`.
//
// ── ORDER IS LOAD-BEARING ──────────────────────────────────────────────────────────────────────
// Body first, pointer second, always. If the pointer write fails the body is an orphan on Bulletin:
// invisible, harmless, and gone within the retention window. The other order would move a head to a
// CID that no gateway can serve — a permanent hole in the chain that every later reader walks into.
//
// ── WHICH SIGNER MOVES THE POINTER ─────────────────────────────────────────────────────────────
// `setHead`, host-signed — NOT `setHeadFor` via the delegate. Both are real paths and the delegate
// one is the architecture's hot path (§5: one prompt at authorisation instead of one per post), but
// it needs a delegation that is authorised AND funded, and today it is neither: `authorizeDelegate`
// is not wired into the seam, and an unfunded delegate produced
// `code 1012 "Transaction is temporarily banned"` on a real device (2026-07-30).
//
// So there is exactly ONE write path here and it is the one that is known to work. When
// `authorizeDelegate` lands, the branch goes in `usePublisher`'s `writeHead` and nothing in this
// file changes — the delegate calls `setHeadFor(author, …)` and the head lands in the same row
// either way, because the contract credits the WRITER, never the signing key.
//
// ⚠️ Expect a signing prompt per post until then. That is honest: the prompt is the host asking the
// user to approve a transaction, and suppressing it is exactly what the delegate is for.

import type { BlobCache } from "./blob-cache.ts";
import { decodeObject, encodeObjectBytes, linkFrom, type ChainLink, type WireObject } from "./wire.ts";

export type PutBlob = (bytes: Uint8Array, options?: { contentType?: string }) => Promise<string>;

/** The head row, reduced to what publishing needs. Built from PostRegistry's `HeadRef`. */
export interface HeadRow {
  cid: string;
  prev: string | null;
  /** Epoch ms of the pointer move, or null. */
  at: number | null;
  by: string;
}

export interface WriteHeadArgs {
  registry: string;
  group: string;
  cid: string;
  prev: string;
  storeBlock: bigint;
}

export interface PublisherIO {
  /** The account content is credited to — the product account's H160. */
  author: string;
  /** This author's current head in a registry. Returns null when they hold none. Must not throw. */
  readHead: (registry: string) => Promise<HeadRow | null>;
  putBlob: PutBlob;
  writeHead: (args: WriteHeadArgs) => Promise<{ txHash: string }>;
  /** Injected for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PublishRequest {
  /** `bytes32` registry id — `keccak256(name)` for an open one. */
  registry: string;
  /**
   * Build the object once its chain link is known. Called with the resolved `prev`/`skips` so the
   * caller never has to think about the ladder.
   */
  build: (link: ChainLink) => WireObject;
  /**
   * Event routing key. A thread announcement sets this to its BOARD so one board subscription hears
   * the board's own chain and every reply on it. `bytes32(0)` means the registry itself.
   */
  group?: string;
  /** Seeded with the bytes we just wrote, and read from to recover the tip's skip ladder. */
  cache?: BlobCache | null;
  /** For diagnostics: "thread", "post", "message". */
  label?: string;
}

export interface PublishResult {
  cid: string;
  txHash: string;
  /** False when the head write landed but the read RPC had not caught up before we stopped waiting. */
  confirmed: boolean;
}

export interface Publisher {
  author: string;
  /** Store one Bulletin object on its own, outside any chain. Returns its CID. */
  store(object: WireObject, cache?: BlobCache | null): Promise<string>;
  /** This author's current tip in `registry`, as the link a new object should carry. */
  link(registry: string, cache?: BlobCache | null): Promise<ChainLink>;
  /** Body to Bulletin, then pointer to the contract, then wait for the read side to see it. */
  publish(request: PublishRequest): Promise<PublishResult>;
}

/** `bytes32(0)` — "route this event to the registry itself". */
export const NO_GROUP = `0x${"0".repeat(64)}`;

/**
 * How long to poll for our own write before giving up and refreshing anyway.
 *
 * ⚠️ POLLING IS THE CORRECT MECHANISM HERE, NOT A WORKAROUND. The host submits at best-block and we
 * read through a SEPARATE public RPC that trails it, so one immediate read returns the OLD head —
 * which is exactly how a created profile spent 30 seconds looking like it had failed. Events cannot
 * help: `eth_getLogs` cannot see host-submitted contract calls at all (architecture §8).
 */
export const CONFIRM_TIMEOUT_MS = 30_000;
export const CONFIRM_INTERVAL_MS = 1_500;

export const NO_WRITE_SESSION =
  "Posting has to be signed by your Polkadot account, and this session cannot reach it. Open Plaza " +
  "inside the Polkadot app and try again — reading works anywhere.";

/**
 * Build a publisher, or return null when this session cannot write.
 *
 * Null is the honest read-only state and every caller must handle it. It must never be a publisher
 * whose methods throw: a control that exists and always fails is worse than one that is not offered.
 */
export function createPublisher(io: Partial<PublisherIO>): Publisher | null {
  const { author, readHead, putBlob, writeHead } = io;
  if (!author || !readHead || !putBlob || !writeHead) return null;

  const now = io.now ?? (() => Date.now());
  const sleep = io.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  /** A read failure must never block a write — the worst case is a new branch, which readers merge. */
  const safeHead = async (registry: string): Promise<HeadRow | null> => {
    try {
      const head = await readHead(registry);
      return head?.cid ? head : null;
    } catch {
      return null;
    }
  };

  const store: Publisher["store"] = async (object, cache) => {
    const text = JSON.stringify(object);
    const cid = await putBlob(encodeObjectBytes(object), { contentType: "application/json" });
    // ⭐ NOT AN OPTIMISATION. A freshly stored CID takes MINUTES to reach public gateways, so
    // without this the user's own post renders as "(content no longer available)" for its first few
    // minutes — the worst first-run impression the app can make.
    cache?.put(cid, text);
    return cid;
  };

  const link: Publisher["link"] = async (registry, cache) => {
    const head = await safeHead(registry);
    if (!head) return linkFrom(null);

    // The skip ladder shifts forward for free, but only if we can see the tip's own ladder. When the
    // tip's body is unavailable we still know its `prev` from the chain, so the new object gets a
    // one-rung ladder instead of three. Degraded, never wrong.
    let skips: string[] = [];
    let at: number | null = null;
    try {
      const text = cache ? await cache.get(head.cid) : null;
      const decoded = text ? decodeObject(text) : null;
      if (decoded) {
        skips = decoded.skips;
        at = decoded.at;
      }
    } catch {
      /* the ladder is an optimisation; a chain with a short ladder still reads */
    }

    return linkFrom({ cid: head.cid, prev: head.prev, skips, author: head.by, at: at ?? head.at });
  };

  const waitForHead = async (registry: string, cid: string): Promise<boolean> => {
    const deadline = now() + CONFIRM_TIMEOUT_MS;
    for (;;) {
      const head = await safeHead(registry);
      if (head?.cid === cid) return true;
      if (now() >= deadline) return false;
      await sleep(CONFIRM_INTERVAL_MS);
    }
  };

  return {
    author,
    store,
    link,

    async publish({ registry, build, group, cache }) {
      const chainLink = await link(registry, cache);
      const object = build(chainLink);
      const cid = await store(object, cache);
      const { txHash } = await writeHead({
        registry,
        group: group ?? NO_GROUP,
        cid,
        prev: chainLink.prev ?? "",
        /**
         * `storeBlock` is 0 — "unknown", which the contract explicitly permits. It is the Bulletin
         * block of the store extrinsic, used only to compute the expiry deadline
         * `storeBlock + RetentionPeriod`, and the write path that actually works on a real host (the
         * preimage channel) returns no block receipt at all. A fabricated number would produce a
         * confidently wrong countdown; 0 produces no countdown, which is the truth. See §4a and the
         * open question in STATUS.md.
         */
        storeBlock: 0n,
      });
      const confirmed = await waitForHead(registry, cid);
      return { cid, txHash, confirmed };
    },
  };
}
