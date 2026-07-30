// READ-ONLY. The two facts a tipping feature cannot be built without, measured on live chains.
//
//   A. ADDRESSING — `payment.requestPayment(amount, destination)` takes a 32-BYTE account
//      (`S.Hex(32)` in @parity/truapi's generated codec, not a doc claim — grep
//      `HostPaymentRequest` in truapi/dist/generated/types.js). Plaza only ever holds H160s.
//      The ONLY sound H160 -> AccountId32 route is `Revive.OriginalAccount`, populated when an
//      account calls `map_account`. This probe measures how many REAL Plaza writers resolve
//      through it, and proves that the tempting alternative — `h160ToSs58()` — returns a
//      DIFFERENT account that nobody holds a key for.
//
//   B. DECIMALS — `Balance` is a bare u128 and the SDK names no asset and no exponent
//      ("Interpreted according to the host's single fixed payment asset (e.g. pUSD)").
//      A wrong exponent is a 10^12 error in a money field, so this enumerates every asset
//      registry it can reach and prints the DECLARED decimals, or says there are none.
//
// Everything here is a RAW storage read (`state_getKeysPaged` / `state_getStorage`) with local
// SCALE decoding, deliberately. yolodot's claims-audit records that the typed
// `@parity/product-sdk-descriptors` API is stale against the live spec and throws
// `Incompatible runtime entry Storage(Assets.Asset)`; raw metadata reads were the only path that
// worked. Nothing below can break that way.
//
// Run:  node contracts/scripts/probe-tipping.mjs
// Writes nothing, signs nothing, submits nothing.

import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/web";
import { Twox128 } from "@polkadot-api/substrate-bindings";
import { keccak_256 } from "@noble/hashes/sha3";
import { blake2b } from "@noble/hashes/blake2b";
import { base58 } from "@scure/base";

const ASSET_HUB = "wss://asset-hub-paseo-rpc.n.dwellir.com";
const PEOPLE = "wss://people-paseo.rotko.net";
const ETH = "https://paseo-assethub-rpc.laissez-faire.trade";

const USER_REGISTRY = "0xfD00289e765414C0281EFC35335b6453F055FBD7";
const POST_REGISTRY = "0xF6daC4BC4e721c5C84504A5Bfe033AE63722f8c9";

// keccak256("forum") / keccak256("feed") — mirrors frontend/src/lib/registry.ts. Recomputed rather
// than hardcoded so the two can never drift apart silently.
const te = new TextEncoder();
const hex = (u8) => "0x" + Buffer.from(u8).toString("hex");
const bytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const FORUM_REGISTRY = hex(keccak_256(te.encode("forum")));
const FEED_REGISTRY = hex(keccak_256(te.encode("feed")));

const prefixFor = (p, i) => hex(new Uint8Array([...Twox128(te.encode(p)), ...Twox128(te.encode(i))]));

/* ------------------------------------------------------------------ SCALE -- */

function compact(buf, off) {
  const b = buf[off], mode = b & 3;
  if (mode === 0) return [b >>> 2, off + 1];
  if (mode === 1) return [((buf[off] | (buf[off + 1] << 8)) >>> 2), off + 2];
  if (mode === 2) return [((buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | buf[off + 3] * 0x1000000) >>> 2), off + 4];
  const len = (b >>> 2) + 4;
  let v = 0n;
  for (let i = 0; i < len; i++) v |= BigInt(buf[off + 1 + i]) << BigInt(8 * i);
  return [Number(v), off + 1 + len];
}
function u128(buf, off) {
  let v = 0n;
  for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(buf[off + i]);
  return [v, off + 16];
}
function u32le(buf, off) {
  return [buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) + buf[off + 3] * 0x1000000, off + 4];
}
function vecU8(buf, off) {
  const [len, o] = compact(buf, off);
  return [buf.slice(o, o + len), o + len];
}

