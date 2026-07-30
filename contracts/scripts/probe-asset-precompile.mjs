// READ-ONLY: is there an EVM precompile address that exposes pallet-assets asset 50000413 (pUSD)
// as an ERC-20 on the Products devnet ETH RPC? Purely eth_call probing, no state changes.
const ETH = "https://paseo-assethub-rpc.laissez-faire.trade";
import { keccak_256 } from "@noble/hashes/sha3";
const te = new TextEncoder();
const sel = (sig) => "0x" + Buffer.from(keccak_256(te.encode(sig)).slice(0, 4)).toString("hex");

const SEL_DECIMALS = sel("decimals()");
const SEL_SYMBOL = sel("symbol()");
const SEL_TOTALSUPPLY = sel("totalSupply()");
const SEL_PERSONHOOD = "0x886af133";

async function batch(reqs) {
  const r = await fetch(ETH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(reqs.map((x, i) => ({ jsonrpc: "2.0", id: i, ...x }))) });
  const j = await r.json();
  const out = new Array(reqs.length);
  for (const it of j) out[it.id] = it.error ? { err: it.error.message ?? JSON.stringify(it.error), data: it.error.data } : it.result;
  return out;
}
const call = (to, data) => ({ method: "eth_call", params: [{ to, data }, "latest"] });
const addr = (bytes) => "0x" + Buffer.from(bytes).toString("hex");

function addrFromParts(prefixHexAtByte16 /* u16 */, tail /* u16 */) {
  const b = new Uint8Array(20);
  b[16] = prefixHexAtByte16 >> 8; b[17] = prefixHexAtByte16 & 0xff;
  b[18] = tail >> 8; b[19] = tail & 0xff;
  return addr(b);
}
function addrIdAtTail4(prefix16, id32) {
  const b = new Uint8Array(20);
  b[14] = prefix16 >> 8; b[15] = prefix16 & 0xff;
  b[16] = (id32 >>> 24) & 0xff; b[17] = (id32 >>> 16) & 0xff; b[18] = (id32 >>> 8) & 0xff; b[19] = id32 & 0xff;
  return addr(b);
}

console.log("selectors: decimals", SEL_DECIMALS, "symbol", SEL_SYMBOL, "totalSupply", SEL_TOTALSUPPLY);

// -------- 0. sanity: does the known personhood precompile behave differently from a dead address?
const PERSONHOOD = "0x000000000000000000000000000000000a010000";
const DEAD = "0x00000000000000000000000000000000dead0000";
const s0 = await batch([
  call(PERSONHOOD, SEL_PERSONHOOD + "0".repeat(64) + "0".repeat(64)),
  call(PERSONHOOD, SEL_DECIMALS),
  call(DEAD, SEL_DECIMALS),
  { method: "eth_getCode", params: [PERSONHOOD, "latest"] },
  { method: "eth_getCode", params: [DEAD, "latest"] },
]);
console.log("\n-- sanity");
console.log("personhood personhoodStatus():", JSON.stringify(s0[0]));
console.log("personhood decimals()        :", JSON.stringify(s0[1]));
console.log("dead      decimals()         :", JSON.stringify(s0[2]));
console.log("eth_getCode(personhood)      :", JSON.stringify(s0[3]));
console.log("eth_getCode(dead)            :", JSON.stringify(s0[4]));

const isDeadLike = (r) => JSON.stringify(r) === JSON.stringify(s0[2]);

// -------- 1. enumerate FIXED precompiles: 0x00*16 || p:u16 || 0x0000, p = 1..0x1fff
console.log("\n-- scan A: 0x00*16 || p:u16 || 0x0000  (p = 1..0x1fff), calling decimals()");
const hitsA = [];
for (let p = 1; p <= 0x1fff; p += 256) {
  const ps = [];
  for (let q = p; q < Math.min(p + 256, 0x2000); q++) ps.push(q);
  const res = await batch(ps.map((q) => call(addrFromParts(q, 0), SEL_DECIMALS)));
  res.forEach((r, k) => { if (!isDeadLike(r)) hitsA.push([addrFromParts(ps[k], 0), JSON.stringify(r).slice(0, 160)]); });
}
console.log("distinct-from-dead results:", hitsA.length);
for (const h of hitsA.slice(0, 60)) console.log("   ", h[0], h[1]);

// -------- 2. scan for asset id in the low 4 bytes: 0x00*14 || p:u16 || assetId:u32
console.log("\n-- scan B: 0x00*14 || p:u16 || assetId:u32, assetId = 50000413 (pUSD, 6 decimals), p = 0..0x1fff");
const hitsB = [];
for (let p = 0; p <= 0x1fff; p += 256) {
  const ps = []; for (let q = p; q < Math.min(p + 256, 0x2000); q++) ps.push(q);
  const res = await batch(ps.map((q) => call(addrIdAtTail4(q, 50000413), SEL_DECIMALS)));
  res.forEach((r, k) => { if (!isDeadLike(r)) hitsB.push([addrIdAtTail4(ps[k], 50000413), JSON.stringify(r).slice(0, 160)]); });
}
console.log("distinct-from-dead results:", hitsB.length);
for (const h of hitsB.slice(0, 60)) console.log("   ", h[0], h[1]);

// -------- 3. prefix family with small tail index (foreign-asset style): 0x00*16 || p:u16 || idx:u16
console.log("\n-- scan C: 0x00*16 || p:u16 || idx:u16 for idx = 1, p = 1..0x1fff");
const hitsC = [];
for (let p = 1; p <= 0x1fff; p += 256) {
  const ps = []; for (let q = p; q < Math.min(p + 256, 0x2000); q++) ps.push(q);
  const res = await batch(ps.map((q) => call(addrFromParts(q, 1), SEL_DECIMALS)));
  res.forEach((r, k) => { if (!isDeadLike(r)) hitsC.push([addrFromParts(ps[k], 1), JSON.stringify(r).slice(0, 160)]); });
}
console.log("distinct-from-dead results:", hitsC.length);
for (const h of hitsC.slice(0, 60)) console.log("   ", h[0], h[1]);

// -------- 4. explicit well-known candidates
console.log("\n-- scan D: named candidates");
const cands = {
  "ERC20 assets prefix 0x0120 + id16 (USDC 1337)": addrFromParts(0x0120, 1337),
  "ERC20 assets prefix 0x0120 + id16 (idx 1)": addrFromParts(0x0120, 1),
  "0x0800 + 1337": addrFromParts(0x0800, 1337),
  "u32 id at tail, no prefix": addrIdAtTail4(0, 50000413),
  "u32 id 1337 at tail, no prefix": addrIdAtTail4(0, 1337),
  "0xFFFFFFFF...+id (moonbeam style)": "0xffffffff" + "00000000000000000000000002fac09d".padStart(32, "0"),
};
const dres = await batch(Object.values(cands).map((a) => call(a, SEL_DECIMALS)));
Object.keys(cands).forEach((k, i) => console.log(`   ${k.padEnd(46)} ${cands[k]} -> ${JSON.stringify(dres[i]).slice(0, 140)}`));

process.exit(0);
