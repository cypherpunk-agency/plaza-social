// Places UserRegistry at the address that PostRegistry, Voting and FollowRegistry pin.
//
// Those three name the registry as a compile-time constant because `cdm deploy` cannot pass
// constructor arguments (see PostRegistry.sol's `userRegistry` docstring). That makes them
// undeployable in a test until UserRegistry's code exists at exactly that address, so this puts it
// there with `hardhat_setCode`.
//
// This is sound rather than a hack: **UserRegistry has no constructor**, so runtime code plus empty
// storage is indistinguishable from a fresh deploy. If UserRegistry ever gains constructor state,
// this helper becomes a lie and the tests will pass while production differs — add the state here
// explicitly at that point, or stop pinning.
//
// Bonus: tests now exercise the same wiring production uses, including the constructor's
// code-presence guard, instead of a shape that only exists in tests.

import hre from "hardhat";
const { ethers, network } = hre;

/** Must equal `USER_REGISTRY_ADDRESS` in all three contracts — grep PLAZA-USER-REGISTRY-ADDRESS. */
export const PINNED_USER_REGISTRY = "0xfD00289e765414C0281EFC35335b6453F055FBD7";

/**
 * Deploy UserRegistry and mirror its code to the pinned address.
 * @returns the UserRegistry handle bound to `PINNED_USER_REGISTRY`
 */
export async function deployPinnedUserRegistry() {
  // ⚠️ RESET FIRST. `hardhat_setCode` replaces code but leaves STORAGE at that address untouched,
  // and a fixed address is the same address in every test — so profiles created in one test are
  // still there in the next and `createProfile` reverts with `ProfileExists`. That looked like a
  // contract bug for a minute; it is test-state leakage that only a pinned address can produce.
  await network.provider.send("hardhat_reset", []);

  const factory = await ethers.getContractFactory("UserRegistry");
  const deployed = await factory.deploy();
  await deployed.waitForDeployment();

  const code = await ethers.provider.getCode(await deployed.getAddress());
  if (code === "0x") throw new Error("UserRegistry deployed with no code — cannot mirror it");
  await network.provider.send("hardhat_setCode", [PINNED_USER_REGISTRY, code]);

  // Guard the guard: if this ever silently no-ops, every dependent constructor would revert with
  // UserRegistryNotDeployed and the cause would not be obvious from the failure.
  const mirrored = await ethers.provider.getCode(PINNED_USER_REGISTRY);
  if (mirrored !== code) throw new Error("hardhat_setCode did not take at " + PINNED_USER_REGISTRY);

  return ethers.getContractAt("UserRegistry", PINNED_USER_REGISTRY);
}
