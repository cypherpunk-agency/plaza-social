// Contract factories. ⭐ READS GO THROUGH THE SDK; THERE IS NO WRITE FACTORY ANY MORE.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHAT WAS REMOVED, 2026-07-31, AND WHY
//
// This file used to hand every feature hook an `ethers.Contract` bound to an
// `ethers.JsonRpcProvider` pointed at `https://paseo-assethub-rpc.laissez-faire.trade` — a
// third-party HTTP origin, built for every visitor before the container check even ran. Board heads,
// profiles, vote tallies, the follow graph, the 30-second poll on every list and every
// read-after-write confirmation loop went through it, and inside the host container the user gets
// prompted about an external origin exactly as they were prompted about the IPFS gateways.
// `gotchas.md` § *THE SDK PATH IS THE ONLY PATH* — and the tell is always the same: a second
// implementation of something the platform already provides.
//
// The replacement is `lib/host/types.ts` `ChainReader`, backed by `@parity/product-sdk-contracts`
// `.query()`. Nothing in THIS file imports the SDK: it is handed a reader and does two jobs the SDK
// deliberately does not do — pick the method off the ABI, and normalise the decoded result.
//
// ⛔ AND OUTSIDE THE HOST THERE IS NO READER, SO THERE ARE NO CHAIN READS. That is the honest
// consequence and it is reported, not routed around: `capabilities.canRead` is false, the `chain`
// diagnostics step says why, and `SessionStatus` shows the header error. Local development uses
// `?backend=fake`.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// EARLIER REMOVALS, KEPT BECAUSE THEY ARE THE SAME LESSON
//
//   · `createWriteContract` fished a signer out of `provider.getSigner()` when none was supplied —
//     the MetaMask path, which architecture.md §1 deletes. Silently reaching into the environment
//     for a signer is how the browser-wallet path survived the decision to delete it.
//   · `isBrowserProvider` existed only to choose that branch.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

import type { AbiEntry, ChainReader } from '../lib/host/types';

/**
 * ⚠️ THE NAME IS KEPT ON PURPOSE, AND IT IS NO LONGER AN ETHERS PROVIDER.
 *
 * A dozen presentation components declare `provider: Provider | null` and do nothing with it but
 * pass it down (verified: not one of them calls a method on it). Renaming the type would have meant
 * editing every one of them to change a word; re-pointing it means they keep compiling and the
 * change stays inside the data layer, where it belongs. New code should say `ChainReader`.
 */
export type Provider = ChainReader;

/**
 * ⛔ THERE IS NO SIGNER IN THIS APP ANY MORE, AND THIS TYPE IS A GRAVESTONE.
 *
 * `SignerSeam.delegateSigner` — an `ethers.Wallet` broadcasting to a public RPC — was removed
 * 2026-07-31; see `lib/host/types.ts` `SignerSeam` for the two independent reasons it could never
 * have worked. Contract writes go through `HostBackend.writeContract`.
 *
 * The alias survives only because ~10 components declare a `signer?: Signer | null` prop and pass
 * it through; they now all receive `null`. It is a TYPE-ONLY import, so no ethers signing code is
 * pulled into the bundle by it. ⛔ Do not use it to reintroduce an ethers signing arm.
 */
export type Signer = never;

/**
 * A read-only contract handle.
 *
 * Shaped like the `ethers.Contract` it replaced — `contract.method(...args)` returning a promise —
 * because sixteen call sites across seven hooks read that way and rewriting them all in the same
 * change as re-pointing the transport would have made a transport bug and a decoding bug
 * indistinguishable.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- a decoded ABI value is genuinely `any`;
   narrowing it here would just move the cast to sixteen call sites. */
export type ReadContract = Record<string, (...args: any[]) => Promise<any>>;
/* eslint-enable @typescript-eslint/no-explicit-any */

interface AbiFunction {
  type?: string;
  name?: string;
  outputs?: Array<{ name?: string; type?: string }>;
}

