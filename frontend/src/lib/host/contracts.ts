// Contract ACCESS through the SDK — the host-signed write arm, and the only chain READ path.
//
// ⭐ READS LIVE HERE TOO, SINCE 2026-07-31, AND THAT IS THE WHOLE POINT OF THE FILE.
//
// Until then every contract read went through `new ethers.JsonRpcProvider('https://paseo-assethub-
// rpc.laissez-faire.trade')` — a third-party origin, neither Parity's nor the community
// foundation's, built BEFORE the container check and therefore for every visitor. Board heads,
// profiles, vote tallies, the follow graph, the 30-second poll on every list and every
// read-after-write confirmation loop were external-origin HTTP, and the host prompts about those
// exactly as it prompted about the IPFS gateways. `gotchas.md` § *THE SDK PATH IS THE ONLY PATH*.
//
// The native path was already here, proven, and used for writes. `.query()` is the same
// `createContract` handle's other method — a `ReviveApi.call` dry run, needing no account (origin
// resolution ends in a "pallet-revive account fallback"), defaulting to `at: "best"` "so `.query()`
// reads observe the same state as `.tx()`".
//
// ⚠️ ONE CHAIN CLIENT FOR THE WHOLE SESSION, SHARED BY READS AND WRITES. `createChainClient` opens a
// chainHead subscription; three modules building their own (the writer, the reader, and
// `session.ts`'s `resolveRecipient`) would open three, on a phone, for one chain. `assetHub()` below
// is the single memoised accessor and everything goes through it.
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
import type { AbiEntry, ChainReader } from './types'
import { describe, TIMEOUTS, withTimeout } from './util'

export type ChainEnvironment = 'devnet' | 'paseo' | 'polkadot' | 'kusama'

/**
 * ⚠️ TYPED LOOSELY ON PURPOSE. The `@parity/*` bindings are `any` until someone removes the
 * `@ts-ignore`s in `sdk.ts`, so a precise interface here would be fiction — and the one thing worth
 * pinning is already pinned by a comment in `sdk.ts`: `.raw.<name>` is the `PolkadotClient` the
 * contracts layer wants, `.<name>` is the typed API, and there is NO `.descriptors`.
 */
interface AssetHub {
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  client: { raw: Record<string, any>; [chain: string]: any }
  descriptor: unknown
}

/**
 * The ONE Asset Hub client, per environment, created on first use.
 *
 * ⚠️ `createChainClient({ chains: { assetHub } })`, NOT `getChainAPI(env)`. The latter's preset table
 * statically references polkadot/kusama/paseo metadata and pulls megabytes of chunks into a bundle
 * that gets uploaded to Bulletin. We need exactly one chain.
 *
 * ⚠️ LAZY, AND THAT MATTERS MORE NOW THAT READS USE IT. It connects through the host, so building it
 * eagerly would open a connection before anything has asked to read — and would do it on the load
 * path, where a hang is least explicable.
 */
const clients = new Map<string, Promise<AssetHub>>()

export function assetHub(environment: ChainEnvironment = 'devnet'): Promise<AssetHub> {
  let pending = clients.get(environment)
  if (!pending) {
    pending = (async () => {
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
    })()
    clients.set(environment, pending)
  }
  return pending
}

/** ⚠️ TESTS AND TEARDOWN ONLY. A live page has exactly one host and wants exactly one client. */
export function resetAssetHubClients(): void {
  clients.clear()
}

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
  environment?: ChainEnvironment
  onStep?: (status: 'running' | 'ok' | 'fail', detail: string) => void
}

/**
 * ⭐ THE CHAIN READER. Every `getHeadsPaged`, `getProfile`, `getTally` and `getFollowing` in the app
 * ends up here.
 *
 * ⚠️ IT TAKES NO SIGNER AND NO ORIGIN, DELIBERATELY. An anonymous reader inside the host must get a
 * full timeline, and `.query()`'s origin resolution ends in a pallet-revive account fallback, so
 * passing one would only narrow what works.
 *
 * ⚠️ AND IT THROWS. `QueryResult` is `{ success, value, gasRequired }` — NOT a `@parity/result`, so
 * do not reach for `unwrapParity` here (see `util.ts` for why mixing the two is a silent total bug).
 * On `success: false` the runtime's own dispatch-error payload is in `value`, which is the only
 * thing that distinguishes "the contract reverted" from "this address has no such function" — the
 * single most common failure in this codebase (`frontend/CLAUDE.md`, four disguises). It is put into
 * the message verbatim rather than summarised away.
 */
export function createSdkChainReader(options: {
  environment?: ChainEnvironment
  /** Reported per read, throttled by the caller — see `session.ts`. */
  onRead?: (ok: boolean, detail: string) => void
}): ChainReader {
  const environment = options.environment ?? 'devnet'

  /** One contract handle per address, so a poll does not rebuild the viem/ABI machinery every tick. */
  const handles = new Map<string, Promise<Record<string, { query?: (...a: unknown[]) => unknown }>>>()

  const handle = (address: string, abi: AbiEntry[]) => {
    const key = address.toLowerCase()
    let pending = handles.get(key)
    if (!pending) {
      pending = (async () => {
        const [contracts, { client, descriptor }] = await Promise.all([loadContracts(), assetHub(environment)])
        const runtime = contracts.createContractRuntimeFromClient(client.raw.assetHub, descriptor)
        return contracts.createContract(runtime, address, abi) as Record<
          string,
          { query?: (...a: unknown[]) => unknown }
        >
      })()
      handles.set(key, pending)
    }
    return pending
  }

  return {
    label: `host asset-hub (${environment})`,

    async read(address, abi, method, args) {
      const label = `${method} on ${address.slice(0, 10)}…`
      const startedAt = Date.now()
      try {
        const contract = await handle(address, abi)
        const fn = contract?.[method]
        if (typeof fn?.query !== 'function') {
          // The tell for the bug that has appeared four times here: a call naming a function the
          // target does not have. Say so in those words rather than letting it read as a chain error.
          throw new Error(`the ABI has no readable method "${method}"`)
        }
        const result = (await withTimeout(
          Promise.resolve(fn.query(...args)),
          TIMEOUTS.read,
          label,
        )) as { success?: boolean; value?: unknown }

        if (result?.success !== true) {
          throw new Error(
            `${method} reverted or could not be dry-run: ${describe(result?.value) || 'no detail'}`,
          )
        }
        options.onRead?.(true, `${label} · ${Date.now() - startedAt} ms`)
        return result.value
      } catch (error) {
        options.onRead?.(false, `${label} · ${describe(error)}`)
        throw error instanceof Error ? error : new Error(describe(error))
      }
    },
  }
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

  return {
    async write(address, abi, method, args, label) {
      options.onStep?.('running', label)
      try {
        // The SAME client the reader uses — see `assetHub()`. Sharing it is also what makes the
        // read-after-write poll meaningful: both sides observe the same chainHead at `best`.
        const [contracts, { client, descriptor }] = await Promise.all([
          loadContracts(),
          assetHub(environment),
        ])

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
