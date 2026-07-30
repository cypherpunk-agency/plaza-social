// READ-ONLY: People chain — Coinage, Airdrop, Assets.
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/web";
import { Twox128 } from "@polkadot-api/substrate-bindings";

const URL = "wss://people-paseo.rotko.net";
const sub = createClient(getWsProvider(URL));
const api = sub.getUnsafeApi();
const rpc = (m, p = []) => sub._request(m, p);
const te = new TextEncoder();
const hex = (u8) => "0x" + Buffer.from(u8).toString("hex");
const prefixFor = (p, i) => hex(new Uint8Array([...Twox128(te.encode(p)), ...Twox128(te.encode(i))]));
const txt = (v) => (v && typeof v.asText === "function" ? v.asText() : String(v));
const j = (v) => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? x.toString() : x && x.asHex ? x.asHex() : x));

async function countKeys(p, i, at) {
  const pfx = prefixFor(p, i);
  let total = 0, start = null;
  for (;;) {
    const keys = await rpc("state_getKeysPaged", [pfx, 1000, start, at]);
    total += keys.length;
    if (keys.length < 1000) break;
    start = keys[keys.length - 1];
    if (total > 500000) return total + "+ (capped)";
  }
  return total;
}

async function main() {
  const at = await rpc("chain_getBlockHash", []);
  console.log("chain:", await rpc("system_chain"), "genesis:", await rpc("chain_getBlockHash", [0]), "at:", at);
  console.log("props:", j(await rpc("system_properties")));

  console.log("\n=== Coinage ===");
  console.log("UnderlyingAssetId =", j(await api.query.Coinage.UnderlyingAssetId.getValue()));
  console.log("TotalValueOfDestroyedCoins =", await api.query.Coinage.TotalValueOfDestroyedCoins.getValue());
  for (const item of ["CoinsByOwner", "LockedCoins", "RecyclersCoinToRecycler", "PaidUnloadTokenMembers"]) {
    console.log(`Coinage.${item} entries =`, await countKeys("Coinage", item, at));
  }
  const coins = await api.query.Coinage.CoinsByOwner.getEntries();
  console.log("CoinsByOwner sample (first 5):");
  for (const c of coins.slice(0, 5)) console.log("   ", c.keyArgs[0], "->", j(c.value));

  console.log("\n=== Airdrop ===");
  for (const item of ["Events", "Registrations", "Winners", "SupportedAssets"]) {
    console.log(`Airdrop.${item} entries =`, await countKeys("Airdrop", item, at));
  }
  const ev = await api.query.Airdrop.Events.getEntries();
  for (const e of ev.slice(0, 5)) console.log("  event", j(e.keyArgs[0]), "->", j(e.value));
  const sa = await api.query.Airdrop.SupportedAssets.getEntries();
  for (const e of sa) console.log("  supportedAsset", j(e.keyArgs[0]), "->", e.value);

  console.log("\n=== People Assets (location-keyed) ===");
  const assets = await api.query.Assets.Asset.getEntries();
  const metas = await api.query.Assets.Metadata.getEntries();
  console.log("Assets.Asset entries =", assets.length);
  for (const a of assets) {
    const m = metas.find((x) => j(x.keyArgs[0]) === j(a.keyArgs[0]));
    console.log("  loc:", j(a.keyArgs[0]));
    console.log("     ", m ? `sym=${txt(m.value.symbol)} name=${txt(m.value.name)} dec=${m.value.decimals}` : "(no metadata)",
      `suff=${a.value.is_sufficient} min=${a.value.min_balance} supply=${a.value.supply} status=${a.value.status?.type} accts=${a.value.accounts} owner=${a.value.owner}`);
  }
  console.log("\nAssets.NextAssetId =", j(await api.query.Assets.NextAssetId.getValue()));

  console.log("\n=== PeopleLite / People ===");
  for (const [p, i] of [["PeopleLite", "LitePeople"], ["People", "Keys"], ["People", "AccountToPersonalId"]]) {
    try { console.log(`${p}.${i} entries =`, await countKeys(p, i, at)); } catch (e) { console.log(`${p}.${i} ->`, e.message); }
  }
}

await main();
sub.destroy();
process.exit(0);