/**
 * Normalise what the SDK decoded into what the call sites expect.
 *
 * ⭐ THE ONE CASE THAT MATTERS: A FUNCTION WITH SEVERAL RETURN VALUES.
 *
 * `product-sdk-contracts` decodes through viem and, for `outputs.length > 1`, hands back an OBJECT
 * keyed by output name (`{ refs, total }`). ethers handed back a `Result`, which subclasses Array
 * and therefore supports BOTH `const [refs] = …` and `.refs`. Every multi-output call site in this
 * app destructures positionally:
 *
 *     const [refs]              = await contract.getHeadsPaged(FORUM_REGISTRY, 0, 50)
 *     const [upvotes, downvotes] = await contract.getTally(entityId)
 *
 * A bare object silently makes `refs` `undefined`, which reads as an empty board rather than as a
 * decoding change. So the array is rebuilt IN ABI ORDER and the names are re-attached, which keeps
 * both spellings working.
 *
 * Single-output functions pass through untouched — including structs, which viem already decodes to
 * an object with named fields (`head.cid`, `profile.exists`), and arrays of structs (`getLinks`).
 * `uint64` and larger arrive as `bigint`, so `ref.movedAt > 0n` still means what it says.
 */
export function normaliseCallResult(entry: AbiFunction | undefined, value: unknown): unknown {
  const outputs = entry?.outputs ?? [];
  if (outputs.length <= 1) return value;
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  const ordered = outputs.map((output, i) => record[output.name || `_${i}`]);
  // Named access as well, so `.refs` / `.total` keep working for anyone who prefers them.
  outputs.forEach((output, i) => {
    if (output.name) Object.defineProperty(ordered, output.name, { value: ordered[i], enumerable: false });
  });
  return ordered;
}

/**
 * A read-only contract instance over the SDK chain reader.
 *
 * `null` in, `null` out: no address or no reader means no contract, and every caller already treats
 * that as "not ready" rather than as an error. ⚠️ THAT NULL IS ALSO THE OUT-OF-HOST STATE now — it
 * is what stops a browser tab from pretending it has chain data.
 *
 * ⚠️ Methods are materialised FROM THE ABI, not proxied blindly. Calling something the ABI does not
 * have therefore fails as `contract.getThreadCount is not a function`, in JS, immediately — which is
 * the friendliest of the four disguises of this codebase's most common bug (`frontend/CLAUDE.md`:
 * "a call naming a function the target does not have"). A catch-all proxy would have turned it into
 * a chain error instead, which is how three of the other four wasted time.
 */
export function createReadContract(
  address: string | null,
  abi: unknown,
  reader: Provider | null
): ReadContract | null {
  if (!address || !reader) return null;

  const entries = (Array.isArray(abi) ? abi : []) as AbiFunction[];
  const contract: ReadContract = {};

  for (const entry of entries) {
    if (entry?.type !== 'function' || !entry.name) continue;
    const name = entry.name;
    // Overloads would collide here. Our four ABIs have none; if one ever appears, the last wins and
    // that is worth knowing rather than silently discovering.
    contract[name] = async (...args: unknown[]) =>
      normaliseCallResult(entry, await reader.read(address, entries as AbiEntry[], name, args));
  }

  return contract;
}

/**
 * ⛔ ALWAYS RETURNS `null`. THIS IS NOT A BUG AND IT IS NOT A STUB TO FILL IN.
 *
 * There is no ethers signing arm any more (see `Signer` above). It survives as a function, rather
 * than being deleted outright, for exactly one reason: `hooks/useChannel.ts` and
 * `hooks/useChannelRegistry.ts` are the un-migrated chat hooks — **zero importers, unreachable from
 * the UI** — and they call it in nine places. Deleting it would mean rewriting two files that are
 * about to be rewritten anyway by the chat migration, in a change that has nothing to do with chat.
 *
 * Returning `null` is the honest answer and it lands where those call sites already handle it: every
 * one of them does `if (!contract) throw new Error("Contract not available")`. ⛔ Do NOT "restore"
 * this by handing back a contract bound to a locally-derived key — that is precisely the
 * unfunded-delegate path that produced `code 1012`.
 */
/* eslint-disable @typescript-eslint/no-unused-vars -- the parameters exist to keep nine call sites
   in the two un-migrated chat hooks compiling; nothing reads them, and that is the whole point. */
export async function createWriteContract(
  _address: string | null,
  _abi: unknown,
  _reader: Provider | null,
  _externalSigner: Signer | null
): Promise<ReadContract | null> {
  return null;
}
/* eslint-enable @typescript-eslint/no-unused-vars */