/** pallet-assets `AssetMetadata`: deposit u128, name Vec<u8>, symbol Vec<u8>, decimals u8, is_frozen bool. */
function decodeAssetMetadata(raw) {
  const b = bytes(raw);
  let o = 0, deposit, name, symbol;
  [deposit, o] = u128(b, o);
  [name, o] = vecU8(b, o);
  [symbol, o] = vecU8(b, o);
  const decimals = b[o];
  return {
    deposit,
    name: Buffer.from(name).toString("utf8"),
    symbol: Buffer.from(symbol).toString("utf8"),
    decimals,
    isFrozen: b[o + 1] === 1,
  };
}

/** pallet-assets `AssetDetails`: 4 x AccountId32, supply/deposit/minBalance u128, isSufficient, 3 x u32, status u8. */
function decodeAssetDetails(raw) {
  const b = bytes(raw);
  let o = 128, supply, deposit, minBalance;
  [supply, o] = u128(b, o);
  [deposit, o] = u128(b, o);
  [minBalance, o] = u128(b, o);
  const isSufficient = b[o] === 1;
  o += 1;
  let accounts, sufficients, approvals;
  [accounts, o] = u32le(b, o);
  [sufficients, o] = u32le(b, o);
  [approvals, o] = u32le(b, o);
  return {
    owner: hex(b.slice(0, 32)),
    issuer: hex(b.slice(32, 64)),
    supply, deposit, minBalance, isSufficient, accounts, sufficients, approvals,
    status: ["Live", "Frozen", "Destroying"][b[o]] ?? `?${b[o]}`,
  };
}

/* ----------------------------------------------------------------- ss58 --- */

function ss58Encode(pub, prefix) {
  const pre = prefix < 64
    ? Uint8Array.of(prefix)
    : Uint8Array.of(((prefix & 0xfc) >> 2) | 0x40, (prefix >> 8) | ((prefix & 3) << 6));
  const payload = new Uint8Array([...pre, ...pub]);
  const h = blake2b(new Uint8Array([...te.encode("SS58PRE"), ...payload]), { dkLen: 64 });
  return base58.encode(new Uint8Array([...payload, ...h.slice(0, 2)]));
}

/** The TRAP. What `h160ToSs58()` builds: the H160 right-padded with twelve 0xEE bytes. */
function fallbackAccount(h160) {
  return new Uint8Array([...bytes(h160), ...new Uint8Array(12).fill(0xee)]);
}

/* ------------------------------------------------------------------ eth --- */

async function ethBatch(calls) {
  if (!calls.length) return []; // an empty JSON-RPC batch is a protocol error, not an empty result
  const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: "eth_call", params: [c, "latest"] }));
  const r = await fetch(ETH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  const out = new Array(calls.length);
  for (const item of Array.isArray(j) ? j : [j]) out[item.id] = item.error ? null : item.result;
  return out;
}
const selector = (sig) => hex(keccak_256(te.encode(sig)).slice(0, 4));
const word = (n) => BigInt(n).toString(16).padStart(64, "0");

/**
 * Decode the `address[]` head of a return whose first slot is an offset.
 * `writersOf` returns `(address[] , uint256)`, so slot 0 is a pointer, not a length —
 * reading a length there is how this silently returned an empty list the first time.
 */
function decodeAddressArray(raw) {
  if (!raw || raw === "0x") return [];
  const b = bytes(raw);
  const off = Number(BigInt(hex(b.slice(0, 32))));
  const len = Number(BigInt(hex(b.slice(off, off + 32))));
  const out = [];
  for (let i = 0; i < len; i++) out.push(hex(b.slice(off + 32 + i * 32 + 12, off + 32 + (i + 1) * 32)));
  return out;
}

/* ---------------------------------------------------------------- probes -- */

