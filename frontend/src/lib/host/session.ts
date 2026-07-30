// The real host backend: container handshake, account resolution, signer acquisition, Bulletin.
//
// Nothing in here can be exercised from a development machine — the host channel, the statement
// store and `deriveEntropy` are container-only. That is why every step reports into the diagnostics
// record and every host call has a timeout: the diagnostics panel is the only debugger we get, and a
// hung host call on a phone is the worst failure mode available to us.
//
// It is also why `fake.ts` exists and is REQUIRED infrastructure rather than a nicety: the SDK throws
// outside a container, so without it there is no localhost development at all. (An earlier version of
// this line added "and publishing is personhood-gated at 1/day on Lite". That was FALSE — several
// deploys an hour work fine. Iterate locally because it is faster, not because deploys are scarce.)
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THREE FINDINGS SHAPE THIS FILE, AND NONE OF THEM IS OBVIOUS FROM THE SDK'S TYPES.
//
// 1. `ChainSubmit` MUST BE REQUESTED EXPLICITLY, AND FIRST. Without it the host SILENTLY rejects
//    every signing request and the UI hangs for ever. It and `GetUserId` are the ONLY permissions
//    this host actually enforces.
//
// 2. ⚠️ CORRECTED 2026-07-30 — `PreimageSubmit` IS REQUESTED, AND MUST BE. This block used to read
//    "`StatementSubmit` AND `PreimageSubmit` ARE NOT REQUESTED. DO NOT ADD THEM", justified by
//    grepping the deployed host bundle for `$(t,'PreimageSubmit')`. That grep looked one layer too
//    low: the TruAPI sandbox gates `remote_preimage_submit` on the flag. It matters because the
//    preimage channel is the ONLY Bulletin write path on a host in `rpc-gateway` chain-backend mode
//    (see `putBlob`), so a missing grant is silently fatal to posting. `StatementSubmit` remains
//    unrequested — statements are live-update-only and never gate a write.
//
// 3. NO ALLOWANCE IS REQUESTED HERE, AND THAT IS THE POINT. This is the load path; a reader who
//    never posts must never see an allowance dialog. See `allowance.ts`.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import { ethers } from 'ethers'

import { createAllowanceGate } from './allowance'
import { createCapabilityStore, READ_ONLY } from './capabilities'
import { insideContainer, productIdentifier } from './container'
import { createHostContractWriter } from './contracts'
import { createDelegate } from './delegate'
import { createDiagnostics } from './diagnostics'
import { loadCloudStorage, loadHost, loadStatementStore, loadTx, loadWallet, sdkAvailable } from './sdk'
import type { HostAccount, HostBackend, PutBlobOptions, SignerSeam } from './types'
import { describe, TIMEOUTS, unwrapParity, withTimeout, type ParityResult } from './util'

export interface HostSessionOptions {
  /** Product/topic name the statement store publishes under. */
  appName: string
  /** ETH-RPC endpoint for anonymous reads. Reads never touch the host. */
  rpcUrl: string
  /**
   * Which Bulletin network preset to use.
   *
   * ⚠️ EXPLICIT NETWORK FORM, NOT `environment: 'devnet'`. The shorthand resolves through
   * `getChainAPI()`, whose preset table statically references polkadot/kusama/paseo metadata and
   * drags megabytes of chunks into a bundle we then upload to Bulletin and never load.
   */
  bulletinNetwork?: 'devnet' | 'paseo' | 'polkadot' | 'kusama'
}

/**
 * Open a session against the real host container.
 *
 * ⚠️ IT NEVER THROWS AND IT NEVER RETURNS `null`. A failed wallet is a CAPABILITY, not an exception:
 * the app must still come up read-only when the host refuses, because reading is the majority of
 * what anyone does here and it needs no wallet at all. Every failure lands in diagnostics and in
 * `capabilities().reason`.
 */
