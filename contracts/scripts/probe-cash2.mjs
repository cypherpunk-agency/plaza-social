// READ-ONLY probe #2: pallet inventory + storage item key/value types, from raw runtime metadata.
// Usage: node scripts/probe-cash2.mjs [wsUrl] [pallet,pallet,...]
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/web";
import { unifyMetadata, metadata as metadataCodec, Binary } from "@polkadot-api/substrate-bindings";
import { getLookupFn } from "@polkadot-api/metadata-builders";

const URL = process.argv[2] || "wss://asset-hub-paseo-rpc.n.dwellir.com";
const WANT = (process.argv[3] || "Revive,Assets,ForeignAssets,PoolAssets,AssetConversion,Coinage,Airdrop,People,PeopleLite,Proofs").split(",");

const sub = createClient(getWsProvider(URL));

function typeName(lookup, id, depth = 0) {
  try {
    const d = lookup(id);
    if (depth > 2) return d.type;
    switch (d.type) {
      case "primitive": return d.value;
      case "compact": return "Compact<" + typeName(lookup, d.value.id ?? 0, depth + 1) + ">";
      case "array": return `[${typeName(lookup, d.value.id, depth + 1)}; ${d.len}]`;
      case "sequence": return `Vec<${typeName(lookup, d.value.id, depth + 1)}>`;
      case "tuple": return "(" + d.value.map((v) => typeName(lookup, v.id, depth + 1)).join(", ") + ")";
      case "struct": return "{" + Object.entries(d.value).map(([k, v]) => `${k}: ${typeName(lookup, v.id, depth + 1)}`).join(", ") + "}";
      case "enum": return "Enum{" + Object.keys(d.value).join("|") + "}";
      case "AccountId32": return "AccountId32";
      case "AccountId20": return "AccountId20(H160)";
      case "option": return "Option<" + typeName(lookup, d.value.id, depth + 1) + ">";
      case "result": return "Result<..>";
      case "void": return "()";
      case "bitSequence": return "BitSeq";
      default: return d.type;
    }
  } catch (e) { return "?" + id; }
}

async function main() {
  const hex = await sub._request("state_getMetadata", []);
  const raw = metadataCodec.dec(hex);
  const m = unifyMetadata(raw.metadata);
  const lookup = getLookupFn(m);

  console.log("metadata version:", raw.metadata.tag ?? "?", " pallets:", m.pallets.length);
  console.log("\n=== ALL PALLETS ===");
  console.log(m.pallets.map((p) => `${p.index}:${p.name}`).join("  "));

  for (const want of WANT) {
    const p = m.pallets.find((x) => x.name === want);
    if (!p) { console.log(`\n#### ${want}: ABSENT`); continue; }
    console.log(`\n#### ${want} (index ${p.index})`);
    for (const s of p.storage?.items ?? []) {
      if (s.type.tag === "plain") {
        console.log(`   [plain] ${s.name} : ${typeName(lookup, s.type.value)}`);
      } else {
        const v = s.type.value;
        console.log(`   [map]   ${s.name} : key=${typeName(lookup, v.key)} -> ${typeName(lookup, v.value)}  (hashers: ${v.hashers.map((h) => h.tag).join(",")})`);
      }
    }
    if (p.constants?.length) {
      for (const c of p.constants) {
        let val = "";
        try {
          const dec = lookup(c.type);
          val = " = " + Buffer.from(c.value).toString("hex");
        } catch {}
        console.log(`   [const] ${c.name} : ${typeName(lookup, c.type)}${val}`);
      }
    }
    if (p.calls != null) {
      const cid = typeof p.calls === "object" ? p.calls.type : p.calls;
      try {
        const d = lookup(cid);
        console.log(`   [calls] ${Object.keys(d.value).join(", ")}`);
      } catch (e) { console.log("   [calls] decode failed", e.message); }
    }
  }
}

await main();
sub.destroy();
process.exit(0);
