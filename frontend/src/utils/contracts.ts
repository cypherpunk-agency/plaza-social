import { ethers } from 'ethers';

// Contract factories, host-only.
//
// WHAT WAS REMOVED AND WHY. This file used to carry the wallet-mode fork:
//
//   · `createWriteContract` took a `provider` and, when no external signer was supplied, called
//     `provider.getSigner()` to fish a signer out of MetaMask. That was the browser-wallet path, and
//     architecture.md §1 deletes it — the host container is the only surface.
//   · `isBrowserProvider` existed solely to decide which branch to take. Nothing else used it.
//   · The `externalSigner instanceof ethers.Wallet` special case connected a standalone in-app wallet
//     to a provider. The delegate signer arrives already connected (see `lib/host/delegate.ts`), so
//     there is nothing to reconnect.
//
// ⚠️ A SIGNER IS NOW ALWAYS EXPLICIT. `createWriteContract` returns `null` rather than reaching into
// the environment for one, because there is nowhere left to reach: the two arms of the signer seam are
// the derived delegate key (an ordinary `ethers.Signer`) and the host, which signs native Revive
// extrinsics and therefore cannot be an `ethers.Signer` at all. Silently falling back to "whatever is
// in the page" is how the browser-wallet path survived the decision to delete it.

export type Provider = ethers.JsonRpcProvider | ethers.Provider;
export type Signer = ethers.Signer;

/**
 * A read-only contract instance. Needs no wallet, no container and no permission — which is why the
 * whole app can render for a visitor who has nothing.
 */
export function createReadContract(
  address: string | null,
  abi: ethers.InterfaceAbi,
  provider: Provider | null
): ethers.Contract | null {
  if (!address || !provider) return null;
  return new ethers.Contract(address, abi, provider);
}

/**
 * A contract instance for writing.
 *
 * `externalSigner` is the delegate arm of the signer seam
 * (`useHostSession().signer.delegateSigner`). `null` in, `null` out: no signer means no write, and
 * the caller must present that as a capability (`capabilities.reason`) rather than as an error.
 *
 * ⚠️ THE SIGNATURE AND THE `Promise` ARE KEPT DELIBERATELY, even though nothing in here is
 * asynchronous any more. Sixteen feature hooks call this as
 * `await createWriteContract(addr, ABI, provider, signer)` and they are scheduled for migration onto
 * the seam AFTER the contract interface and Bulletin data layer land. Changing the shape now would
 * mean touching all sixteen twice. When they are migrated, drop the `async` and reorder at will.
 *
 * `provider` is used only when the signer is not already bound to one. The delegate signer normally
 * is, so that is a safety net rather than the usual path.
 */
export async function createWriteContract(
  address: string | null,
  abi: ethers.InterfaceAbi,
  provider: Provider | null,
  externalSigner: Signer | null
): Promise<ethers.Contract | null> {
  if (!address || !externalSigner) return null;
  const bound = externalSigner.provider
    ? externalSigner
    : provider
      ? externalSigner.connect(provider)
      : externalSigner;
  return new ethers.Contract(address, abi, bound);
}