export async function openHostSession(options: HostSessionOptions): Promise<HostBackend> {
  const diag = createDiagnostics()
  const capabilities = createCapabilityStore(READ_ONLY)

  /* -- reads, first and unconditionally ------------------------------------ */
  // Built before anything host-shaped is touched, so a total host failure still leaves a readable
  // app. This provider is anonymous: no wallet, no container, no permission.
  let provider: ethers.JsonRpcProvider | null = null
  try {
    provider = new ethers.JsonRpcProvider(options.rpcUrl)
    diag.step('chain', 'ok', options.rpcUrl)
  } catch (error) {
    diag.step('chain', 'fail', describe(error))
  }

  const delegate = createDelegate({ diagnostics: diag, provider: () => provider })

  let account: HostAccount | null = null
  // Typed loosely on purpose: the SDK bindings are `any` until the `@parity/*` packages are
  // installed (see `sdk.ts`), so a precise interface here would be fiction. What matters is that
  // every VALUE crossing out of these objects is unwrapped through a typed helper.
  type Connected = ParityResult<Array<{ address: string; h160Address?: string }>>
  let manager: {
    connect?: () => PromiseLike<Connected>
    selectAccount?: (a: string) => void
    getState?: () => { selectedAccount?: unknown }
    getSigner?: () => unknown
    destroy?: () => void
  } | null = null
  let hostSigner: unknown = null
  let storage: { store?: (b: Uint8Array) => { send: () => Promise<{ cid?: unknown; blockNumber?: unknown; extrinsicIndex?: unknown }> }; checkAuthorization?: (a: string) => Promise<unknown>; destroy?: () => void } | null = null
  let statements: { connect?: (o: unknown) => unknown; destroy?: () => void } | null = null
  /**
   * The host preimage channel — the Bulletin write path that works when the chain bridge will not
   * open a Bulletin client at all. See the long note in `putBlob`. Kept separate from `storage`
   * because `canWrite` must be true when EITHER exists.
   */
  let preimages: { submit?: (bytes: Uint8Array) => Promise<unknown> } | null = null

  const allowance = createAllowanceGate({
    address: () => capabilities.get().address,
    diagnostics: diag,
  })

  /* -- container ------------------------------------------------------------ */
  // ⚠️ `insideContainer()` wraps `isInsideContainerSync`, NOT `isInsideContainer`. The async one
  // returns a Promise, a Promise is always truthy, and `isInsideContainer() ? a : b` therefore
  // silently always picks `a` with no type error. See `container.ts`.
  const hasSdk = await sdkAvailable()
  const inside = hasSdk && (await insideContainer())
  diag.step(
    'container',
    inside ? 'ok' : 'skip',
    inside
      ? `identifier ${productIdentifier()}`
      : hasSdk
        ? 'not running inside the Polkadot app — reading works, posting does not'
        : 'the Products SDK is not installed in this build',
  )
  diag.step('sdk', hasSdk ? 'ok' : 'skip', hasSdk ? productIdentifier() : 'not installed')

  if (!inside) {
    capabilities.set({
      canRead: !!provider,
      canWrite: false,
      canPushLive: false,
      address: null,
      insideHost: false,
      reason:
        'Plaza posts through the Polkadot app. Open it from there to write; reading works anywhere. ' +
        'For local development use ?backend=fake.',
    })
    return assemble()
  }

  /* -- wallet -------------------------------------------------------------- */
  diag.step('connect', 'running')
  try {
    const wallet = await loadWallet()
    manager = new wallet.SignerManager({
      dappName: options.appName,
      hostTimeout: TIMEOUTS.connect,
      /**
       * Fires on connect AND again after the SDK's automatic reconnect. It only CLEARS the
       * in-memory allowance latch — it never requests, so this stays off the load path and no
       * dialog appears here. See `allowance.ts` `reset()` for why that is the right amount of work.
       */
      onConnect: () => allowance.reset(),
    })
    // `SignerManager.connect()` returns a `@parity/result`, not a neverthrow ResultAsync. Unwrapped
    // at the boundary, in one place — see `util.ts` for why mixing the two is a silent, total bug.
    const accounts = unwrapParity<Array<{ address: string; h160Address?: string }>>(
      await withTimeout(Promise.resolve(manager!.connect!()), TIMEOUTS.connect, 'Wallet connect'),
      'Wallet connect',
    )
    if (accounts.length === 0) throw new Error('the host derived no account for this product')
    // The host may have a selection of its own; prefer it over "the first one we were handed".
    const selected =
      (manager!.getState?.().selectedAccount as { address: string; h160Address?: string } | undefined) ??
      accounts[0]
    manager!.selectAccount?.(selected.address)
    account = { address: selected.address, h160Address: selected.h160Address ?? null }
    hostSigner = manager!.getSigner?.() ?? null
    diag.step('connect', 'ok', `${accounts.length} account(s)`)
    diag.step(
      'account',
      'ok',
      account.h160Address ? `${account.address} · ${account.h160Address}` : account.address,
    )
  } catch (error) {
    diag.step('connect', 'fail', describe(error))
    try {
      manager?.destroy?.()
    } catch {
      /* ignore */
    }
    manager = null
    capabilities.set({
      canRead: !!provider,
      canWrite: false,
      canPushLive: false,
      address: null,
      // We ARE inside the host — the app just did not hand over an account.
      insideHost: true,
      // ⚠️ Was `Could not connect to a wallet: ${describe(error)}`, which put "Wallet connect timed
      // out after 20s" in front of a user as if it were advice. Two problems: it named a "wallet",
      // which does not exist in this paradigm, and it described a symptom instead of the one action
      // that fixes it. The raw error still appears verbatim in diagnostics, where it belongs.
      reason:
        'The Polkadot app did not hand over an account. Sign in to the Polkadot app, then reopen ' +
        'Plaza to start posting. Reading works in the meantime.',
    })
    return assemble()
  }

  /* -- permissions --------------------------------------------------------- */
  // Asked BY NAME and the answer READ, because a silently-missing permission does not fail — it
  // hangs, which is far harder to diagnose from a phone.
  diag.step('permChain', 'running')
  let canChain = false
  try {
    const host = await loadHost()
    const granted = unwrapParity<boolean>(
      await withTimeout(
        host.requestPermission({ tag: 'ChainSubmit', value: undefined }),
        TIMEOUTS.permission,
        'ChainSubmit permission',
      ),
      'ChainSubmit permission',
    )
    if (granted !== true) throw new Error('the host denied ChainSubmit')
    canChain = true
    diag.step('permChain', 'ok')
  } catch (error) {
    diag.step('permChain', 'fail', describe(error))
  }

  /**
   * `PreimageSubmit` — requested because the preimage channel is a REAL write path, not a curiosity.
   *
   * ⚠️ A previous comment here said this permission is never read by the host and must not be
   * requested. That was inherited from yolodot and its own later audit refutes it: the TruAPI sandbox
   * gates `remote_preimage_submit` on this flag, one layer above where the host bundle was grepped.
   * On a host in `rpc-gateway` chain-backend mode the preimage channel is the ONLY way to store a post
   * body, so a missing grant here would be silently fatal to posting.
   *
   * Non-fatal and never gates `canWrite`: the host may grant implicitly on first submission, and
   * refusing to try a write because a pre-flight probe looked discouraging is the mistake
   * `allowance.ts` exists to avoid. Expect a per-write "Submit Preimage" dialog regardless — yolodot
   * measured that as unconditional, which no grant suppresses.
   */
  diag.step('permPreimage', 'running')
  try {
    const host = await loadHost()
    const granted = unwrapParity<boolean>(
      await withTimeout(
        host.requestPermission({ tag: 'PreimageSubmit', value: undefined }),
        TIMEOUTS.permission,
        'PreimageSubmit permission',
      ),
      'PreimageSubmit permission',
    )
    diag.step(
      'permPreimage',
      granted === true ? 'ok' : 'skip',
      granted === true ? undefined : 'not granted — a write may still succeed, the host can grant late',
    )
  } catch (error) {
    diag.step('permPreimage', 'skip', describe(error))
  }

  /* -- allowance: DEFERRED ------------------------------------------------- */
  // Reading the persisted claim is safe here — it touches localStorage and never the host — and it
  // is worth reporting, because "will my first post open a dialog?" is the one question the panel is
  // expected to answer.
  diag.step('allowance', 'skip', allowance.describeDeferred())

  /* -- bulletin ------------------------------------------------------------ */
  //
  // ⚠️ THE HOST DECIDES WHICH BULLETIN CHAIN EXISTS, AND IT IS NOT ALWAYS THE ONE WE DEPLOYED TO.
  //
  // Observed on a real phone 2026-07-30, with everything else green (container, SDK, wallet, account,
  // ChainSubmit, statements, read provider, delegate all ok):
  //
  //   ChainNotSupportedError: Chain 0xe101f0fa4627d29a…760a59 is not supported by the current host.
  //
  // That hash is not drift — verified against both live chains the same day:
  //   CloudStorageNetworks.devnet = 0xe101f0fa… = "Bulletin Paseo"      (bulletin-paseo.tservices.es)
  //   CloudStorageNetworks.paseo  = 0x8cfe6717… = "Paseo Bulletin Next" (paseo-bulletin-next-rpc)
  // Both constants are correct and both chains are up. The host build simply had the OTHER one
  // enabled. Since `canWrite` hangs off `storage`, one unsupported chain turned a fully signed-in
  // session into a read-only one — and, worse, into a "posting needs the Polkadot app" message shown
  // to somebody already inside the Polkadot app.
  //
  // So: try the configured chain, then fall back to the other. We do not control the host build, and
  // a hardcoded single chain makes the app's writability depend on a deployment we cannot see. The
  // chain that wins is recorded in diagnostics, because "which Bulletin am I on?" then decides which
  // gateway can serve the content back.
  const preferredBulletin = options.bulletinNetwork ?? 'devnet'
  const bulletinCandidates = [
    preferredBulletin,
    ...(['devnet', 'paseo'] as const).filter((n) => n !== preferredBulletin),
  ]
  diag.step('bulletin', 'running')
  {
    const failures: string[] = []
    for (const network of bulletinCandidates) {
      try {
        const cloud = await loadCloudStorage()
        const networks = cloud.CloudStorageNetworks as Record<string, unknown>
        const config = networks[network] as object | undefined
        if (!config) {
          failures.push(`${network}: not in CloudStorageNetworks`)
          continue
        }
        storage = await withTimeout(
          cloud.CloudStorageClient.create({
            ...config,
            // The account may not be selected yet at construction time, so resolve per call.
            signer: cloud.createLazySigner(() => manager?.getSigner?.()),
          }),
          TIMEOUTS.statements,
          'Cloud storage connect',
        )
        diag.step(
          'bulletin',
          'ok',
          network === preferredBulletin
            ? `${network} via account authorization`
            : `${network} via account authorization — FELL BACK from ${preferredBulletin}, ` +
              `which this host build does not support (${failures.join('; ')})`,
        )
        break
      } catch (error) {
        failures.push(`${network}: ${describe(error)}`)
        storage = null
      }
    }
    if (!storage) diag.step('bulletin', 'fail', failures.join(' · '))
  }

  /* -- bulletin fallback: the host preimage channel ------------------------ */
  // Acquired ALWAYS, not only when `storage` is null: a CloudStorage client can construct and still
  // fail at `store()` time, and the fallback has to already be in hand by then. Non-fatal — a null
  // here just means one of the two write paths is missing.
  try {
    const host = await loadHost()
    preimages = (await host.getPreimageManager()) ?? null
    diag.step(
      'preimage',
      preimages?.submit ? 'ok' : 'skip',
      preimages?.submit
        ? 'available as the Bulletin fallback'
        : 'the host offered no preimage manager',
    )
  } catch (error) {
    preimages = null
    diag.step('preimage', 'skip', describe(error))
  }

  // Pre-flight quota. ⚠️ ADVISORY ONLY — IT NEVER GATES A WRITE. `store` does not hard-fail on the
  // byte quota (the counters saturate; an account 245 MB into a 100 MB allowance was observed still
  // storing), and the transaction count is the number that actually bites.
  if (storage?.checkAuthorization && account) {
    diag.step('bulletinAuth', 'running')
    try {
      const status = (await withTimeout(
        storage.checkAuthorization(account.address),
        TIMEOUTS.allowance,
        'Authorization check',
      )) as {
        ok?: boolean
        error?: unknown
        value?: { authorized?: boolean; remainingTransactions?: unknown; remainingBytes?: unknown; expiration?: unknown }
      }
      if (!status?.ok) {
        diag.step('bulletinAuth', 'skip', `${describe(status?.error)} — a write may still succeed`)
      } else if (!status.value?.authorized) {
        diag.step(
          'bulletinAuth',
          'skip',
          'no Bulletin authorization found for this account. Posting may fail until one is granted; reading is unaffected.',
        )
      } else {
        const v = status.value
        diag.step(
          'bulletinAuth',
          'ok',
          `${v.remainingTransactions} transactions and ${v.remainingBytes} bytes remaining, expires at block ${v.expiration}`,
        )
      }
    } catch (error) {
      diag.step('bulletinAuth', 'skip', describe(error))
    }
  }

  /* -- statement store ----------------------------------------------------- */
  diag.step('statements', 'running')
  try {
    const module = await loadStatementStore()
    statements = new module.StatementStoreClient({ appName: options.appName })
    // `mode:'host'` is the RFC-10 sponsored path: the host signs with the product's allowance
    // account, so there is no per-call signing prompt and `accountId` is ignored.
    await withTimeout(
      Promise.resolve(statements!.connect!({ mode: 'host' })),
      TIMEOUTS.statements,
      'Statement store connect',
    )
    diag.step('statements', 'ok', `app topic "${options.appName}"`)
  } catch (error) {
    diag.step('statements', 'fail', describe(error))
    try {
      statements?.destroy?.()
    } catch {
      /* ignore */
    }
    statements = null
  }

  /* -- capabilities -------------------------------------------------------- */
  //
  // ⚠️ `canWrite` DEPENDS ON THE BULLETIN PATH ALONE. Not on the statement store, not on personhood.
  // Storing content needs an account authorization, which has an authorizer-signed mint with NO
  // personhood requirement; announcing it live needs a statement-store allowance, which has only the
  // personhood route. Different mechanisms, which is why the two gates come apart — and why a
  // statement failure must never look like an inability to post.
  //
  // `canPushLive` is derived from whether the statement client actually CONNECTED, which is the best
  // signal available without an anonymous personhood probe. Publishing can still fail on allowance
  // or personhood after this, and that is fine: the live ping is best-effort by design, so an
  // optimistic flag costs a swallowed error at worst.
  //
  // TODO(personhood): an `eth_call` against the Asset Hub personhood precompile would turn "live
  // updates are off" into "live updates are off because this account has no personhood proof — lite
  // is enough, and it does not affect posting". Advisory only; it must NEVER gate a write, and LITE
  // COUNTS (`status === 1 || status === 2`; there is no `=== 2` test anywhere and there must not be).
  capabilities.set({
    canRead: !!provider,
    // ⚠️ EITHER write path is enough. `storage` (CloudStorage) is unavailable on a host in
    // `rpc-gateway` chain-backend mode, where posting still works through the preimage channel — so
    // requiring `storage` here reported "posting is off" to users who could in fact post.
    canWrite: (!!storage || !!preimages?.submit) && canChain,
    canPushLive: statements !== null,
    address: account?.h160Address ?? account?.address ?? null,
    insideHost: true,
    // Signed in, so never suggest signing in. Name what is missing and who can fix it — these are
    // conditions the USER cannot resolve, and saying so is kinder than implying they erred.
    reason: !storage && !preimages?.submit
      ? 'Signed in, but this Polkadot app build offers no way to store post bodies — neither the ' +
        'Bulletin storage chain nor the preimage channel is available, so posting is off. Nothing ' +
        'you can change in Plaza fixes it. See DIAGNOSTICS. Reading is unaffected.'
      : !canChain
        ? 'Signed in, but the Polkadot app did not grant permission to submit transactions, so ' +
          'posting is off. Reading is unaffected.'
        : undefined,
    liveReason:
      statements === null
        ? 'Live updates are unavailable, so new posts appear on a timer rather than instantly. Posting still works.'
        : undefined,
  })

  // Derive the delegate key now that there IS a writer. Fire-and-forget: it is silent, it cannot
  // prompt, and nothing may wait on it.
  void delegate.refresh()

  return assemble()

  /* ====================================================================== */

  function assemble(): HostBackend {
    // Owner-only writes go through the product account, never the delegate — see `contracts.ts` for
    // the two reasons (attribution, and the delegate being unfunded).
    const contractWriter = createHostContractWriter({
      signer: hostSigner,
      origin: account?.address ?? '',
      environment: options.bulletinNetwork === 'paseo' ? 'paseo' : 'devnet',
      onStep: (status, detail) => diag.step('submit', status, detail),
    })

    /**
     * ARM 1 — submit an already-prepared native transaction, signed by the host.
     *
     * The host signs NATIVE `Revive` extrinsics, not Ethereum transactions, so there is no
     * `eth_sendTransaction` to adapt and an `ethers.Signer` for this arm is impossible rather than
     * merely unwritten. The division of labour that makes this small: the CONTRACT layer builds the
     * call (`contract.method.prepare(...)` from `@parity/product-sdk-contracts` returns a
     * `BatchableCall`), and this seam only signs and watches it. That is why `prepared` is `unknown` —
     * the seam deliberately does not grow an ABI dependency.
     *
     * ⚠️ `submit` is null when there is no host signer, and callers MUST keep handling that: it is
     * the honest read-only state, not a bug. Never make this a function that throws instead.
     *
     * ⚠️ The returned hash is a SUBSTRATE EXTRINSIC hash, not an Ethereum one. Do not hand it to an
     * `eth_getTransactionReceipt`, and do not expect the call's events to appear in the ETH log index
     * — a host-submitted call emits `Revive.ContractEmitted` into `System.Events` and nothing into
     * the ETH logs, which is exactly why reads poll instead of subscribing (architecture §8).
     */
    const submit = hostSigner
      ? async (prepared: unknown, label: string): Promise<{ txHash: string }> => {
          const tx = await loadTx()
          diag.step('submit', 'running', label)
          try {
            // `waitFor: 'best-block'` rather than 'finalized': finality is ~12-24s here and the UI
            // polls for the real state anyway, so waiting for it would only make posting feel broken.
            const result = await withTimeout(
              Promise.resolve(
                tx.submitAndWatch(prepared, hostSigner, {
                  waitFor: 'best-block',
                  timeoutMs: TIMEOUTS.write,
                }),
              ),
              TIMEOUTS.write,
              label,
            )
            // A `@parity/result`, NOT a neverthrow ResultAsync — branch on `.ok`. Mixing the two is a
            // silent total bug, which is why every unwrap goes through util.ts. See `sdk.ts`.
            const value = unwrapParity<{ txHash?: unknown }>(result, label)
            const txHash = typeof value?.txHash === 'string' ? value.txHash : null
            if (!txHash) throw new Error('the host reported no transaction hash')
            diag.step('submit', 'ok', `${label} · ${txHash}`)
            return { txHash }
          } catch (error) {
            diag.step('submit', 'fail', `${label} · ${describe(error)}`)
            throw error
          }
        }
      : null

    const seam: SignerSeam = {
      host: { account, signer: hostSigner, submit },
      delegateSigner: delegate.signer(),
    }

    return {
      kind: 'host',
      label: inside ? 'Polkadot host container' : 'read-only (no container)',
      diagnostics: diag,

      capabilities: capabilities.get,
      onCapabilities: capabilities.subscribe,

      writeContract: contractWriter
        ? (address, abi, method, args, label) =>
            contractWriter.write(address, abi, method, args, label)
        : null,

      readProvider: () => provider,
      signer: () => ({ ...seam, delegateSigner: delegate.signer() }),

      delegation: () => (capabilities.get().canWrite ? delegate.state() : null),
      onDelegation: (listener) =>
        delegate.subscribe((state) => listener(capabilities.get().canWrite ? state : null)),
      authorizeDelegate: async () => {
        // The on-chain half is injected by whoever owns the contract, so the seam does not grow an
        // ABI dependency. Until that lands this is honest about doing nothing rather than pretending.
        diag.step(
          'delegate',
          'skip',
          'authorising a delegate needs the contract layer, which is not wired into this seam yet',
        )
        return delegate.state()
      },
      revokeDelegate: async () => false,

      putBlob: (bytes, putOptions) => putBlob(bytes, putOptions),

      ensureAllowance: allowance.ensure,
      requestAllowanceAgain: allowance.requestAgain,

      destroy() {
        for (const close of [
          () => statements?.destroy?.(),
          () => storage?.destroy?.(),
          () => manager?.destroy?.(),
        ]) {
          try {
            close()
          } catch {
            /* ignore */
          }
        }
      },
    }
  }

  /**
   * Store bytes on Bulletin and return the CID.
   *
   * ⭐ THE LAZY-ALLOCATION TRIGGER LIVES HERE, and this is the reason rather than tidiness: it is
   * the narrowest choke point that EVERY write passes through and NO read does. Every post, reply
   * and attachment appends a Bulletin object before anything moves a head pointer, so one call here
   * covers the whole write path; and nothing on the read path calls `putBlob` at all, so "a reader
   * never sees the allowance dialog" is STRUCTURAL rather than a rule someone has to remember.
   */
  async function putBlob(bytes: Uint8Array, putOptions?: PutBlobOptions): Promise<string> {
    // Awaited but never load-bearing: it cannot throw, and a refusal must not stop the write,
    // because the host may still allocate implicitly on submission.
    await allowance.ensure()

    const described = putOptions?.contentType
      ? `${bytes.length} bytes (${putOptions.contentType})`
      : `${bytes.length} bytes`

    /**
     * The CID, computed LOCALLY and first.
     *
     * Bulletin is content-addressed, so the CID is a function of the bytes and needs no chain at all.
     * That matters because the preimage fallback below returns a hex preimage key, NOT a CID — so
     * without this there would be nothing to return from the path that actually works.
     */
    let localCid = ''
    try {
      const cloud = await loadCloudStorage()
      localCid = String(await cloud.calculateCid(bytes))
    } catch {
      /* fall through — only fatal if the store path cannot supply a CID either */
    }

    /* -- attempt 1: the account-authorized CloudStorage store -------------------------------- */
    if (storage?.store) {
      diag.step('bulletin', 'running', `${described} via account authorization`)
      try {
        const receipt = await withTimeout(storage.store(bytes).send(), TIMEOUTS.store, 'Bulletin store')
        const cid = String(receipt?.cid ?? localCid)
        if (!cid) throw new Error('the store receipt carried no CID')
        diag.step(
          'bulletin',
          'ok',
          `${cid}${receipt?.blockNumber === undefined ? '' : ` in block ${receipt.blockNumber} index ${receipt.extrinsicIndex}`}`,
        )
        return cid
      } catch (error) {
        // ⚠️ NOT FATAL. Fall through to the preimage channel — see below.
        diag.step(
          'bulletin',
          'skip',
          `account-authorized store failed (${describe(error)}) — trying the preimage channel`,
        )
      }
    }

    /**
     * -- attempt 2: THE HOST PREIMAGE CHANNEL, and why it is not a curiosity -------------------
     *
     * ⭐ ON A REAL PHONE THIS IS THE PATH THAT WORKS, AND THE ONLY ONE.
     *
     * `CloudStorageClient` reaches Bulletin through the host's chain bridge, which first asks
     * `system.featureSupported({ tag: 'Chain', value: { genesisHash } })`. A host running in
     * **`rpc-gateway` chain-backend mode answers that from a three-element list — relay, Asset Hub,
     * People — that never contains a Bulletin chain.** So `ChainNotSupportedError` comes back for
     * EVERY Bulletin genesis, which is why the earlier devnet→paseo fallback could not help: it was
     * trying two chains that are both absent from the same list. Observed on a real device
     * 2026-07-30 with every other step green. The mode is sticky in
     * `localStorage['dotli:chain-backend']`, so this is not transient and not ours to fix.
     *
     * `getPreimageManager` goes through the TruAPI bridge instead (`client.preimage.submit`) and
     * touches no chain client, no genesis hash and no support probe — so it is unaffected.
     *
     * This mirrors yolodot's `putBlob`, whose first successful write went through exactly here.
     *
     * ⚠️ Two consequences worth knowing before relying on it:
     *   · It returns a hex preimage key, not a CID. Hence `localCid` above.
     *   · There is no `(blockNumber, extrinsicIndex)` receipt, and Bulletin `renew` is positional —
     *     so content written this way is the hardest to keep alive past retention. See §4a.
     */
    if (preimages?.submit) {
      diag.step('bulletin', 'running', `${described} via the host preimage channel`)
      try {
        await withTimeout(preimages.submit(bytes), TIMEOUTS.store, 'Bulletin preimage submit')
        if (!localCid) throw new Error('the preimage submitted but no CID could be computed locally')
        diag.step('bulletin', 'ok', `${localCid} via preimage channel (no block receipt)`)
        return localCid
      } catch (error) {
        diag.step('bulletin', 'fail', `preimage channel failed: ${describe(error)}`)
        throw new Error(`Bulletin write failed: ${describe(error)}`)
      }
    }

    diag.step('bulletin', 'fail', 'no Bulletin write path is available')
    throw new Error('Bulletin write failed: no authorized write path is available for this account.')
  }
}
