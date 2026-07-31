// Probe: WHICH surface owns which product account, and what does each one hold?
//
// Written 2026-07-31 after the user reported two DIFFERENT addresses for what they consider one
// identity, and after it emerged that this repo had attributed `0x18773c30…4ef9` to the *phone*
// when it is in fact the *browser*:
//
//   phone   (native Polkadot app)          0xda46…712e   (truncated in the report)
//   desktop (browser tab paired by QR)     0x18773c30d65de35027ac8cd19e98c0ddb9c44ef9
//
//   node scripts/probe-surface-accounts.mjs
//   node scripts/probe-surface-accounts.mjs --h160 0xda46...712e   # once the full value is known
//
// Read-only: `eth_call`/`eth_getBalance` on the ETH RPC, storage reads on Asset Hub and on the
// Individuality/People chain. No keys, no extrinsics, safe to re-run.
//
// WHAT IT DOES
//
// 1. RECOVERS A TRUNCATED H160, two ways, both of them FORWARD.
//    (a) `Revive.OriginalAccount` is keyed by H160, so enumerating its keys gives every
//        revive-*mapped* address on the chain; scan those keys for a prefix/suffix match.
//    (b) Every account that holds a balance anywhere is an AccountId32 we can enumerate, and
//        `product-sdk-address.deriveH160` turns an AccountId32 into its H160 by
//        `keccak256(publicKey)[12..32]`. Computing that for every known account and comparing is a
//        *forward* check — a lookup in a known set, never an inversion.
//
// 2. PROFILES EACH ACCOUNT. For every address of interest: the AccountId32 it maps back to, its
//    `UserRegistry` profile, its `PostRegistry` head in each known registry, its native balance,
//    and whether the mapped AccountId32 is a `PeopleLite.LitePeople` entry.
//
// 3. READS THE LIVE BROWSER HOST and prints, verbatim, the five functions that decide which
//    `productId` junction the derivation uses. This is the section that answers "why do the two
//    surfaces differ": the browser host DISCARDS the identifier the product asks for and
//    substitutes the one it actually loaded. Re-fetched every run — never trust a stale hash.
//
// ⛔ NEVER derive an AccountId32 from an H160. `Revive.OriginalAccount` is the ONLY sound reverse
//    route. `h160ToSs58()` yields a *different*, real, unrelated account; tipping it destroys funds.
//
// ⛔ AND NEVER TRY TO DERIVE A PRODUCT ACCOUNT OURSELVES. A product never sees the root — that is
//    the whole cross-product isolation property. The host holds the root, derives per product, and
//    returns only the resulting public key. Any plan that starts "given the user's root key…" is
//    asking for something the platform is built to withhold, and it is right to withhold it.

