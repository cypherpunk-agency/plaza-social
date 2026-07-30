import { ethers } from "ethers";
const p = new ethers.JsonRpcProvider("https://paseo-assethub-rpc.laissez-faire.trade", 420420417);
const EXPECT = "0xfD00289e765414C0281EFC35335b6453F055FBD7";
const targets = {
  UserRegistry:   "0xfD00289e765414C0281EFC35335b6453F055FBD7",
  PostRegistry:   "0xF6daC4BC4e721c5C84504A5Bfe033AE63722f8c9",
  Voting:         "0x948c71E7134E82c8d71e1bAD781F5BD4B96A14C0",
  FollowRegistry: "0x96A3274Fa3696bbF5F8e1D8B58455300B9b7032E",
};
const abi = ["function userRegistry() view returns (address)"];
for (const [name, addr] of Object.entries(targets)) {
  const code = await p.getCode(addr);
  let pin = "n/a";
  if (name !== "UserRegistry") {
    try { pin = await new ethers.Contract(addr, abi, p).userRegistry(); } catch (e) { pin = "ERR " + e.shortMessage; }
  }
  const ok = name === "UserRegistry" ? code !== "0x" : pin.toLowerCase() === EXPECT.toLowerCase();
  console.log(`${name.padEnd(15)} ${addr}  code=${((code.length - 2) / 2 / 1024).toFixed(1)}KB  pin=${pin}  ${ok ? "✓" : "✗"}`);
}
// A real read through each contract, anonymously — proves the code runs, not just that it exists.
const pr = new ethers.Contract(targets.PostRegistry, ["function writerCount(bytes32) view returns (uint256)"], p);
const vt = new ethers.Contract(targets.Voting, ["function getScore(bytes32) view returns (int256)"], p);
const fr = new ethers.Contract(targets.FollowRegistry, ["function isFollowing(address,address) view returns (bool)"], p);
const ROOM = ethers.keccak256(ethers.toUtf8Bytes("room:general"));
console.log("\nanonymous reads:");
console.log("  PostRegistry.writerCount(room:general) =", await pr.writerCount(ROOM));
console.log("  Voting.getScore(0x00…) =", await vt.getScore(ethers.ZeroHash));
console.log("  FollowRegistry.isFollowing(a,b) =", await fr.isFollowing(EXPECT, targets.Voting));
