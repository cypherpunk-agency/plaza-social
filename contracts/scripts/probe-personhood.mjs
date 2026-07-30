// Probe: can the personhood precompile ever return a NON-ZERO status, and under what context?
//
// STATUS.md open question #5. Every address we had tested returned 0, which left "the precompile
// works" and "the precompile always returns 0" indistinguishable — and a contract that gates writes
// on it would be un-diagnosable if the second were true.
//
//   node scripts/probe-personhood.mjs
//
// Read-only: `state_getMetadata` + storage reads on the Substrate RPC, anonymous `eth_call` on the
// ETH RPC. No keys, no extrinsics. Safe to re-run.
//
// ⚠️ The two RPCs are DISJOINT — eth_* only works on ETH_RPC, state_* only on SUBSTRATE_WS.

import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/web";

const SUBSTRATE_WS = process.env.SUBSTRATE_WS ?? "wss://asset-hub-paseo-rpc.n.dwellir.com";
/**
 * The devnet **Individuality / People** chain — where personhood actually lives. Found in
 * `@parity/*` (the SDK reaches it zero-config as `getChainAPI("devnet").individuality`); devnet runs
 * on the Paseo testnet system chains. `wss://paseo-people-next-system-rpc.polkadot.io` is the
 * Paseo-Next-v2 equivalent and carries the same pallet set.
 */
const PEOPLE_WS = process.env.PEOPLE_WS ?? "wss://people-paseo.rotko.net";
/** Sampled from PeopleLite.LitePeople. Only used to prove the read path returns a positive. */
const KNOWN_LITE_ACCOUNT = "5CiLV6SQPLCydU65LybzLpYcTwgYn9grXiTUoWkt46MSWc8P";
const ETH_RPC = process.env.ETH_RPC ?? "https://paseo-assethub-rpc.laissez-faire.trade";
const PRECOMPILE = "0x000000000000000000000000000000000a010000";
const SELECTOR = "0x886af133"; // keccak256("personhoodStatus(address,bytes32)")[0..4]

/**
 * The contexts are ASCII, space-padded to exactly 32 bytes, and they are NOT arbitrary: they are the
 * keys of `MembersSubscriber.RingCollectionStates` on chain. Passing bytes32(0) — which is what the
 * app did — names no ring at all.
 */
export const CONTEXT = Object.freeze({
  lite: "pop:polkadot.network/people-lite",
  full: "pop:polkadot.network/people     ",
});

const ctxHex = (s) => "0x" + Buffer.from(s, "utf8").toString("hex");
const pad = (hex) => String(hex ?? "").replace(/^0x/, "").toLowerCase().padStart(64, "0");
const hexOf = (v) =>
  v == null ? String(v) : typeof v.asHex === "function" ? v.asHex()
  : v instanceof Uint8Array ? "0x" + Buffer.from(v).toString("hex") : String(v);

