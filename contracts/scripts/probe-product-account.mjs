// Probe: is the product account Plaza sees PER-DEVICE or PER-IDENTITY?
//
// Asked on 2026-07-31 after the user opened Plaza on a desktop and on a phone, signed in as
// themselves both times, and saw two different profiles at two different addresses.
//
//   node scripts/probe-product-account.mjs          # fast facts only (~15 s)
//   node scripts/probe-product-account.mjs --link   # + the exhaustive parent search (~90 s)
//
// Read-only: `eth_call` on the ETH RPC, storage reads on Asset Hub and on the Individuality /
// People chain, and pure offline sr25519 soft derivations. No keys, no extrinsics, safe to re-run.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT IT ESTABLISHES, AND WHY EACH PART IS HERE
//
// 1. THE DERIVATION RULE HAS NO DEVICE INPUT. `deriveProductAccountPublicKey` is
//    sr25519 *public* soft derivation over the junctions ["product", productId, String(index)].
//    Three inputs, all of them non-device. Section 1 shows it is deterministic and shows what
//    changing the productId does — which is the failure mode to fear, because Plaza asks for
//    `plaza.dot` while it is deployed as `plaza-social.dot`.
//
// 2. THE PARENT IS INVISIBLE ON CHAIN. Section 3 takes every product account Plaza has ever seen
//    write, and searches for a parent among *every* AccountId32 that has ever touched revive on
//    this chain (4260 of them, which is a superset of all 159 Lite-personhood accounts). It finds
//    none. Soft derivation is one-way per parent, so this is the only search available, and its
//    failure is the finding: a product account has no discoverable link to an identity.
//
// 3. IDENTITY *IS* RESOLVABLE — JUST NOT FROM THE PRODUCT ACCOUNT. Section 4 shows the one working
//    chain: `getUserId().primaryUsername` (a host call) → `Resources.UsernameOwnerOf[username]` →
//    an identity AccountId32 that is a `PeopleLite.LitePeople` entry. 159/159 usernames resolve to
//    159 distinct owners and all 159 owners are LitePeople.
//
// ⛔ NEVER derive an AccountId32 from an H160. `Revive.OriginalAccount` is the only sound reverse
//    route and it is what this script uses. `h160ToSs58()` yields a *different*, real, unrelated
//    account; tipping it destroys funds.

