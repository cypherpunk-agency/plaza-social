// READ-ONLY probe: ground truth for H160 -> AccountId32 on real Plaza profile owners.
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/web";
import { keccak_256 } from "@noble/hashes/sha3";
import { blake2b } from "@noble/hashes/blake2b";
import { base58 } from "@scure/base";
import { Twox128 } from "@polkadot-api/substrate-bindings";

const SUB = "wss://asset-hub-paseo-rpc.n.dwellir.com";
const ETH = "https://paseo-assethub-rpc.laissez-faire.trade";
const USER_REGISTRY = "0xfD00289e765414C0281EFC35335b6453F055FBD7";
const POST_REGISTRY = "0xF6daC4BC4e721c5C84504A5Bfe033AE63722f8c9";

async function eth(method, params = []) {
  const r = await fetch(ETH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(method + ": " + JSON.stringify(j.error));
  return j.result;
}
const hex = (u8) => "0x" + Buffer.from(u8).toString("hex");
const un = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const ss58Decode = (a) => base58.decode(a).slice(1, 33);
function ss58Encode(pub, prefix = 42) {
  const body = new Uint8Array([prefix, ...pub]);
  const cs = blake2b(new Uint8Array([...Buffer.from("SS58PRE"), ...body]), { dkLen: 64 }).slice(0, 2);
  return base58.encode(new Uint8Array([...body, ...cs]));
}

const sub = createClient(getWsProvider(SUB));
const api = sub.getUnsafeApi();
const rpc = (m, p = []) => sub._request(m, p);

// twox128("Revive") ++ twox128("OriginalAccount"), then Identity(h160)
const prefixFor = (pallet, item) => hex(new Uint8Array([...Twox128(new TextEncoder().encode(pallet)), ...Twox128(new TextEncoder().encode(item))]));

async function countKeys(pallet, item, at) {
  const pfx = prefixFor(pallet, item);
  let total = 0, start = null;
  for (;;) {
    const keys = await rpc("state_getKeysPaged", [pfx, 1000, start, at]);
    total += keys.length;
    if (keys.length < 1000) break;
    start = keys[keys.length - 1];
    if (total > 200000) { console.log("   (capped at 200k)"); break; }
  }
  return total;
}

async function main() {
  const at = await rpc("chain_getBlockHash", []);
  console.log("at block", at);

  for (const [p, i] of [["Revive", "OriginalAccount"], ["Revive", "AccountInfoOf"], ["Revive", "CodeInfoOf"]]) {
    console.log(`${p}.${i} storage prefix ${prefixFor(p, i)}  entries = ${await countKeys(p, i, at)}`);
  }

  console.log("\n=== ProfileCreated logs on UserRegistry ===");
  const topic = hex(keccak_256(Buffer.from("ProfileCreated(address)")));
  console.log("topic0 =", topic);
  const head = parseInt(await eth("eth_blockNumber"), 16);
  let logs = [];
  try {
    logs = await eth("eth_getLogs", [{ address: USER_REGISTRY, topics: [topic], fromBlock: "0x0", toBlock: "latest" }]);
    console.log("full-range eth_getLogs OK");
  } catch (e) {
    console.log("full-range failed:", e.message);
    for (let from = head - 100000; from < head; from += 5000) {
      try {
        logs.push(...(await eth("eth_getLogs", [{ address: USER_REGISTRY, topics: [topic], fromBlock: "0x" + from.toString(16), toBlock: "0x" + Math.min(from + 4999, head).toString(16) }])));
      } catch (e2) { /* ignore */ }
    }
  }
  console.log("log count =", logs.length);
  const owners = [...new Set(logs.map((l) => "0x" + l.topics[1].slice(26)))];
  console.log("distinct owners:", JSON.stringify(owners));
  for (const l of logs.slice(0, 10)) console.log("   block", parseInt(l.blockNumber, 16), "tx", l.transactionHash, "owner 0x" + l.topics[1].slice(26));

  for (const o of owners) {
    console.log(`\n---- owner ${o}`);
    const orig = await api.query.Revive.OriginalAccount.getValue(o);
    const info = await api.query.Revive.AccountInfoOf.getValue(o);
    console.log("   Revive.OriginalAccount =", orig ?? "(NONE)");
    console.log("   Revive.AccountInfoOf   =", JSON.stringify(info, (k, v) => (typeof v === "bigint" ? v.toString() : v)));
    const bytes = un(o);
    const isEE = false;
    const eePad = new Uint8Array([...bytes, ...new Uint8Array(12).fill(0xee)]);
    console.log("   fallback h160++0xEE*12 =", ss58Encode(eePad));
    if (orig) {
      const pub = ss58Decode(orig);
      console.log("   orig pub               =", hex(pub));
      console.log("   keccak256(pub)[12..]   =", hex(keccak_256(pub).slice(12)), hex(keccak_256(pub).slice(12)) === o.toLowerCase() ? "MATCH" : "NO");
      console.log("   pub[0..20]             =", hex(pub.slice(0, 20)), hex(pub.slice(0, 20)) === o.toLowerCase() ? "MATCH" : "NO");
      console.log("   pub[20..32] all 0xEE?  =", pub.slice(20).every((b) => b === 0xee));
    }
    // profile content
    const sel = hex(keccak_256(Buffer.from("hasProfile(address)")).slice(0, 4));
    const res = await eth("eth_call", [{ to: USER_REGISTRY, data: sel + o.slice(2).padStart(64, "0") }, "latest"]);
    console.log("   hasProfile()           =", res);
  }
}

await main();
sub.destroy();
process.exit(0);