async function rpc(method, params) {
  const res = await fetch(ETH_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

/** @returns {{status:number, contextAlias:string}|{error:string}} */
export async function readPersonhood(h160, context) {
  const payload = await rpc("eth_call", [
    { to: PRECOMPILE, data: SELECTOR + pad(h160) + pad(ctxHex(context)) },
    "latest",
  ]);
  if (payload.error) return { error: payload.error.message };
  const r = payload.result;
  if (typeof r !== "string" || r.length < 130) return { error: `short result ${r}` };
  return { status: Number.parseInt(r.slice(2, 66), 16), contextAlias: `0x${r.slice(66, 130)}` };
}

// Run whenever invoked directly. Deliberately not guarded on `import.meta.url === file://argv[1]`:
// on Windows that comparison is always false (`file:///D:/…` vs `file://D:/…`) and the script exits
// silently with status 0, which looks exactly like "the probe found nothing".
{
  const client = createClient(getWsProvider(SUBSTRATE_WS));
  try {
    const api = client.getUnsafeApi();

    // ── 1. What contexts does the chain actually know about? ────────────────────────────────────
    const states = await api.query.MembersSubscriber.RingCollectionStates.getEntries();
    console.log("MembersSubscriber.RingCollectionStates — the authoritative context list:");
    for (const e of states) {
      const raw = hexOf(e.keyArgs[0]);
      console.log(`  ${JSON.stringify(Buffer.from(raw.slice(2), "hex").toString("utf8"))}  rings=${e.value.ring_count}`);
    }

    // ── 2. Is anything bound to an alias on THIS chain? ─────────────────────────────────────────
    const a2a = await api.query.AliasAccounts.AccountToAlias.getEntries();
    const claimed = await api.query.Pgas.ClaimedGasAliases.getEntries();
    console.log(`\nAliasAccounts.AccountToAlias: ${a2a.length} entries`);
    console.log(`Pgas.ClaimedGasAliases:       ${claimed.length} entries (aliases that minted PGAS)`);

    // ── 3. Candidate addresses. Accounts with a revive mapping are the only ones an H160 can name. ─
    const mapped = await api.query.Revive.OriginalAccount.getEntries();
    const candidates = [
      ["our signer", "0x82A06d576eEDC077F3dE3Fe350767D9d068Ab345"],
      ...a2a.map((e, i) => [`alias-bound #${i}`, hexOf(e.keyArgs.at(-1)).slice(0, 42)]),
      ...mapped.slice(0, 12).map((e, i) => [`revive-mapped #${i}`, hexOf(e.keyArgs[0])]),
    ];
    console.log(`\nRevive.OriginalAccount: ${mapped.length} mapped accounts; probing ${candidates.length} addresses\n`);

    // ── 4. Probe every candidate against every context, plus the zero context for contrast. ─────
    const contexts = [["lite", CONTEXT.lite], ["full", CONTEXT.full], ["zero", "\0".repeat(32)]];
    let nonZero = 0;
    for (const [label, addr] of candidates) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) { console.log(`${label}: ${addr} (not an H160, skipped)`); continue; }
      const out = [];
      for (const [cname, ctx] of contexts) {
        const r = await readPersonhood(addr, ctx);
        if (r.error) out.push(`${cname}=ERR(${r.error})`);
        else {
          if (r.status !== 0) nonZero++;
          const alias = r.contextAlias === `0x${"00".repeat(32)}` ? "aliasØ" : r.contextAlias.slice(0, 14) + "…";
          out.push(`${cname}=${r.status}/${alias}`);
        }
      }
      console.log(`${addr}  ${out.join("  ")}   (${label})`);
    }

    console.log(`\n${nonZero} non-zero status result(s) from the Asset Hub precompile.`);
  } finally {
    client.destroy();
  }

  // ── 5. The People chain — where personhood ACTUALLY lives. ───────────────────────────────────
  //
  // Asset Hub has no personhood pallet, only a subscription to the People chain's member rings. The
  // precompile above answers a *contract's* question and needs an alias binding that nobody has made.
  // That is NOT the same as "personhood is unavailable": an APP can ask the People chain directly,
  // and for Lite personhood the answer is keyed by plain account address.
  const people = createClient(getWsProvider(PEOPLE_WS));
  try {
    const api = people.getUnsafeApi();
    const count = async (pallet, item) => {
      try { return (await api.query[pallet][item].getEntries()).length; } catch { return "ERR"; }
    };
    console.log(`\n##### People chain ${PEOPLE_WS}`);
    console.log(`  PeopleLite.LitePeople        ${await count("PeopleLite", "LitePeople")} entries   <- keyed by ACCOUNT, usable today`);
    console.log(`  People.People (full)         ${await count("People", "People")} entries   <- keyed by PERSONAL ID, not account`);
    console.log(`  People.AccountToPersonalId   ${await count("People", "AccountToPersonalId")} entries   <- no account->full-person lookup yet`);
    console.log(`  People.AccountToAlias        ${await count("People", "AccountToAlias")} entries`);
    console.log(`  PeopleLite.AccountToAlias    ${await count("PeopleLite", "AccountToAlias")} entries   <- what the precompile needs`);

    // Demonstrate the working read path both ways round.
    for (const [label, addr] of [
      ["a known lite person", KNOWN_LITE_ACCOUNT],
      ["Alice (control)", "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"],
    ]) {
      const v = await api.query.PeopleLite.LitePeople.getValue(addr);
      console.log(`  ${addr}  ${v ? `LITE PERSON (method=${v.method?.type})` : "not a lite person"}   (${label})`);
    }
    console.log(
      "\n  => An APP can gate on Lite personhood by account, today. A CONTRACT cannot, until somebody\n" +
      "     calls set_alias_account and AccountToAlias stops being empty.",
    );
  } finally {
    people.destroy();
  }
}