import { createClient, Binary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/web";

// The SDK is a frontend dependency; there is no second copy under contracts/. Importing it by
// absolute file URL is deliberate — vendoring the derivation here would let the two drift, and a
// silent drift is exactly the class of bug this script exists to detect.
const FRONTEND = new URL("../../frontend/node_modules/@parity/", import.meta.url);
const keys = await import(new URL("product-sdk-keys/dist/index.js", FRONTEND).href);
const address = await import(new URL("product-sdk-address/dist/index.js", FRONTEND).href);

const ETH_RPC = process.env.ETH_RPC ?? "https://paseo-assethub-rpc.laissez-faire.trade";
const ASSET_HUB_WS = process.env.SUBSTRATE_WS ?? "wss://asset-hub-paseo-rpc.n.dwellir.com";
const PEOPLE_WS = process.env.PEOPLE_WS ?? "wss://people-paseo.rotko.net";

const POST_REGISTRY = "0xF6daC4BC4e721c5C84504A5Bfe033AE63722f8c9";

/**
 * Every product identifier a host could plausibly have asked for on Plaza's behalf.
 *
 * ⚠️ `plaza.dot` is FIRST because it is what actually goes over the wire today: `App.tsx` passes
 * `APP_NAME = 'plaza'` as `dappName`, and `product-sdk-signer`'s `productIdentifierFromDappName`
 * appends `.dot` to anything that is not already `.dot` and not a localhost form. The product is
 * *deployed* as `plaza-social.dot`. Both are listed because a host that substitutes the identifier
 * it actually loaded, rather than honouring the one we asked for, would derive the second — and two
 * hosts disagreeing on that single string is enough to produce two accounts for one human.
 */
const PRODUCT_IDS = [
  "plaza.dot",
  "plaza-social.dot",
  "plaza",
  "plaza-social",
  "plaza-social.dev-dot.li",
  "plaza-social.app.dev-dot.li",
];

const hex = (bytes) => "0x" + Buffer.from(bytes).toString("hex");
const kec = async (s) => {
  const { keccak_256 } = await import(
    new URL("../../frontend/node_modules/@noble/hashes/sha3.js", import.meta.url).href
  );
  return hex(keccak_256(new TextEncoder().encode(s)));
};

async function ethCall(to, data) {
  const res = await fetch(ETH_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  return res.json();
}

/** `PostRegistry.writersOf(registryId, offset, limit)` — every address that has ever set a head. */
async function writersOf(name, limit = 200) {
  const id = (await kec(name)).slice(2);
  const sel = (await kec("writersOf(bytes32,uint256,uint256)")).slice(2, 10);
  const n32 = (n) => n.toString(16).padStart(64, "0");
  const out = await ethCall(POST_REGISTRY, `0x${sel}${id}${n32(0)}${n32(limit)}`);
  if (out.error) return { id: `0x${id}`, error: out.error.message, writers: [] };
  const r = out.result.slice(2);
  const off = Number.parseInt(r.slice(0, 64), 16) * 2;
  const total = Number.parseInt(r.slice(64, 128), 16);
  const len = Number.parseInt(r.slice(off, off + 64), 16);
  const writers = [];
  for (let i = 0; i < len; i++) writers.push("0x" + r.slice(off + 64 + i * 64 + 24, off + 64 + (i + 1) * 64));
  return { id: `0x${id}`, total, writers };
}

const wantLink = process.argv.includes("--link");

// ── 1. The derivation rule, offline ────────────────────────────────────────────────────────────
console.log("═══ 1. THE DERIVATION RULE ═══\n");
console.log("  productAccountPk = fold(parentPk, ['product', productId, String(index)], sr25519.publicSoft)\n");
console.log("  Inputs: parent public key, product id, derivation index. NOTHING ELSE.");
console.log("  No device id, no install id, no session key, no salt, no randomness.\n");

// A stable, valid ristretto public key to demonstrate against — Alice's, so the numbers below are
// reproducible by anyone. `seedToAccount` takes the mnemonic, not a raw seed.
const DEV = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";
const alice = keys.seedToAccount(DEV, "//Alice");
console.log(`  demo parent (//Alice): ${alice.ss58Address}`);
for (const id of PRODUCT_IDS.slice(0, 2)) {
  for (const i of [0, 1]) {
    const pk = keys.deriveProductAccountPublicKey(alice.publicKey, id, i);
    console.log(`    ${id.padEnd(28)} idx ${i} → ${address.ss58Encode(pk, 42)}`);
  }
}
const twice = [0, 1].map(() => hex(keys.deriveProductAccountPublicKey(alice.publicKey, "plaza.dot", 0)));
console.log(`\n  deterministic across calls: ${twice[0] === twice[1] ? "YES" : "NO — investigate"}`);
console.log("  ⚠️ note how far apart the two productId rows are: one string decides the identity.\n");

// ── 2. What Plaza has actually seen on chain ───────────────────────────────────────────────────
console.log("═══ 2. PRODUCT ACCOUNTS ON CHAIN ═══\n");
const forum = await writersOf("forum");
const feed = await writersOf("feed");
console.log(`  PostRegistry.writersOf(keccak("forum")) total=${forum.total ?? forum.error}`);
for (const w of forum.writers) console.log(`    ${w}`);
console.log(`  PostRegistry.writersOf(keccak("feed"))  total=${feed.total ?? feed.error}`);
for (const w of feed.writers) console.log(`    ${w}`);

const ah = createClient(getWsProvider(ASSET_HUB_WS));
const ahApi = ah.getUnsafeApi();
const productAccounts = [];
console.log("\n  Revive.OriginalAccount — the ONLY sound H160 → AccountId32 route:");
for (const w of [...new Set([...forum.writers, ...feed.writers])]) {
  const ss58 = await ahApi.query.Revive.OriginalAccount.getValue(Binary.fromHex(w));
  console.log(`    ${w} → ${ss58 ?? "(unmapped)"}`);
  if (ss58) productAccounts.push(ss58);
}

// ── 3. Can a product account be traced back to an identity? ────────────────────────────────────
console.log("\n═══ 3. CAN A PRODUCT ACCOUNT BE TRACED BACK? ═══\n");
const people = createClient(getWsProvider(PEOPLE_WS));
const pApi = people.getUnsafeApi();
const liteEntries = await pApi.query.PeopleLite.LitePeople.getEntries();
const lite = new Set(liteEntries.map((e) => e.keyArgs[0]));
const fullPeople = await pApi.query.People.People.getEntries();
console.log(`  PeopleLite.LitePeople : ${lite.size} entries (keyed by identity account)`);
console.log(`  People.People         : ${fullPeople.length} entries (keyed by numeric PersonalId,`);
console.log("                          NOT by account — full personhood is not account-resolvable)");
for (const pa of productAccounts) {
  console.log(`  ${pa}`);
  console.log(`    is a LitePerson? ${lite.has(pa) ? "YES" : "no"}`);
}

if (!wantLink) {
  console.log("\n  (skipping the exhaustive parent search — re-run with --link, ~90 s)");
} else {
  const originals = await ahApi.query.Revive.OriginalAccount.getEntries();
  const parents = [...new Set(originals.map((e) => e.value))];
  const inLite = parents.filter((p) => lite.has(p)).length;
  console.log(`\n  Candidate parents = every AccountId32 that has ever touched revive: ${parents.length}`);
  console.log(`  …of which are LitePeople: ${inLite} (so the search covers every Lite identity)`);
  const targets = new Map(productAccounts.map((p) => [hex(address.ss58Decode(p).publicKey), p]));
  let tried = 0;
  const hits = [];
  const t0 = Date.now();
  for (const p of parents) {
    let pk;
    try {
      pk = address.ss58Decode(p).publicKey;
    } catch {
      continue;
    }
    for (const id of PRODUCT_IDS) {
      for (let i = 0; i < 2; i++) {
        tried++;
        let derived;
        try {
          derived = hex(keys.deriveProductAccountPublicKey(pk, id, i));
        } catch {
          continue;
        }
        const t = targets.get(derived);
        if (t) hits.push({ parent: p, productId: id, index: i, productAccount: t });
      }
    }
  }
  console.log(`  ${tried} derivations in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (hits.length === 0) {
    console.log("  ⭐ NO PARENT FOUND. The root account behind Plaza's product account does not");
    console.log("     appear anywhere on this chain, so nothing can link it to a person.");
  } else {
    console.log("  ⭐ PARENT FOUND — this would be a major finding, record it:");
    for (const h of hits) console.log(`     ${JSON.stringify(h)}`);
  }
}

// ── 4. The one identity route that DOES work ───────────────────────────────────────────────────
console.log("\n═══ 4. THE IDENTITY ROUTE THAT DOES WORK ═══\n");
const usernameEntries = await pApi.query.Resources.UsernameOwnerOf.getEntries();
const dec = new TextDecoder();
const rows = usernameEntries.map((e) => {
  const k = e.keyArgs[0];
  const name = typeof k === "string" ? k : dec.decode(k.asBytes ? k.asBytes() : k);
  return [name, String(e.value)];
});
const owners = new Set(rows.map((r) => r[1]));
console.log(`  Resources.UsernameOwnerOf : ${rows.length} usernames → ${owners.size} distinct owners`);
console.log(`  owners that are LitePeople: ${[...owners].filter((o) => lite.has(o)).length}`);
console.log("\n  So: getUserId().primaryUsername  →  Resources.UsernameOwnerOf[name]  →  identity");
console.log("      account  →  PeopleLite.LitePeople[account]. All read-only, all host-independent.");

// ⚠️ …with one caveat that is fatal to using it as a *unique* human key.
const stems = new Map();
for (const [n] of rows) {
  const s = n.slice(0, n.lastIndexOf("."));
  stems.set(s, (stems.get(s) ?? 0) + 1);
}
const collisions = [...stems].filter(([, c]) => c > 1);
console.log(`\n  ⚠️ ${collisions.length} username stems are registered more than once, each time to a`);
console.log("     DIFFERENT account and a different Lite-personhood entry:");
for (const [s, c] of collisions) {
  const owned = rows.filter((r) => r[0].startsWith(`${s}.`));
  console.log(`     ${s} ×${c} → ${owned.map((o) => o[0]).join(", ")}`);
}
console.log("\n     A human who registers a second time gets a second identity account and a second");
console.log("     username. Lite personhood is device-attested, so a second device is a second");
console.log("     'person' as far as this chain is concerned.");

ah.destroy();
people.destroy();
process.exit(0);
