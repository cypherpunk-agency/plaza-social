// Probe: READ-ONLY. What/where is "CASH"? Is the Substrate RPC the same chain as the ETH RPC?
// Throwaway verification script (see probe-personhood.mjs for the established pattern).
// Deliberately NOT guarded on `import.meta.url === file://argv[1]` — always false on Windows.

import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/web";

const SUB_AH = "wss://asset-hub-paseo-rpc.n.dwellir.com";
const ETH_AH = "https://paseo-assethub-rpc.laissez-faire.trade";
const PEOPLE = "wss://people-paseo.rotko.net";

const POST_REGISTRY = "0xF6daC4BC4e721c5C84504A5Bfe033AE63722f8c9";

async function eth(method, params = []) {
  const r = await fetch(ETH_AH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return await r.json();
}

const j = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() + "n" : x instanceof Uint8Array ? "0x" + Buffer.from(x).toString("hex") : x), 2);

async function main() {
  // ---------------------------------------------------------------- Q1 identity
  console.log("############ Q1: CHAIN IDENTITY ############\n");
  const sub = createClient(getWsProvider(SUB_AH));
  const r = (m, p = []) => sub._request(m, p);

  console.log("-- Substrate RPC", SUB_AH);
  console.log("genesis          ", await r("chain_getBlockHash", [0]));
  console.log("system_chain     ", await r("system_chain"));
  console.log("system_name      ", await r("system_name"));
  console.log("system_version   ", await r("system_version"));
  console.log("system_properties", j(await r("system_properties")));
  const head = await r("chain_getHeader", []);
  const headNum = parseInt(head.number, 16);
  console.log("head             ", headNum);

  console.log("\n-- ETH RPC", ETH_AH);
  console.log("eth_chainId      ", (await eth("eth_chainId")).result, "=", parseInt((await eth("eth_chainId")).result, 16));
  console.log("web3_clientVersion", (await eth("web3_clientVersion")).result);
  const ethHead = parseInt((await eth("eth_blockNumber")).result, 16);
  console.log("eth_blockNumber  ", ethHead);

  const n = headNum - 20;
  const subHash = await r("chain_getBlockHash", [n]);
  const ethBlk = (await eth("eth_getBlockByNumber", ["0x" + n.toString(16), false])).result;
  console.log(`\nblock ${n} substrate hash : ${subHash}`);
  console.log(`block ${n} eth   hash      : ${ethBlk?.hash}`);
  console.log(`block ${n} eth   extraData : ${ethBlk?.extraData}`);
  console.log(`block ${n} eth   stateRoot : ${ethBlk?.stateRoot}`);
  console.log(`block ${n} substrate stateRoot: ${(await r("chain_getHeader", [subHash]))?.stateRoot}`);

  const api = sub.getUnsafeApi();
  // Revive.ContractInfoOf for PostRegistry
  try {
    const info = await api.query.Revive.ContractInfoOf.getValue(POST_REGISTRY);
    console.log("\nRevive.ContractInfoOf(PostRegistry) =", j(info));
  } catch (e) {
    console.log("\nRevive.ContractInfoOf failed:", e.message);
  }
  const ethCode = (await eth("eth_getCode", [POST_REGISTRY, "latest"])).result;
  console.log("eth_getCode(PostRegistry) length =", ethCode?.length, "prefix", ethCode?.slice(0, 20));

  // ---------------------------------------------------------------- Q2/Q3 assets
  console.log("\n\n############ Q2/Q3: ASSETS ON THIS ASSET HUB ############\n");
  const pallets = (await api.getMetadata?.()) ? null : null;

  const one = await api.query.Assets.Asset.getValue(50000413);
  console.log("Assets.Asset(50000413) =", j(one));
  const meta1 = await api.query.Assets.Metadata.getValue(50000413);
  console.log("Assets.Metadata(50000413) =", j(meta1));

  const assets = await api.query.Assets.Asset.getEntries();
  console.log("\nAssets.Asset entry count =", assets.length);
  const metas = await api.query.Assets.Metadata.getEntries();
  const metaBy = new Map(metas.map((m) => [String(m.keyArgs[0]), m.value]));
  const dec = (v) => (v instanceof Uint8Array ? Buffer.from(v).toString("utf8") : typeof v === "string" ? v : String(v));
  for (const a of assets.sort((x, y) => Number(x.keyArgs[0]) - Number(y.keyArgs[0]))) {
    const id = String(a.keyArgs[0]);
    const m = metaBy.get(id);
    console.log(
      `  id=${id.padEnd(10)} sym=${(m ? dec(m.symbol) : "?").padEnd(10)} name=${(m ? dec(m.name) : "?").padEnd(24)} dec=${m ? m.decimals : "?"} supply=${a.value.supply} suff=${a.value.is_sufficient} min=${a.value.min_balance} status=${a.value.status?.type ?? a.value.status} accts=${a.value.accounts}`
    );
  }

  // ForeignAssets
  try {
    const fa = await api.query.ForeignAssets.Asset.getEntries();
    console.log("\nForeignAssets.Asset entry count =", fa.length);
    if (fa.length < 40) {
      const fam = await api.query.ForeignAssets.Metadata.getEntries();
      for (const a of fa) {
        const m = fam.find((x) => JSON.stringify(x.keyArgs[0], (k, v) => (typeof v === "bigint" ? v.toString() : v)) === JSON.stringify(a.keyArgs[0], (k, v) => (typeof v === "bigint" ? v.toString() : v)));
        console.log("  loc =", j(a.keyArgs[0]));
        console.log("    meta =", m ? `sym=${dec(m.value.symbol)} name=${dec(m.value.name)} dec=${m.value.decimals}` : "(none)", " supply=", a.value.supply, " suff=", a.value.is_sufficient, " min=", a.value.min_balance);
      }
    }
  } catch (e) {
    console.log("\nForeignAssets query failed:", e.message);
  }

  sub.destroy();
}

await main();
process.exit(0);
