// READ-ONLY: enumerate every H160 in Revive.OriginalAccount and ask UserRegistry.hasProfile() for it.
// Ground truth for "is a real Plaza profile owner reverse-resolvable to an AccountId32?"
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

const hex = (u8) => "0x" + Buffer.from(u8).toString("hex");
const te = new TextEncoder();
const prefixFor = (p, i) => hex(new Uint8Array([...Twox128(te.encode(p)), ...Twox128(te.encode(i))]));
const ss58Decode = (a) => base58.decode(a).slice(1, 33);

async function ethBatch(calls) {
  const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c.method, params: c.params }));
  const r = await fetch(ETH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  const out = new Array(calls.length);
  for (const item of j) out[item.id] = item.error ? { error: item.error } : item.result;
  return out;
}

const sub = createClient(getWsProvider(SUB));
const api = sub.getUnsafeApi();
const rpc = (m, p = []) => sub._request(m, p);

async function main() {
  const at = await rpc("chain_getBlockHash", []);
  const pfx = prefixFor("Revive", "OriginalAccount");
  const h160s = [];
  let start = null;
  for (;;) {
    const keys = await rpc("state_getKeysPaged", [pfx, 1000, start, at]);
    for (const k of keys) h160s.push("0x" + k.slice(2 + 64)); // 32-byte prefix, Identity hasher
    if (keys.length < 1000) break;
    start = keys[keys.length - 1];
  }
  console.log("Revive.OriginalAccount H160 count =", h160s.length);
  console.log("sample keys:", h160s.slice(0, 3));

  const selHasProfile = hex(keccak_256(te.encode("hasProfile(address)")).slice(0, 4));
  const found = [];
  for (let i = 0; i < h160s.length; i += 200) {
    const chunk = h160s.slice(i, i + 200);
    const res = await ethBatch(chunk.map((a) => ({ method: "eth_call", params: [{ to: USER_REGISTRY, data: selHasProfile + a.slice(2).padStart(64, "0") }, "latest"] })));
    res.forEach((r, k) => { if (typeof r === "string" && /1$/.test(r)) found.push(chunk[k]); });
    process.stdout.write(`\r  scanned ${Math.min(i + 200, h160s.length)}/${h160s.length}  hits=${found.length}`);
  }
  console.log("\nH160s in OriginalAccount that HAVE a Plaza profile:", JSON.stringify(found));

  for (const o of found) {
    const acct = await api.query.Revive.OriginalAccount.getValue(o);
    const pub = ss58Decode(acct);
    console.log(`\n  ${o}`);
    console.log(`     OriginalAccount     = ${acct}`);
    console.log(`     pub                 = ${hex(pub)}`);
    console.log(`     keccak256(pub)[12:] = ${hex(keccak_256(pub).slice(12))}  ${hex(keccak_256(pub).slice(12)) === o ? "MATCH" : "NO MATCH"}`);
    console.log(`     pub[0:20]           = ${hex(pub.slice(0, 20))}  ${hex(pub.slice(0, 20)) === o ? "MATCH" : "NO MATCH"}`);
    console.log(`     pub[20:32]==0xEE*12 = ${pub.slice(20).every((b) => b === 0xee)}`);
    const info = await api.query.Revive.AccountInfoOf.getValue(o);
    console.log(`     AccountInfoOf       = ${JSON.stringify(info, (k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    // profiles(address) -> (address owner, string name, string bio, bool exists)
    const sel = hex(keccak_256(te.encode("profiles(address)")).slice(0, 4));
    const r = await ethBatch([{ method: "eth_call", params: [{ to: USER_REGISTRY, data: sel + o.slice(2).padStart(64, "0") }, "latest"] }]);
    console.log(`     profiles() raw      = ${typeof r[0] === "string" ? r[0].slice(0, 200) : JSON.stringify(r[0])}`);
  }

  // Also: how many of those H160s are writers in PostRegistry FEED? (skip - needs registry id)
}

await main();
sub.destroy();
process.exit(0);
