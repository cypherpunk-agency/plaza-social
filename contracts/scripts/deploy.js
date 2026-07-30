import hre from "hardhat";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Deploys the four contracts Plaza needs on the Products platform.
 *
 *   UserRegistry    profiles + delegation (no session keys — DMs are dropped)
 *        |
 *        +-- PostRegistry    head pointers per (registry, writer); the on-chain index
 *        +-- FollowRegistry  follow graph
 *        +-- Voting          shared tallies keyed by CID or (registry, CID)
 *
 * There is no factory and nothing per-room or per-board to deploy: a chat room, a board and a
 * thread are all just `bytes32` registry ids inside the one PostRegistry
 * (docs/products-platform/architecture.md §2).
 */
async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);

  console.log("Deploying with account:", deployer.address);
  console.log("Account balance:", hre.ethers.formatEther(balance), "ETH/PAS");

  if (balance === 0n) {
    console.error("\n❌ ERROR: Your wallet has no funds!");
    console.error("Get testnet tokens from: https://faucet.polkadot.io/paseo?parachain=1000");
    console.error("Your address:", deployer.address);
    process.exit(1);
  }

  console.log("\n1/4 Deploying UserRegistry...");
  const UserRegistry = await hre.ethers.getContractFactory("UserRegistry");
  const userRegistry = await UserRegistry.deploy();
  await userRegistry.waitForDeployment();
  const userRegistryAddress = await userRegistry.getAddress();
  console.log(`   ✅ UserRegistry deployed to: ${userRegistryAddress}`);

  console.log("\n2/4 Deploying PostRegistry...");
  const PostRegistry = await hre.ethers.getContractFactory("PostRegistry");
  const postRegistry = await PostRegistry.deploy(userRegistryAddress);
  await postRegistry.waitForDeployment();
  const postRegistryAddress = await postRegistry.getAddress();
  console.log(`   ✅ PostRegistry deployed to: ${postRegistryAddress}`);

  console.log("\n3/4 Deploying FollowRegistry...");
  const FollowRegistry = await hre.ethers.getContractFactory("FollowRegistry");
  const followRegistry = await FollowRegistry.deploy(userRegistryAddress);
  await followRegistry.waitForDeployment();
  const followRegistryAddress = await followRegistry.getAddress();
  console.log(`   ✅ FollowRegistry deployed to: ${followRegistryAddress}`);

  console.log("\n4/4 Deploying Voting...");
  const Voting = await hre.ethers.getContractFactory("Voting");
  const voting = await Voting.deploy(userRegistryAddress);
  await voting.waitForDeployment();
  const votingAddress = await voting.getAddress();
  console.log(`   ✅ Voting deployed to: ${votingAddress}`);

  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT COMPLETE");
  console.log("=".repeat(60));
  console.log(`  UserRegistry:   ${userRegistryAddress}`);
  console.log(`  PostRegistry:   ${postRegistryAddress}`);
  console.log(`  FollowRegistry: ${followRegistryAddress}`);
  console.log(`  Voting:         ${votingAddress}`);

  const deploymentsPath = path.join(__dirname, "../../deployments.json");
  let deployments = {};
  if (fs.existsSync(deploymentsPath)) {
    deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
  }

  const network = hre.network;
  const networkName =
    network.name === "polkadotAssetHub"
      ? "polkadot-asset-hub-testnet"
      : network.name === "hardhat"
      ? "local-hardhat"
      : network.name;

  let friendlyName = "Local Network";
  if (network.name === "polkadotAssetHub") {
    friendlyName = "Polkadot Asset Hub Testnet";
  } else if (network.name === "hardhat") {
    friendlyName = "Local Hardhat Network";
  }

  deployments[networkName] = {
    network: friendlyName,
    chainId: network.config.chainId || 0,
    rpcUrl: network.config.url || "http://127.0.0.1:8545",
    userRegistry: userRegistryAddress,
    postRegistry: postRegistryAddress,
    followRegistry: followRegistryAddress,
    voting: votingAddress,
    deployedAt: new Date().toISOString(),
  };

  fs.writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2));
  console.log(`\n✅ Deployment info saved to: deployments.json (${networkName})`);

  // The frontend reads addresses from its own public/ copy. Guarded rather than assumed: the
  // Products-platform bundle may not keep that path.
  const frontendDeploymentsPath = path.join(__dirname, "../../frontend/public/deployments.json");
  if (fs.existsSync(path.dirname(frontendDeploymentsPath))) {
    fs.writeFileSync(frontendDeploymentsPath, JSON.stringify(deployments, null, 2));
    console.log("✅ Copied to frontend/public/deployments.json");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
