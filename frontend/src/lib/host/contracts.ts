// Host-signed contract writes — arm 1's caller.
//
// ⭐ WHY THIS EXISTS. Some contract calls CANNOT be signed by the delegate key, for two independent
// reasons, and profile creation hits both:
//
//   1. **Attribution.** `UserRegistry.createProfile` records `msg.sender` as the owner. Signed by the
//      delegate that creates a profile owned by a throwaway per-device key rather than by the user,
//      and `UserRegistry` deliberately has no `createProfileFor` — owner-only operations are
//      owner-only on purpose (see contracts/CLAUDE.md).
//   2. **Funding.** The delegate is a locally derived H160 that nobody funds. Sending from it produced
//      exactly this, observed 2026-07-30:
//        code 1012 "Transaction is temporarily banned"  (balance 0.0, nonce 0)
//      The node rejects the unfunded transaction and the txpool then BANS its hash for a while, so
//      retrying looks like a different, more mysterious failure than "no money".
//
// So these calls go through the product account, signed by the host.
//
// ⚠️ THIS IS NOT ETHERS, AND CANNOT BE. The host signs native `Revive` extrinsics; there is no
// `eth_sendTransaction` it will answer. `@parity/product-sdk-contracts` builds the extrinsic and
// `.tx()` signs and watches it with the host signer.
//
// ⚠️ Asset Hub IS reachable through the host bridge even when Bulletin is not. A host in
// `rpc-gateway` chain-backend mode supports exactly relay + Asset Hub + People — which is why Bulletin
// writes need the preimage fallback (see `session.ts` `putBlob`) while contract writes are fine here.

import { loadAssetHubDescriptor, loadChainClient, loadContracts } from './sdk'
import { describe, TIMEOUTS, withTimeout } from './util'

/** Minimal shape of one ABI entry. Deliberately loose — the ABI is loaded from JSON. */
type AbiEntry = Record<string, unknown>

export interface HostContractWriter {
  /**
   * Call `method(...args)` on `address`, signed by the product account.
   *
   * @param label human-readable, for diagnostics — e.g. "createProfile".
   * @returns the transaction hash. ⚠️ A SUBSTRATE EXTRINSIC HASH, not an Ethereum one: do not feed it
   *   to `eth_getTransactionReceipt`, and do not expect the call's events in the ETH log index.
   */
  write(
    address: string,
    abi: AbiEntry[],
    method: string,
    args: unknown[],
    label: string,
  ): Promise<{ txHash: string }>
}

export interface HostContractWriterOptions {
  /** The host signer from `SignerManager.getSigner()`. Opaque. */
  signer: unknown
  /** The product account's SS58 address — the origin the contract will see as `msg.sender`. */
  origin: string
  /** Which environment's Asset Hub descriptor to use. */
  environment?: 'devnet' | 'paseo' | 'polkadot' | 'kusama'
  onStep?: (status: 'running' | 'ok' | 'fail', detail: string) => void
}

/**
 * Build a writer, or return null when one cannot exist (no signer, no account, SDK absent).
 *
 * Null is a legitimate state and callers must handle it — it means "host-signed writes are
 * unavailable", which is exactly what a read-only session is. It must never be a thrown error.
 */
export function createHostContractWriter(
  options: HostContractWriterOptions,
): HostContractWriter | null {
  if (!options.signer || !options.origin) return null

  const environment = options.environment ?? 'devnet'

  /**
   * One client for the whole session, created on the FIRST WRITE — it connects through the host, so
   * building it eagerly would open a connection a read-only session never needs.
   *
   * ⚠️ `createChainClient({ chains: { assetHub } })`, NOT `getChainAPI(env)`. The latter's preset
   * table statically references polkadot/kusama/paseo metadata and pulls megabytes of chunks into a
   * bundle that gets uploaded to Bulletin. We need exactly one chain.
   */
  let chainPromise: Promise<{ client: { raw: Record<string, unknown> }; descriptor: unknown }> | null =
    null
  const chain = () =>
    (chainPromise ??= (async () => {
      const [mod, descriptor] = await Promise.all([
        loadChainClient(),
        loadAssetHubDescriptor(environment),
      ])
      // Guarded explicitly: an undefined descriptor becomes a WeakMap key inside the contracts layer
      // and throws `Invalid value used as weak map key`, which names nothing and points nowhere.
      if (!descriptor || typeof descriptor !== 'object') {
        throw new Error(`the Asset Hub descriptor for "${environment}" did not load`)
      }
      const client = await mod.createChainClient({ chains: { assetHub: descriptor } })
      return { client, descriptor }
    })())

  return {
    async write(address, abi, method, args, label) {
      options.onStep?.('running', label)
      try {
        const [contracts, { client, descriptor }] = await Promise.all([loadContracts(), chain()])

        const contract = contracts.createContractFromClient(
          client.raw.assetHub,
          descriptor,
          address,
          abi,
          { defaultSigner: options.signer, defaultOrigin: options.origin },
        )

        const fn = contract?.[method]
        if (!fn?.tx) throw new Error(`the ABI has no method "${method}"`)

        const result = await withTimeout(
          Promise.resolve(fn.tx(...args)),
          TIMEOUTS.write,
          label,
        )

        // A `@parity/result` — branch on `.ok`, never on truthiness. `product-sdk-contracts` returns
        // this shape while `AccountsProvider` returns neverthrow; mixing them is a silent total bug.
        const r = result as { ok?: boolean; value?: { txHash?: unknown }; error?: unknown }
        if (r?.ok === false) throw new Error(describe(r.error))

        const txHash =
          typeof r?.value?.txHash === 'string'
            ? r.value.txHash
            : typeof (result as { txHash?: unknown })?.txHash === 'string'
              ? (result as { txHash: string }).txHash
              : null
        if (!txHash) throw new Error('the host reported no transaction hash')

        options.onStep?.('ok', `${label} · ${txHash}`)
        return { txHash }
      } catch (error) {
        options.onStep?.('fail', `${label} · ${describe(error)}`)
        throw error instanceof Error ? error : new Error(describe(error))
      }
    },
  }
}
