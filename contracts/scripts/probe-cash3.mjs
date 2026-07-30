// READ-ONLY probe #3: full asset inventory with decoded names/symbols; hunt for "CASH".
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/web";

const URL = process.argv[2] || "wss://asset-hub-paseo-rpc.n.dwellir.com";
const sub = createClient(getWsProvider(URL));
const api = sub.getUnsafeApi();

const txt = (v) => (v && typeof v.asText === "function" ? v.asText() : v && v.asHex ? v.asHex() : String(v));

async function main() {
  console.log("chain:", await sub._request("system_chain"), " genesis:", await sub._request("chain_getBlockHash", [0]));

  const assets = await api.query.Assets.Asset.getEntries();
  const metas = await api.query.Assets.Metadata.getEntries();
  const metaBy = new Map(metas.map((m) => [String(m.keyArgs[0]), m.value]));
  console.log(`\n=== Assets.Asset: ${assets.length} entries ===`);
  const rows = assets
    .map((a) => ({ id: Number(a.keyArgs[0]), v: a.value, m: metaBy.get(String(a.keyArgs[0])) }))
    .sort((x, y) => x.id - y.id);
  for (const { id, v, m } of rows) {
    console.log(
      `id=${String(id).padEnd(9)} sym=${(m ? txt(m.symbol) : "-").padEnd(12)} name=${(m ? txt(m.name) : "-").padEnd(26)} dec=${m ? m.decimals : "-"}\tsuff=${v.is_sufficient}\tmin=${v.min_balance}\tsupply=${v.supply}\tstatus=${v.status?.type}\taccts=${v.accounts}`
    );
  }

  console.log("\n=== grep for CASH / cash ===");
  for (const { id, m } of rows) {
    if (!m) continue;
    const s = txt(m.symbol), n = txt(m.name);
    if (/cash/i.test(s) || /cash/i.test(n)) console.log("  HIT local asset", id, s, n);
  }
  console.log("asset id 1 present?", rows.some((r) => r.id === 1));
  console.log("asset id 50000413 present?", rows.some((r) => r.id === 50000413));
  console.log("Assets.NextAssetId =", await api.query.Assets.NextAssetId.getValue());

  // ForeignAssets
  const fa = await api.query.ForeignAssets.Asset.getEntries();
  const fam = await api.query.ForeignAssets.Metadata.getEntries();
  console.log(`\n=== ForeignAssets.Asset: ${fa.length} entries ===`);
  const norm = (o) => JSON.stringify(o, (k, x) => (typeof x === "bigint" ? x.toString() : x && x.asHex ? x.asHex() : x));
  for (const a of fa) {
    const m = fam.find((x) => norm(x.keyArgs[0]) === norm(a.keyArgs[0]));
    console.log("  loc:", norm(a.keyArgs[0]));
    console.log(
      "     ",
      m ? `sym=${txt(m.value.symbol)} name=${txt(m.value.name)} dec=${m.value.decimals}` : "(no metadata)",
      ` suff=${a.value.is_sufficient} min=${a.value.min_balance} supply=${a.value.supply} status=${a.value.status?.type} accts=${a.value.accounts}`
    );
  }

  // AssetsPrecompiles index maps (only exists on asset hub)
  try {
    const idx = await api.query.AssetsPrecompiles.ForeignAssetIdToAssetIndex.getEntries();
    console.log(`\n=== AssetsPrecompiles.ForeignAssetIdToAssetIndex: ${idx.length} entries ===`);
    for (const e of idx) console.log("  index", e.value, "<-", norm(e.keyArgs[0]));
    console.log("AssetsPrecompiles.NextAssetIndex =", await api.query.AssetsPrecompiles.NextAssetIndex.getValue());
  } catch (e) {
    console.log("\nAssetsPrecompiles not present:", e.message);
  }

  // PoolAssets
  try {
    const pa = await api.query.PoolAssets.Asset.getEntries();
    console.log(`\nPoolAssets.Asset: ${pa.length} entries; ids:`, pa.map((x) => String(x.keyArgs[0])).join(","));
  } catch {}
}

await main();
sub.destroy();
process.exit(0);
