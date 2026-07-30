// The PolkaVM build. This is the config `cdm` uses. Pattern copied from
// yolodot/contracts/plaza-heads — see docs/products-platform/architecture.md §0.
//
// Requiring @parity/hardhat-polkadot replaces solc's EVM backend with `resolc`, so
// `hardhat compile` emits a PolkaVM blob (magic bytes `PVM\0`), not EVM bytecode.
//
// No Rust is needed: resolc ships as a WASM binary inside `@parity/resolc`, pulled in via
//   @parity/hardhat-polkadot -> @parity/hardhat-polkadot-resolc -> @parity/resolc
// `cdm setup --check` reporting `rustup` missing is about the `cargo pvm-contract` route, which
// this project does not use. Ignore it.
//
// ⚠️ WHY .cjs AND NOT .ts. This package is `"type": "module"` (all tests and scripts are ESM).
// yolodot's equivalent package is CommonJS, so its `hardhat.config.ts` works there and fails here:
// Hardhat 2 loads a TS config through ts-node with `module: commonjs`, which an ESM project rejects
// with HH19. Writing the config as plain CommonJS `.cjs` is CJS regardless of package type, needs
// no ts-node, and removes a TypeScript version dependency that already broke once (ts-node 10.9
// cannot read TypeScript 7's compiler API — it fails as `Cannot read properties of undefined
// (reading 'fileExists')`, which reads like a missing tsconfig and is not).
//
// ⚠️ THERE IS DELIBERATELY NO LIVE NETWORK ENTRY HERE. Deploying through Hardhat would mean signing
// an `eth_sendRawTransaction` with an ECDSA key, but our funded devnet account is an **sr25519
// Substrate account** whose 0x address (0x82A06d576eEDC077F3dE3Fe350767D9d068Ab345) is a
// pallet-revive *mapping* from an AccountId32, not a secp256k1 keypair — no ethers wallet can ever
// sign as it. Deployment goes through `cdm deploy`, which signs the pallet-revive extrinsic with the
// mnemonic. Verified 2026-07-30: every ETH derivation path of our mnemonic holds 0, while the
// sr25519 account holds 4921 PAS at nonce 74.
//
// Tests do NOT run here — see hardhat.evm.config.js (plain solc, in-process EVM). That gap matters
// for cost, not logic: pallet-revive gas is dominated by the storage deposit, so an EVM gas number
// is never a devnet cost.
require("@parity/hardhat-polkadot");

module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  // `polkadot: true` is what actually switches the compile backend to resolc. Requiring the plugin
  // alone is NOT enough — without this the build succeeds and silently emits EVM bytecode, and cdm
  // rejects it with "hardhat build did not produce deployable bytecode", which points nowhere near
  // the cause. Verified 2026-07-30: artifacts went from 0x60a06040 (EVM) to 0x50564d00 ("PVM\0")
  // when this block was added, with nothing else changed.
  //
  // The nodeBinaryPath is only used by the local `hardhat` network, which needs an `anvil-polkadot`
  // binary that is not published on npm. We never run it — tests use hardhat.evm.config.js — but the
  // plugin wants the key present.
  networks: {
    hardhat: {
      polkadot: true,
      nodeConfig: {
        nodeBinaryPath: process.env.ANVIL_POLKADOT_BINARY ?? "./bin/anvil-polkadot",
      },
    },
  },
};
