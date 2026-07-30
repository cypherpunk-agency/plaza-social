// READ-ONLY probe: is there an on-chain H160 -> AccountId32 reverse lookup, and which derivation
// does THIS runtime use? Plus ground-truth against a real Plaza profile owner.
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/web";
import { keccak_256 } from "@noble/hashes/sha3";
import { blake2b } from "@noble/hashes/blake2b";
import { base58 } from "@scure/base";

const SUB = "wss://asset-hub-paseo-rpc.n.dwellir.com";
const ETH = "https://paseo-assethub-rpc.laissez-faire.trade";
const USER_REGISTRY = "0xfD00289e765414C0281EFC35335b6453F055FBD7";

async function eth(method, params = []) {
  const r = await fetch(ETH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(method + ": " + JSON.stringify(j.error));
  return j.result;
}
const hex = (u8) => "0x" + Buffer.from(u8).toString("hex");
const un = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));

function ss58Decode(addr) {
  const d = base58.decode(addr);
  // 1-byte prefix (<64) assumed
  return d.slice(1, 33);
}
function ss58Encode(pub, prefix = 42) {
  const body = new Uint8Array([prefix, ...pub]);
  const cs = blake2b(new Uint8Array([...Buffer.from("SS58PRE"), ...body]), { dkLen: 64 }).slice(0, 2);
  return base58.encode(new Uint8Array([...body, ...cs]));
}

const sub = createClient(getWsProvider(SUB));
const api = sub.getUnsafeApi();

async function main() {
  console.log("=== Revive.OriginalAccount (H160 -> AccountId32) ===");
  const entries = await api.query.Revive.OriginalAccount.getEntries();
  console.log("entry count =", entries.length);
  for (const e of entries.slice(0, 10)) {
    const h160 = typeof e.keyArgs[0] === "string" ? e.keyArgs[0] : hex(e.keyArgs[0].asBytes ? e.keyArgs[0].asBytes() : e.keyArgs[0]);
    const acct = e.value;
    console.log("  ", h160, "->", acct);
    // test derivations
    try {
      const pub = ss58Decode(acct);
      const kec = hex(keccak_256(pub).slice(12));
      const first20 = hex(pub.slice(0, 20));
      const isEeSuffix = pub.slice(20).every((b) => b === 0xee);
      console.log("      pub =", hex(pub));
      console.log("      keccak256(pub)[12..] =", kec, kec.toLowerCase() === h160.toLowerCase() ? "  <== MATCH" : "");
      console.log("      pub[0..20]           =", first20, first20.toLowerCase() === h160.toLowerCase() ? "  <== MATCH" : "");
      console.log("      0xEE-padded?         =", isEeSuffix);
    } catch (err) { console.log("      ss58 decode failed:", err.message); }
  }

  console.log("\n=== Revive.AccountInfoOf (H160 -> account_type) ===");
  const ai = await api.query.Revive.AccountInfoOf.getEntries();
  console.log("entry count =", ai.length);
  const byType = {};
  for (const e of ai) { const t = e.value.account_type?.type ?? String(e.value.account_type); byType[t] = (byType[t] || 0) + 1; }
  console.log("by type:", JSON.stringify(byType));

  console.log("\n=== Ground truth: real Plaza profile owners (UserRegistry ProfileCreated logs) ===");
  const topic = hex(keccak_256(Buffer.from("ProfileCreated(address)")));
  console.log("ProfileCreated topic0 =", topic);
  let logs = [];
  try {
    logs = await eth("eth_getLogs", [{ address: USER_REGISTRY, topics: [topic], fromBlock: "0x0", toBlock: "latest" }]);
  } catch (e) {
    console.log("full-range eth_getLogs failed:", e.message, "- retrying narrow window");
    const head = parseInt(await eth("eth_blockNumber"), 16);
    for (let from = head - 200000; from < head; from += 10000) {
      try {
        const l = await eth("eth_getLogs", [{ address: USER_REGISTRY, topics: [topic], fromBlock: "0x" + from.toString(16), toBlock: "0x" + Math.min(from + 9999, head).toString(16) }]);
        logs.push(...l);
      } catch {}
    }
  }
  console.log("ProfileCreated log count =", logs.length);
  const owners = [...new Set(logs.map((l) => "0x" + l.topics[1].slice(26)))];
  console.log("distinct owners:", owners);

  for (const o of owners) {
    const orig = await api.query.Revive.OriginalAccount.getValue(o);
    const info = await api.query.Revive.AccountInfoOf.getValue(o);
    const bytes = un(o);
    console.log(`\n  owner ${o}`);
    console.log(`    Revive.OriginalAccount   = ${orig ?? "(none)"}`);
    console.log(`    Revive.AccountInfoOf     = ${JSON.stringify(info, (k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    // If EVM-derived, the AccountId32 is h160 ++ [0xEE;12]
    const eePadded = new Uint8Array([...bytes, ...new Uint8Array(12).fill(0xee)]);
    console.log(`    h160 ++ 0xEE*12 (ss58)   = ${ss58Encode(eePadded)}`);
    const bal = await api.query.System.Account.getValue(ss58Encode(eePadded));
    console.log(`    System.Account of that   = free ${bal?.data?.free} nonce ${bal?.nonce}`);
    if (orig) {
      const pub = ss58Decode(orig);
      console.log(`    orig pub                 = ${hex(pub)}`);
      console.log(`    keccak256(pub)[12..]     = ${hex(keccak_256(pub).slice(12))}`);
      console.log(`    pub[0..20]               = ${hex(pub.slice(0, 20))}`);
    }
  }
}

await main();
sub.destroy();
process.exit(0);