async function enumerateAssets(rpc, label, at) {
  console.log(`\n--- ${label}: every asset registry entry, with DECLARED decimals ---`);
  for (const pallet of ["Assets", "ForeignAssets", "PoolAssets"]) {
    const pfx = prefixFor(pallet, "Metadata");
    let keys;
    try {
      keys = await rpc("state_getKeysPaged", [pfx, 200, null, at]);
    } catch (e) {
      console.log(`  ${pallet}.Metadata -> ${e.message}`);
      continue;
    }
    if (!keys?.length) {
      console.log(`  ${pallet}.Metadata -> no entries (pallet absent, or no metadata registered)`);
      continue;
    }
    console.log(`  ${pallet}.Metadata: ${keys.length} entr${keys.length === 1 ? "y" : "ies"}`);
    for (const k of keys) {
      const raw = await rpc("state_getStorage", [k, at]);
      // key tail after twox128x2 (64 hex) is blake2_128concat: 16 bytes hash + the raw id.
      const tail = k.slice(2 + 64);
      const idHex = tail.slice(32);
      let m;
      try { m = decodeAssetMetadata(raw); } catch (e) { console.log(`    key ${idHex} -> undecodable (${e.message})`); continue; }
      const idNum = idHex.length === 8 ? Number(BigInt("0x" + Buffer.from(idHex, "hex").reverse().toString("hex"))) : null;
      console.log(`    id=${idNum ?? "0x" + idHex}  symbol=${JSON.stringify(m.symbol)}  name=${JSON.stringify(m.name)}  DECIMALS=${m.decimals}  frozen=${m.isFrozen}`);
    }
  }
}

async function assetDetails(rpc, at, assetId) {
  const idLe = Buffer.alloc(4);
  idLe.writeUInt32LE(assetId);
  const k = prefixFor("Assets", "Asset") + Buffer.from(blake2b(idLe, { dkLen: 16 })).toString("hex") + idLe.toString("hex");
  const raw = await rpc("state_getStorage", [k, at]);
  if (!raw) return null;
  return decodeAssetDetails(raw);
}

async function assetMetadata(rpc, at, assetId) {
  const idLe = Buffer.alloc(4);
  idLe.writeUInt32LE(assetId);
  const k = prefixFor("Assets", "Metadata") + Buffer.from(blake2b(idLe, { dkLen: 16 })).toString("hex") + idLe.toString("hex");
  const raw = await rpc("state_getStorage", [k, at]);
  if (!raw) return null;
  return decodeAssetMetadata(raw);
}