import { createClient, Binary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/web";

const ETH_RPC = process.env.ETH_RPC ?? "https://paseo-assethub-rpc.laissez-faire.trade";
const ASSET_HUB_WS = process.env.SUBSTRATE_WS ?? "wss://asset-hub-paseo-rpc.n.dwellir.com";
const PEOPLE_WS = process.env.PEOPLE_WS ?? "wss://people-paseo.rotko.net";

const USER_REGISTRY = "0xfD00289e765414C0281EFC35335b6453F055FBD7";
const POST_REGISTRY = "0xF6daC4BC4e721c5C84504A5Bfe033AE63722f8c9";
const FOLLOW_REGISTRY = "0x96A3274Fa3696bbF5F8e1D8B58455300B9b7032E";

/** The desktop/browser account this repo has recorded throughout. */
const BROWSER_H160 = "0x18773c30d65de35027ac8cd19e98c0ddb9c44ef9";
/** The phone account, as truncated in the user's report of 2026-07-31. */
const PHONE_PREFIX = "0xda46";
const PHONE_SUFFIX = "712e";

const { keccak_256 } = await import(
  new URL("../../frontend/node_modules/@noble/hashes/sha3.js", import.meta.url).href
);
// The SDK's own AccountId32 → H160 rule, imported rather than re-implemented so the two cannot drift.
const sdkAddress = await import(
  new URL("../../frontend/node_modules/@parity/product-sdk-address/dist/index.js", import.meta.url).href
);
const hex = (b) => "0x" + Buffer.from(b).toString("hex");
const kec = (s) => hex(keccak_256(new TextEncoder().encode(s)));
const sel = (sig) => kec(sig).slice(2, 10);
const n32 = (n) => BigInt(n).toString(16).padStart(64, "0");
const addr32 = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

async function rpc(method, params) {
  const res = await fetch(ETH_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}
const ethCall = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);

/** Decode a solidity `string` out of an abi-encoded return blob (hex, no 0x), given its head slot. */
function decodeString(r, headSlot) {
  const off = Number.parseInt(r.slice(headSlot * 64, (headSlot + 1) * 64), 16) * 2;
  const len = Number.parseInt(r.slice(off, off + 64), 16);
  if (!len) return "";
  return Buffer.from(r.slice(off + 64, off + 64 + len * 2), "hex").toString("utf8");
}

/** The registries Plaza actually uses. `thread:` ids are per-post and cannot be enumerated blind. */
const REGISTRIES = { forum: kec("forum"), feed: kec("feed") };

async function profileOf(h160) {
  const out = {};

  const has = await ethCall(USER_REGISTRY, `0x${sel("hasProfile(address)")}${addr32(h160)}`);
  out.hasProfile = has.result ? BigInt(has.result) === 1n : `error: ${has.error?.message}`;

  if (out.hasProfile === true) {
    // getProfile(address) → Profile{ address owner, string displayName, string bio, bool exists },
    // i.e. one tuple behind one offset word.
    const p = await ethCall(
      USER_REGISTRY,
      `0x${sel("getProfile(address)")}${addr32(h160)}`,
    );
    if (p.result) {
      const r = p.result.slice(2);
      const body = r.slice(Number.parseInt(r.slice(0, 64), 16) * 2);
      out.owner = "0x" + body.slice(24, 64);
      out.displayName = decodeString(body, 1);
      out.bio = decodeString(body, 2);
    }
  }

  out.heads = {};
  for (const [name, id] of Object.entries(REGISTRIES)) {
    // headOf(bytes32,address) → HeadRef{ cid string, prev string, group bytes32, storeBlock uint64,
    //                                    updatedAt uint64, allowed bool } — layout varies; we only
    // need "is there a cid at all", so read the first dynamic string.
    const h = await ethCall(POST_REGISTRY, `0x${sel("headOf(bytes32,address)")}${id.slice(2)}${addr32(h160)}`);
    if (h.error) { out.heads[name] = `error: ${h.error.message}`; continue; }
    const r = h.result.slice(2);
    // The struct is returned behind one offset word.
    const base = Number.parseInt(r.slice(0, 64), 16) * 2;
    const body = r.slice(base);
    const cid = decodeString(body, 0);
    out.heads[name] = cid || "(none)";
  }

  const fc = await ethCall(FOLLOW_REGISTRY, `0x${sel("getFollowingCount(address)")}${addr32(h160)}`);
  const fr = await ethCall(FOLLOW_REGISTRY, `0x${sel("getFollowerCount(address)")}${addr32(h160)}`);
  out.following = fc.result ? Number(BigInt(fc.result)) : `error: ${fc.error?.message}`;
  out.followers = fr.result ? Number(BigInt(fr.result)) : `error: ${fr.error?.message}`;

  const bal = await rpc("eth_getBalance", [h160, "latest"]);
  out.balance = bal.result ? `${(Number(BigInt(bal.result)) / 1e18).toFixed(6)} PAS` : `error: ${bal.error?.message}`;

  return out;
}

// ── connect ──────────────────────────────────────────────────────────────────────────────────────
const ah = createClient(getWsProvider(ASSET_HUB_WS));
const ahApi = ah.getUnsafeApi();
const people = createClient(getWsProvider(PEOPLE_WS));
const pApi = people.getUnsafeApi();

// ── 1. Recover the truncated phone H160 ──────────────────────────────────────────────────────────
console.log("═══ 1. RECOVER THE TRUNCATED PHONE H160 ═══\n");
console.log(`  looking for an H160 starting ${PHONE_PREFIX} and ending ${PHONE_SUFFIX}`);
console.log("  source: keys of Revive.OriginalAccount (every revive-mapped address on this chain)\n");

const originals = await ahApi.query.Revive.OriginalAccount.getEntries();
console.log(`  Revive.OriginalAccount: ${originals.length} mapped H160s`);

const keyHex = (e) => {
  const k = e.keyArgs[0];
  const s = typeof k === "string" ? k : k.asHex ? k.asHex() : hex(k);
  return s.toLowerCase();
};

const argH160 = process.argv.includes("--h160")
  ? process.argv[process.argv.indexOf("--h160") + 1]?.toLowerCase()
  : null;

const matches = originals
  .map(keyHex)
  .filter((h) => h.startsWith(PHONE_PREFIX) && h.endsWith(PHONE_SUFFIX));

console.log(`  matches: ${matches.length}`);
for (const m of matches) console.log(`    ⭐ ${m}`);
if (matches.length === 0) {
  console.log("    (none — the phone's account has never called map_account on this chain)");
}

// (b) The wider forward scan: every AccountId32 that holds a balance on Asset Hub or on the People
//     chain, run through the SDK's own `deriveH160` (= keccak256(publicKey)[12..32]). If the phone's
//     product account has ever received a single plancks-worth of anything, it is in this set.
console.log("\n  wider scan: every balance-holding AccountId32 → deriveH160, forward:");
const wide = [];
const seen = new Set();
const scan = async (api, label) => {
  const entries = await api.query.System.Account.getEntries();
  console.log(`    ${label}: ${entries.length} accounts`);
  for (const e of entries) {
    const ss58 = String(e.keyArgs[0]);
    if (seen.has(ss58)) continue;
    seen.add(ss58);
    let h;
    try {
      h = sdkAddress.ss58ToH160(ss58).toLowerCase();
    } catch {
      continue;
    }
    if (h.startsWith(PHONE_PREFIX) && h.endsWith(PHONE_SUFFIX)) wide.push([h, ss58, label]);
  }
};
await scan(ahApi, "Asset Hub System.Account");
await scan(pApi, "People System.Account");
console.log(`    scanned ${seen.size} distinct accounts, matches: ${wide.length}`);
for (const [h, s, l] of wide) console.log(`    ⭐ ${h} → ${s}  (${l})`);
for (const [h] of wide) if (!matches.includes(h)) matches.push(h);

if (matches.length === 0) {
  console.log("\n    ⛔ NOT FOUND ANYWHERE. The phone's address has no on-chain footprint at all:");
  console.log("       not revive-mapped, and not the H160 of any account holding a balance on");
  console.log("       Asset Hub or the People chain. That absence IS the finding — the phone's");
  console.log("       product account has never written, never been funded, and is a different");
  console.log("       account from the one that published everything Plaza has on chain.");
}

// ── 2. What does each account hold? ──────────────────────────────────────────────────────────────
console.log("\n═══ 2. WHAT EACH ACCOUNT HOLDS ═══\n");

const liteEntries = await pApi.query.PeopleLite.LitePeople.getEntries();
const lite = new Set(liteEntries.map((e) => String(e.keyArgs[0])));

const targets = [
  ["browser (desktop tab, QR-paired)", BROWSER_H160],
  ...matches.map((m) => ["phone (native app) — recovered", m]),
  ...(argH160 ? [["--h160 argument", argH160]] : []),
];

for (const [label, h160] of targets) {
  console.log(`  ── ${label}`);
  console.log(`     H160        ${h160}`);
  let ss58 = null;
  try {
    ss58 = await ahApi.query.Revive.OriginalAccount.getValue(Binary.fromHex(h160));
  } catch (e) {
    console.log(`     AccountId32 (lookup failed: ${e.message})`);
  }
  console.log(`     AccountId32 ${ss58 ?? "(unmapped — never touched revive)"}`);
  if (ss58) {
    console.log(`     LitePerson? ${lite.has(String(ss58)) ? "YES" : "no"}`);
    try {
      const acct = await ahApi.query.System.Account.getValue(ss58);
      const free = acct?.data?.free ?? 0n;
      console.log(`     native free ${(Number(free) / 1e10).toFixed(6)} PAS  (AccountId32 side)`);
    } catch { /* shape varies by runtime; the H160 balance below is the one that matters */ }
  }
  const p = await profileOf(h160);
  console.log(`     hasProfile  ${p.hasProfile}${p.displayName !== undefined ? `  "${p.displayName}"` : ""}`);
  if (p.bio) console.log(`     bio         ${p.bio.slice(0, 80)}`);
  for (const [n, v] of Object.entries(p.heads)) console.log(`     head[${n}]${" ".repeat(Math.max(0, 5 - n.length))} ${v}`);
  console.log(`     follows     ${p.following} following / ${p.followers} followers`);
  console.log(`     balance     ${p.balance}`);
  console.log("");
}

// ── 3. Every writer PostRegistry has ever seen, so nothing is missed ─────────────────────────────
console.log("═══ 3. EVERY WRITER POSTREGISTRY HAS EVER SEEN ═══\n");
for (const [name, id] of Object.entries(REGISTRIES)) {
  const out = await ethCall(POST_REGISTRY, `0x${sel("writersOf(bytes32,uint256,uint256)")}${id.slice(2)}${n32(0)}${n32(200)}`);
  if (out.error) { console.log(`  ${name}: error ${out.error.message}`); continue; }
  const r = out.result.slice(2);
  const off = Number.parseInt(r.slice(0, 64), 16) * 2;
  const total = Number.parseInt(r.slice(64, 128), 16);
  const len = Number.parseInt(r.slice(off, off + 64), 16);
  console.log(`  keccak("${name}") total=${total}`);
  for (let i = 0; i < len; i++) {
    const w = "0x" + r.slice(off + 64 + i * 64 + 24, off + 64 + (i + 1) * 64);
    const tag =
      w.toLowerCase() === BROWSER_H160.toLowerCase() ? "  ← BROWSER (desktop, QR-paired)"
      : matches.includes(w.toLowerCase()) ? "  ← PHONE (native app)"
      : "";
    console.log(`    ${w}${tag}`);
  }
}

// ── 4. What productId does the BROWSER host actually derive with? ────────────────────────────────
//
// The product cannot observe this: `adaptAccountsProvider.getProductAccount` echoes back the
// `dotNsIdentifier` we *asked for* and the host response carries only `{ account: { publicKey } }`.
// So the only way to know is to read the host. Fetched live, because a hash pinned in a doc rots.
console.log("\n═══ 4. WHICH productId DOES THE BROWSER HOST DERIVE WITH? ═══\n");
try {
  const HOST = "https://browse.dev-dot.li";
  const index = await (await fetch(HOST + "/")).text();
  const entry = index.match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0];
  console.log(`  ${HOST}/${entry}`);
  const entrySrc = await (await fetch(`${HOST}/${entry}`)).text();
  const chunks = [...new Set(entrySrc.match(/assets\/[A-Za-z0-9_-]+\.js/g) ?? [])];

  // The container chunk is lazily imported and may not be named in the entry, so follow one hop.
  const seenChunks = new Set(chunks);
  const sources = new Map();
  for (const c of chunks) {
    const src = await (await fetch(`${HOST}/${c}`)).text();
    sources.set(c, src);
    for (const n of src.match(/assets\/[A-Za-z0-9_-]+\.js/g) ?? []) {
      if (!seenChunks.has(n)) {
        seenChunks.add(n);
        sources.set(n, await (await fetch(`${HOST}/${n}`)).text());
      }
    }
  }

  // Several chunks *declare* handleAccountGet (the truapi host interface). Only one both installs
  // a handler and contains the derivation, and that is the one that decides the junction.
  const [name, src] =
    [...sources].find(([, s]) => s.includes("handleAccountGet((") && s.includes("publicSoft")) ?? [];
  if (!src) {
    console.log("  ⚠️ no chunk defines handleAccountGet — the host was restructured, re-read it by hand.");
  } else {
    console.log(`  account handling lives in ${name}\n`);
    // Minified names are per-build, so locate the definitions structurally rather than by name.
    const grab = (re) => src.match(re)?.[0] ?? "(not found — the host changed, re-read by hand)";
    console.log("  the five functions that decide the productId junction, verbatim:\n");
    for (const re of [
      /function \w+\(\w+\)\{return \w+\.startsWith\(`localhost:`\)[^}]*\}/, // _n
      /function \w+\(\w+\)\{return \w+\(\w+\)\?\w+:`\$\{\w+\}\.dot`\}/, //      X
      /function \w+\(\w+,\w+\)\{return \w+\.isProductIdentifier[^}]*\}/, //     vn
      /function \w+\(\w+,\w+\)\{let \w+=\w+\(\w+\);return \w+\(\w+\)\?\w+:\[\w+\(\w+\),\w+\[1\]\]\}/, // Z
      /\w+=\(\w+,\w+,\w+\)=>\[`product`[^,]*,\w+,String\(\w+\)\][^;]*?publicSoft[^;]*?\)/, //          Ke
    ]) console.log(`    ${grab(re)}`);

    const getAccount = grab(/handleAccountGet\(\([\s\S]{0,400}?DomainNotValid\(void 0\)\)\}\)/);
    console.log(`\n  and the handler that uses them:\n\n    ${getAccount}\n`);
    console.log("  READ IT LIKE THIS. `t` is the label of the app the host LOADED (`plaza-social`);");
    console.log("  the request carries the identifier the app ASKED for (`plaza.dot`).");
    console.log("    _n(t)  false — we are neither localhost: nor a webcontainer preview host");
    console.log("    Z(t,e) → [X(t), requestedIndex]  ⇒ the requested identifier is DISCARDED");
    console.log("    X(t)   → `plaza-social.dot`");
    console.log("  ⇒ the browser host derives with plaza-social.dot. APP_NAME never reaches it.");
    console.log("  The same substitution is applied by handleSignPayload, handleSignRaw,");
    console.log("  handleRequestResourceAllocation (callingProductId) and resolveContractAccount,");
    console.log("  so the browser host is self-consistent — it is consistent with a DIFFERENT");
    console.log("  identifier from the one we send, which is why a host that honours the request");
    console.log("  (the native app, apparently) lands on a different account from the SAME root.");
  }
} catch (e) {
  console.log(`  (host fetch failed: ${e.message})`);
}

ah.destroy();
people.destroy();
process.exit(0);
