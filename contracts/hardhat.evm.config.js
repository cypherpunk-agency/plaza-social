import "@nomicfoundation/hardhat-toolbox";
import dotenv from "dotenv";
import { Mnemonic, HDNodeWallet } from "ethers";

dotenv.config();

// Function to get accounts from seed phrase or private key
function getAccounts() {
  if (process.env.SEED_PHRASE) {
    // Derive private key from seed phrase
    const mnemonic = Mnemonic.fromPhrase(process.env.SEED_PHRASE);
    const wallet = HDNodeWallet.fromMnemonic(mnemonic);
    return [wallet.privateKey];
  } else if (process.env.PRIVATE_KEY) {
    // Use private key directly
    return [`0x${process.env.PRIVATE_KEY.replace(/^0x/, '')}`];
  }
  return [];
}

/** @type import('hardhat/config').HardhatUserConfig */
export default {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  // ⚠️ SEPARATE OUTPUT DIRS FROM THE POLKAVM BUILD, and this is load-bearing.
  //
  // `hardhat.config.cjs` (the resolc/PolkaVM build that `cdm deploy` uses) writes to the DEFAULT
  // ./artifacts and ./cache. If this EVM config wrote there too, the two builds would overwrite each
  // other and `cdm` would find EVM bytecode where it expects a PolkaVM blob — which fails as
  // "hardhat build did not produce deployable bytecode for X", a message that says nothing about the
  // real cause. A PolkaVM artifact's bytecode begins 0x50564d00 ("PVM\0"); an EVM one begins 0x60...
  //
  // Same split as yolodot/contracts/plaza-heads, which puts EVM output in artifacts-evm.
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache-evm",
    artifacts: "./artifacts-evm"
  },
  networks: {
    hardhat: {
      chainId: 31337
    },
    localhost: {
      url: "http://127.0.0.1:8545"
    },
    // Polkadot Products Devnet (Asset Hub on Paseo). Ethereum JSON-RPC.
    //
    // Replaced `polkadotAssetHub` (testnet-passet-hub-eth-rpc.polkadot.io, chainId 420420422),
    // which is GONE: that hostname has no A, AAAA or CNAME record any more — confirmed against
    // both Cloudflare and Google DoH. The old deployment there is unreachable, which is why no
    // state migration was attempted.
    //
    // Named for the environment rather than the chain on purpose. On this platform the CLIs
    // disagree about defaults (`pad` defaults to paseo-next-v2, a VALID id, so omitting the flag
    // silently targets the wrong network and looks like it worked). Explicit names everywhere.
    productsDevnet: {
      url: "https://paseo-assethub-rpc.laissez-faire.trade",
      chainId: 420420417,
      accounts: getAccounts()
    }
  }
};