async function main() {
  const ah = createClient(getWsProvider(ASSET_HUB));
  const ahRpc = (m, p = []) => ah._request(m, p);
  const at = await ahRpc("chain_getBlockHash", []);
  const props = await ahRpc("system_properties", []);

  console.log("=".repeat(78));
  console.log("PROBE: tipping preconditions — addressing and decimals");
  console.log("=".repeat(78));
  console.log("Asset Hub:", await ahRpc("system_chain", []), "spec:", (await ahRpc("state_getRuntimeVersion", [])).specVersion);
  console.log("at block:", at);
  console.log("system_properties (this is the NATIVE token, NOT the payment asset):", JSON.stringify(props));
  const ss58Format = props?.ss58Format ?? 0;

  /* ============================================ B — decimals ============== */
  console.log("\n" + "=".repeat(78));
  console.log("B. DECIMALS — what does one unit of the payment asset mean?");
  console.log("=".repeat(78));

  await enumerateAssets(ahRpc, "Asset Hub (Paseo)", at);

  // yolodot's cash.md asserts asset 50000413 = "People USD" / pUSD at 6 decimals, with NO cited
  // method and no script in that repo that ever queried it. Check it directly.
  console.log("\n--- the specific id yolodot's cash.md asserts (50000413), checked directly ---");
  const meta = await assetMetadata(ahRpc, at, 50000413);
  const det = await assetDetails(ahRpc, at, 50000413);
  console.log("  Assets.Metadata(50000413) =", meta ? JSON.stringify(meta, (k, v) => typeof v === "bigint" ? v.toString() : v) : "NULL — no name, no symbol, NO DECLARED DECIMALS");
  console.log("  Assets.Asset(50000413)    =", det ? JSON.stringify(det, (k, v) => typeof v === "bigint" ? v.toString() : v) : "NULL — asset does not exist on this chain");

  /* ============================================ A — addressing =========== */
  console.log("\n" + "=".repeat(78));
  console.log("A. ADDRESSING — can an H160 be resolved to the 32-byte account requestPayment wants?");
  console.log("=".repeat(78));

  const pfx = prefixFor("Revive", "OriginalAccount");
  const mapped = new Set();
  let start = null;
  for (;;) {
    const keys = await ahRpc("state_getKeysPaged", [pfx, 1000, start, at]);
    for (const k of keys) mapped.add("0x" + k.slice(2 + 64).toLowerCase()); // Identity hasher
    if (keys.length < 1000) break;
    start = keys[keys.length - 1];
  }
  console.log(`\nRevive.OriginalAccount holds ${mapped.size} entries chain-wide.`);
  console.log("(Contrast Revive/personhood's AccountToAlias, which is empty everywhere — this map is real.)");

  // The population that actually matters: people you could tip, i.e. Plaza writers.
  // ⚠️ `writersOf` is (bytes32, uint256 offset, uint256 limit) -> (address[], uint256).
  // Calling it with the registry id alone reverts, and a reverted eth_call decodes to an EMPTY
  // list rather than an error — which reads exactly like "nobody has ever posted".
  const writersCall = (id) => ({
    to: POST_REGISTRY,
    data: selector("writersOf(bytes32,uint256,uint256)") + id.slice(2) + word(0) + word(1000),
  });
  const [forumRaw, feedRaw] = await ethBatch([writersCall(FORUM_REGISTRY), writersCall(FEED_REGISTRY)]);
  const writers = [...new Set([...decodeAddressArray(forumRaw), ...decodeAddressArray(feedRaw)].map((a) => a.toLowerCase()))];
  console.log(`\nReal Plaza writers (PostRegistry.writersOf forum ∪ feed): ${writers.length}`);

  const hasProfile = await ethBatch(writers.map((a) => ({ to: USER_REGISTRY, data: selector("hasProfile(address)") + a.slice(2).padStart(64, "0") })));

  let resolvable = 0;
  for (let i = 0; i < writers.length; i++) {
    const a = writers[i];
    const isMapped = mapped.has(a);
    console.log(`\n  writer ${a}  hasProfile=${/1$/.test(hasProfile[i] ?? "") ? "yes" : "no"}  mapped=${isMapped ? "YES" : "NO"}`);
    if (!isMapped) {
      console.log("     -> requestPayment CANNOT address this person. Refuse the tip.");
      continue;
    }
    resolvable++;
    const raw = await ahRpc("state_getStorage", [pfx + a.slice(2), at]);
    const pub = bytes(raw).slice(0, 32);
    const derived = hex(keccak_256(pub).slice(12));
    console.log(`     OriginalAccount  = ${ss58Encode(pub, ss58Format)}`);
    console.log(`     as 32-byte hex   = ${hex(pub)}   <-- this is what requestPayment.destination takes`);
    console.log(`     keccak(pub)[12:] = ${derived}  ${derived === a ? "MATCH — the map is a true inverse here" : "NO MATCH"}`);
    const fb = fallbackAccount(a);
    console.log(`     h160ToSs58 would give ${ss58Encode(fb, ss58Format)}`);
    console.log(`     ...which is ${hex(fb) === hex(pub) ? "THE SAME (!)" : "A DIFFERENT ACCOUNT — tipping it destroys the funds"}`);
  }

  console.log("\n" + "-".repeat(78));
  console.log(`RESOLVABLE: ${resolvable} of ${writers.length} real Plaza writers can be paid via requestPayment.`);
  console.log("-".repeat(78));

  /* ====================== C — why the host API is the only path ========== */
  console.log("\n" + "=".repeat(78));
  console.log("C. Why ethers CANNOT move CASH — and why that is by design, not by omission");
  console.log("=".repeat(78));
  // ⚠️ `Revive.AutoMap` is a runtime CONSTANT, not a storage item. Reading it as storage returns
  // null, which looks exactly like "false" and is in fact "you asked the wrong question".
  try {
    const autoMap = await ah.getUnsafeApi().constants.Revive.AutoMap();
    console.log("Revive.AutoMap (runtime constant) =", autoMap,
      autoMap ? "— accounts are mapped AUTOMATICALLY; nobody has to call map_account" : "— mapping must be requested explicitly");
  } catch (e) {
    console.log("Revive.AutoMap -> could not read:", e.message);
  }

  // Every pallet-assets asset has an ERC-20 precompile at
  //   <assetId:u32 BE> ++ 0x00*12 ++ <prefix:u16> ++ 0x0000    (prefix 0x0120 = Assets)
  // The earlier claim that local assets have NO precompile was a wrong inference — they do.
  const precompile = (id) => "0x" + id.toString(16).padStart(8, "0") + "00".repeat(12) + "01200000";
  const s = (h) => (typeof h === "string" && h.length > 130
    ? Buffer.from(h.slice(130, 130 + parseInt(h.slice(66, 130), 16) * 2), "hex").toString("utf8")
    : null);

  for (const [id, note] of [[50000413, "pUSD / CASH"], [1337, "USDC — control"], [2000000000, "PGAS — control"]]) {
    const a = precompile(id);
    const [name, sym, dec, supply, bal] = await ethBatch([
      { to: a, data: selector("name()") },
      { to: a, data: selector("symbol()") },
      { to: a, data: selector("decimals()") },
      { to: a, data: selector("totalSupply()") },
      { to: a, data: selector("balanceOf(address)") + word(0) },
    ]);
    console.log(`\n  asset ${id} (${note}) -> precompile ${a}`);
    console.log(`     name=${JSON.stringify(s(name))} symbol=${JSON.stringify(s(sym))} DECIMALS=${typeof dec === "string" ? parseInt(dec, 16) : "reverted"}`);
    console.log(`     totalSupply=${typeof supply === "string" ? BigInt(supply) : "REVERTED"}  balanceOf(0)=${typeof bal === "string" ? BigInt(bal) : "REVERTED"}`);
  }
  console.log(`
  Read that carefully: for 50000413 the METADATA methods answer and every VALUE method reverts with
  "Protected asset access requires value-transfer authorization", while the two controls answer
  everything. CASH is the only protected asset of the 661 on this chain. So ethers cannot move it —
  by runtime policy, not because a precompile is missing. The host payment API is the only path.
  [?] What grants that authorization is unknown, and it is NOT the 'from' address. If a real
  requestPayment ever fails on chain, look here first rather than assuming our call is malformed.`);

  /* ============================================ People chain ============= */
  console.log("\n" + "=".repeat(78));
  console.log("People chain — the other place a payment asset could live");
  console.log("=".repeat(78));
  try {
    const pe = createClient(getWsProvider(PEOPLE));
    const peRpc = (m, p = []) => pe._request(m, p);
    const peAt = await peRpc("chain_getBlockHash", []);
    console.log("People:", await peRpc("system_chain", []));
    console.log("system_properties:", JSON.stringify(await peRpc("system_properties", [])));
    await enumerateAssets(peRpc, "People (Paseo)", peAt);
    pe.destroy();
  } catch (e) {
    console.log("People chain unreachable:", e.message);
  }

  ah.destroy();
}

// NOTE: no `import.meta.url === argv[1]` guard. On Windows that comparison is ALWAYS false and the
// script would exit 0 having done nothing.
await main();
process.exit(0);
