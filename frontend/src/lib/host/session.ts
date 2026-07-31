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

import { createAllowanceGate } from './allowance'
import { createCapabilityStore, READ_ONLY } from './capabilities'
import { insideContainer, productIdentifier } from './container'
import { assetHub, createHostContractWriter, createSdkChainReader } from './contracts'
import { createDelegate } from './delegate'
import { createDiagnostics } from './diagnostics'
import { classifyWriteFailure, isAllowanceFailure } from './errors'
import { setBulletinSource } from '../bulletin'
import { destinationFromPublicKey, normaliseH160 } from '../recipient'
import { loadAddress, loadCloudStorage, loadHost, loadStatementStore, loadTx, loadWallet, sdkAvailable } from './sdk'
import type { ChainReader, HostAccount, HostBackend, PaymentsSeam, PutBlobOptions, RecipientResolution, SignerSeam, TipOutcome } from './types'
import { describe, TIMEOUTS, unwrapParity, withTimeout, type ParityResult } from './util'

export interface HostSessionOptions {
  /** Product/topic name the statement store publishes under. */
  appName: string
  /**
   * Open the SDK chain-read path at all.
   *
   * ⚠️ IT IS A SWITCH, NOT AN ENDPOINT, AND IT USED TO BE A URL. `rpcUrl` took a third-party HTTP
   * origin — see `backend.ts` and `utils/contracts.ts`. `false` here means "no chain reads", which
   * exists only so a screen can be proved to degrade honestly with no chain at all (`?rpc=off`).
   */
  chainReads?: boolean
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

  /* -- chain reads --------------------------------------------------------- */
  //
  // ⛔ DELIBERATELY NOT BUILT YET. This block used to sit HERE, above the container check, and read:
  //
  //     provider = new ethers.JsonRpcProvider('https://paseo-assethub-rpc.laissez-faire.trade')
  //
  // — unconditionally, for every visitor, before we even knew whether there was a host. It was the
  // same violation the IPFS gateways were (`gotchas.md` § THE SDK PATH IS THE ONLY PATH) and it fired
  // earlier and more often: every board head, profile, vote tally, follow edge, 30-second poll and
  // read-after-write confirmation loop was external-origin HTTP from a domain that is neither
  // Parity's nor the community foundation's.
  //
  // The reader is now created BELOW the container check, because the SDK path needs the host and
  // there is no second path to fall back to. See `contracts.ts` `createSdkChainReader`.
  let chainReader: ChainReader | null = null
  let chainReadsServed = 0
  let chainReadsFailed = 0
  let lastChainEmit = 0

  const delegate = createDelegate({ diagnostics: diag })

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
  let preimages: {
    submit?: (bytes: Uint8Array) => Promise<unknown>
    /** The READ half of the same channel. See `installBulletinReader`. */
    lookup?: (key: string, onValue: (preimage: Uint8Array | null) => void) => unknown
  } | null = null

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
    /**
     * ⛔ NO CONTAINER MEANS NO BULLETIN READS AT ALL, AND THAT IS REPORTED, NOT ROUTED AROUND.
     *
     * Until 2026-07-31 this case was covered by racing four public IPFS gateways over plain `fetch`.
     * That is what made the host prompt a real user for permission to reach
     * `devnet-ipfs.api.polkadotcommunity.foundation`, and the alternative path has been removed —
     * see `lib/bulletin.ts` for the whole argument. The honest consequence is that a plain browser
     * tab can read the CHAIN (heads, profiles, vote tallies, all via `eth_call`) but cannot load a
     * single post BODY, and it says so here instead of pretending.
     */
    setBulletinSource(null)
    diag.step(
      'read',
      'fail',
      hasSdk
        ? 'post bodies are read through the Polkadot app, so nothing can be loaded outside it. ' +
          'Open Plaza from the Polkadot app, or use ?backend=fake for local development.'
        : 'the Products SDK is not installed in this build, so there is no way to read post bodies.',
    )
    /**
     * ⛔ AND NEITHER IS THERE A CHAIN READ. NEW 2026-07-31, AND IT IS A CORRECTION.
     *
     * The old text here promised "reading works anywhere", because chain reads went over a public
     * HTTP RPC. They do not any more, and there is no fallback to route around it by design. So this
     * branch now says the same thing about heads, profiles and tallies that it already said about
     * post bodies, and `canRead` is `false` — which is what makes `SessionStatus` show its honest
     * "Plaza could not reach the chain" header instead of an app that renders an empty board as if
     * the board were empty.
     */
    diag.step(
      'chain',
      'fail',
      hasSdk
        ? 'chain reads go through the Polkadot app (product-sdk-contracts .query over the host ' +
          'provider), so threads, profiles and vote tallies cannot load outside it. Open Plaza from ' +
          'the Polkadot app, or use ?backend=fake for local development.'
        : 'the Products SDK is not installed in this build, so there is no way to read the chain.',
    )
    capabilities.set({
      canRead: false,
      canWrite: false,
      canPushLive: false,
      address: null,
      insideHost: false,
      reason:
        'Plaza runs inside the Polkadot app: both its content and its chain data are read through ' +
        'the app, so open it from there. For local development use ?backend=fake.',
    })
    return assemble()
  }

  /* -- chain reads, before the wallet and unconditionally ------------------- */
  //
  // ⭐ EVERY CONTRACT READ IN THE APP GOES THROUGH THIS OBJECT, AND IT NEEDS NO ACCOUNT.
  //
  // Placed here for the same reason `installBulletinReader` is placed here: an anonymous reader
  // inside the host must get a full timeline, and every failure below this line returns early.
  // Reading has never depended on an account and must not start now — `.query()`'s origin resolution
  // ends in a pallet-revive account fallback, so there is nothing to wait for.
  //
  // Construction is synchronous and cannot fail: the chain client is built lazily on the FIRST read
  // (see `contracts.ts` `assetHub()`), so a read-only session that never renders a list never opens
  // a connection, and a connection failure surfaces on the read that needed it rather than as a
  // session that would not start.
  if (options.chainReads === false) {
    // `?rpc=off`. The one legitimate way to have no chain: proving a screen degrades honestly.
    diag.step('chain', 'skip', 'chain reads disabled with ?rpc=off — nothing may crash')
  } else {
    chainReader = createSdkChainReader({
      environment: options.bulletinNetwork === 'paseo' ? 'paseo' : 'devnet',
      onRead: reportChainRead,
    })
    diag.step(
      'chain',
      'ok',
      `${chainReader.label} — reads dry-run through the host with product-sdk-contracts .query(), ` +
        'no external RPC and therefore no permission prompt. The connection opens on the first read.',
    )
  }

  /* -- bulletin READS, before the wallet and unconditionally ---------------- */
  //
  // ⭐ THE ONE PATH POST BODIES ARE READ THROUGH, AND IT NEEDS NO WALLET AND NO CHAIN CLIENT.
  //
  // Placed HERE, above the wallet block, for the same reason the chain reader is built above it: an
  // anonymous reader inside the host must get a full timeline, and every failure below this line
  // returns early. Reading has never depended on an account and must not start now.
  //
  // ⚠️ AND IT DOES NOT DEPEND ON `storage` EITHER. This is the finding that makes the whole change
  // work, and it is the opposite of what the CloudStorage README implies:
  //
  //   `CloudStorageClient.fetchBytes(cid, opts)` is, verbatim in the shipped
  //   `dist/index.js`, `executeQuery(await this.resolveQuery(), cid, opts)`, and `resolveQuery()`
  //   is `resolveQueryStrategy()`, which is `await getPreimageManager()` and nothing else.
  //
  // So the read path touches NO chain client, NO genesis hash and NO
  // `system.featureSupported({ tag: 'Chain' })` probe — which is precisely the probe that stops
  // `CloudStorageClient.create()` from ever succeeding on a host in `rpc-gateway` chain-backend
  // mode (see the long note above `bulletinCandidates`). `storage` being null on a real phone is
  // the NORMAL case, and it does not disable reads: the module-level `resolveQueryStrategy` /
  // `executeQuery` pair reaches the same host preimage subscription the write path already uses,
  // and that channel carried a real write on 2026-07-30.
  //
  // `executeQuery` also reassembles chunked DAG-PB manifest CIDs (manifest lookup, then every child
  // chunk under one `Promise.all`), which is work we would otherwise have had to write ourselves.
  await installBulletinReader()

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
      // Unaffected by a failed wallet: `.query()` needs no account. This is the anonymous reader.
      canRead: !!chainReader,
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
    canRead: !!chainReader,
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

  /**
   * Counters for the chain-read path, THROTTLED for the same reason the Bulletin one is: every
   * `diagnostics.step` notifies every subscriber and `useHostSession` pipes that straight into React
   * state, so one emit per read would re-render the whole app dozens of times during a single poll —
   * the exact flicker `lib/poll.ts` was rewritten to remove.
   *
   * The first success and the first failure always land, so "is the native read route working at
   * all?" is answerable immediately, which is the question this step exists for.
   */
  function reportChainRead(ok: boolean, detail: string): void {
    if (ok) chainReadsServed += 1
    else chainReadsFailed += 1
    const first = ok ? chainReadsServed === 1 : chainReadsFailed === 1
    const now = Date.now()
    if (!first && now - lastChainEmit < 2_000) return
    lastChainEmit = now
    diag.step(
      'chain',
      chainReadsFailed > 0 && chainReadsServed === 0 ? 'fail' : 'ok',
      `${chainReadsServed} read${chainReadsServed === 1 ? '' : 's'} served, ${chainReadsFailed} failed · last ${detail}`,
    )
  }

  /**
   * Resolve the host's preimage query strategy once and install it as THE Bulletin read path.
   *
   * A failure here is reported as a failure, not smoothed over: with no gateway fallback left,
   * "the read path did not open" is the difference between a working app and a board of holes, and
   * the diagnostics panel is the only debugger available on a phone.
   */
  async function installBulletinReader(): Promise<void> {
    diag.step('read', 'running')
    try {
      const cloud = await loadCloudStorage()
      const strategy = await withTimeout(
        Promise.resolve(cloud.resolveQueryStrategy()),
        TIMEOUTS.connect,
        'Bulletin read path',
      )
      if (!strategy || typeof strategy.lookup !== 'function') {
        throw new Error('the host offered no preimage lookup')
      }

      /**
       * Counters rather than a line per read, and THROTTLED, because `diagnostics.step` notifies
       * every subscriber and `useHostSession` pipes that straight into React state. One emit per
       * body would re-render the whole app twenty times during a single page walk — the exact
       * flicker `lib/poll.ts` was just rewritten to remove. The first event of each kind always
       * lands, so "is the native route working at all?" is answerable immediately.
       */
      let served = 0
      let unavailable = 0
      let lastEmit = 0
      const report = (detail: string, force: boolean) => {
        const now = Date.now()
        if (!force && now - lastEmit < 2_000) return
        lastEmit = now
        diag.step('read', unavailable > 0 && served === 0 ? 'skip' : 'ok', detail)
      }

      setBulletinSource({
        label: `host ${String(strategy.kind ?? 'lookup')}`,
        async read(cid, { timeoutMs }) {
          const startedAt = Date.now()
          try {
            const bytes = unwrapParity<Uint8Array>(
              (await cloud.executeQuery(strategy, cid, { lookupTimeoutMs: timeoutMs })) as ParityResult<Uint8Array>,
              'Bulletin read',
            )
            served += 1
            report(
              `${served} served, ${unavailable} unavailable · last ${Date.now() - startedAt} ms ` +
                'via the host preimage lookup — no external gateway is contacted',
              served === 1,
            )
            return bytes
          } catch (error) {
            unavailable += 1
            report(
              `${served} served, ${unavailable} unavailable · last failure: ${describe(error)}`,
              unavailable === 1,
            )
            throw error
          }
        },
      })
      diag.step(
        'read',
        'ok',
        `${String(strategy.kind ?? 'lookup')} ready — post bodies load through the host, with no ` +
          'external gateway and therefore no permission prompt',
      )
    } catch (error) {
      // ⛔ No second path. Say what broke and what it costs, in that order.
      setBulletinSource(null)
      diag.step(
        'read',
        'fail',
        `${describe(error)} — post bodies cannot be loaded in this session. Chain reads ` +
          '(threads, profiles, vote tallies) are unaffected; the words are what is missing.',
      )
    }
  }

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

    // ⚠️ ONE ARM. `delegateSigner` was removed 2026-07-31 — see `types.ts` `SignerSeam` for the two
    // independent reasons it could never have worked, and `delegate.ts` for what is left of it.
    const seam: SignerSeam = {
      host: { account, signer: hostSigner, submit },
    }

    return {
      kind: 'host',
      label: inside ? 'Polkadot host container' : 'read-only (no container)',
      diagnostics: diag,

      capabilities: capabilities.get,
      onCapabilities: capabilities.subscribe,

      /**
       * ⭐ THE SECOND LAZY-ALLOCATION TRIGGER, added 2026-07-31. `putBlob` was the only one.
       *
       * That was defensible for POSTS — every post stores a body before it moves a pointer, so
       * `putBlob` ran first and `ensure()` came with it — but it left every write that is a contract
       * call and nothing else with no trigger at all: `createProfile`, `authorizeDelegate`,
       * `setDisplayName`, a vote. Those could reach the host having never asked for an allowance in
       * the session's life.
       *
       * Same three properties as the `putBlob` trigger, and they are the constraints, not the
       * implementation: it is on the WRITE path only so a reader never sees a dialog; it is awaited
       * but NEVER GATES, because the host may still allocate implicitly on submission and refusing
       * to send would disable writing for users who can in fact write; and `ensure()` cannot throw.
       */
      writeContract: contractWriter
        ? async (address, abi, method, args, label) => {
            await allowance.ensure()
            try {
              return await contractWriter.write(address, abi, method, args, label)
            } catch (error) {
              /**
               * ⚠️ THE FIX FOR THE 2026-07-31 REPLY FAILURE, and it belongs here rather than in
               * `allowance.ts` because this is the only place that sees a write actually fail.
               *
               * A host failure naming an allowance is proof that the persisted claim — possibly
               * hours old and still inside its 24 h TTL — is worthless. Dropping it is what lets the
               * NEXT write ask again instead of silently trusting a record the host has refuted.
               *
               * It does not retry and does not request: for `no_statement_allowance`, the dominant
               * case, the allowance request travels the same dead statement-store channel the write
               * did, so a retry from here would hang and change nothing. See `host/errors.ts`.
               *
               * ⚠️ And for that code this is BOOKKEEPING, not a remedy. The missing thing is an
               * on-chain statement-store slot that only a personhood proof can create; no amount of
               * re-asking from inside a browser produces one.
               */
              const { code } = classifyWriteFailure(error)
              if (isAllowanceFailure(code)) {
                allowance.invalidate(`${label} failed with "${code}"`)
              }
              throw error
            }
          }
        : null,

      // Only inside a container: `getPaymentManager()` returns null outside one, and a seam that
      // exists but can only fail is worse than an honest null.
      payments: inside ? createPayments() : null,

      chainReader: () => chainReader,
      signer: () => seam,

      delegation: () => (capabilities.get().canWrite ? delegate.state() : null),
      onDelegation: (listener) =>
        delegate.subscribe((state) => listener(capabilities.get().canWrite ? state : null)),
      /**
       * ⛔ THIS WRITES NOTHING. IT IS A STUB, AND `App.tsx` STILL WIRES "SET UP POSTING KEY" TO IT.
       *
       * The on-chain half is injected by whoever owns the contract (`delegate.authorize({
       * authorizeOnChain })`), so this seam does not grow an ABI dependency. Nobody injects it.
       *
       * ⭐ THE WORKING IMPLEMENTATION ALREADY EXISTS ELSEWHERE: `hooks/useUserRegistry.ts`
       * `authorizeDelegate(delegateAddress, expiryUnixSeconds)` is host-signed and polls
       * `delegateExpiry` until the chain agrees. Wiring the two together is not a rename — the
       * clock-skew clamp and `MAX_DELEGATION_SECONDS` read live in `delegate.ts` `authorize()`,
       * which this method does not call, so a caller has to supply `authorizeOnChain` rather than
       * replace this function.
       *
       * ⚠️ It resolves rather than throwing because `HostBackend.authorizeDelegate` is documented
       * "never throws" and the settings screen already degrades correctly: with no confirmed expiry
       * from `onConfirmDelegate` it says "sent, watch the line above" instead of claiming success.
       * That is the one thing that must not regress — a stub that reported success is exactly the
       * failure a user hit on a real phone.
       */
      authorizeDelegate: async () => {
        diag.step(
          'delegate',
          'skip',
          'NOTHING WAS WRITTEN. This seam has no contract layer injected, so it cannot authorise a ' +
            'delegate. The working call is useUserRegistry.authorizeDelegate(address, expiry); it ' +
            'is host-signed and confirms on chain. See the note in session.ts.',
        )
        return delegate.state()
      },
      revokeDelegate: async () => false,

      putBlob: (bytes, putOptions) => putBlob(bytes, putOptions),

      ensureAllowance: allowance.ensure,
      requestAllowanceAgain: allowance.requestAgain,

      destroy() {
        // Cleared first: a source left installed would keep answering reads from a torn-down host,
        // and the next backend to open would not be able to tell it apart from its own.
        setBulletinSource(null)
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
   * The CASH seam. See `types.ts` `PaymentsSeam` for why this is RFC-0006 `payment.*` and not
   * RFC-0017 `coinPayment.*`, and `lib/cash.ts` for the amount scale.
   */
  function createPayments(): PaymentsSeam {
    /** One manager for the session, fetched on first use — a reader never needs it. */
    let managerPromise: Promise<{
      subscribeBalance: (cb: (b: { available: bigint }) => void) => { unsubscribe: () => void }
      requestPayment: (amount: bigint, destination: string) => Promise<{ id: string }>
      subscribePaymentStatus: (
        id: string,
        cb: (s: { tag: string; value?: { reason?: string } }) => void,
      ) => { unsubscribe: () => void }
    } | null> | null = null

    const payments = () =>
      (managerPromise ??= (async () => {
        const host = await loadHost()
        return (await host.getPaymentManager()) ?? null
      })().catch((error) => {
        diag.step('payments', 'fail', describe(error))
        return null
      }))

    return {
      subscribeBalance(listener) {
        let live = true
        let handle: { unsubscribe: () => void } | null = null

        void (async () => {
          const manager = await payments()
          // ⚠️ `null`, not `0n`. "We could not read it" and "you have nothing" are different facts
          // and the UI renders them differently — see `PaymentsSeam`.
          if (!manager || !live) {
            if (live) listener(null)
            return
          }
          try {
            // Annotated explicitly: `loadHost()` is `any` (see `sdk.ts`), so an unannotated
            // parameter here is an implicit `any` and `noImplicitAny` rejects it.
            handle = manager.subscribeBalance((balance: { available?: unknown } | null) => {
              if (!live) return
              const available = balance?.available
              listener(typeof available === 'bigint' ? available : null)
            })
          } catch (error) {
            // `PermissionDenied` lands here: the user declined to disclose their balance. That is a
            // legitimate answer, not a fault, so it is a `skip` rather than a `fail`.
            diag.step('payments', 'skip', `balance unavailable · ${describe(error)}`)
            if (live) listener(null)
          }
          if (!live) handle?.unsubscribe?.()
        })()

        return () => {
          live = false
          try {
            handle?.unsubscribe?.()
          } catch {
            /* ignore — tearing down a dead subscription must never throw at a caller */
          }
        }
      },

      /**
       * ⭐ FIXED 2026-07-31 — THIS IS WHY NO RECIPIENT WAS EVER PAYABLE.
       *
       * The previous implementation read `Revive.OriginalAccount` with
       * `client.raw.assetHub._request('state_getStorage', [prefix + address])`. Inside a host
       * container that call CANNOT succeed for anybody. `createChainClient` runs on
       * `getHostProvider()`, whose PAPI provider is a hand-written JSON-RPC ↔ TruAPI bridge
       * (`@parity/product-sdk-host/src/papi-provider.ts`) — a `switch (method)` over exactly
       * `chainHead_v1_{follow,unfollow,header,body,storage,call,unpin,continue,stopOperation}`,
       * `chainSpec_v1_{genesisHash,chainName,properties}` and `transaction_v1_{broadcast,stop}`,
       * whose `default:` branch replies
       * `-32601 Method "state_getStorage" is not supported by the host`.
       *
       * So the lookup threw on every call, the catch returned the same `null` as "no mapping", and
       * the modal told every user that the person they were trying to tip had "never made a
       * transaction". That sentence was never about the recipient.
       *
       * The typed query below goes through `chainHead_v1_storage`, which the bridge DOES serve —
       * and the same chain client, against the same Asset Hub descriptor, is what `contracts.ts`
       * uses for the host-signed write that is verified on a real phone. It returns SS58, so the
       * seam decodes it back to the 32 bytes `payment.request` wants.
       */
      async resolveRecipient(h160Address): Promise<RecipientResolution> {
        // ⛔ A LOOKUP, NEVER A COMPUTATION. See `lib/recipient.ts`.
        const h160 = normaliseH160(h160Address)
        if (!h160) {
          return { status: 'unavailable', reason: `"${h160Address}" is not a 20-byte address.` }
        }
        try {
          // ⚠️ THE SHARED CLIENT (`contracts.ts` `assetHub()`), not a second one. This used to call
          // `createChainClient` itself, which opened a third chainHead subscription for the same
          // chain the reader and the writer were already on.
          const [{ client }, address] = await Promise.all([
            assetHub(options.bulletinNetwork === 'paseo' ? 'paseo' : 'devnet'),
            loadAddress(),
          ])

          // `StorageDescriptor<[Key: SizedHex<20>], SS58String, true, never>` — `SizedHex` is a
          // branded plain string, so the bare `0x…` goes in as-is. (The old comment claiming the
          // typed path needs papi's `Binary` wrapper described an older descriptor generation; this
          // one has no `Binary` in the key at all.)
          const ss58 = await withTimeout(
            Promise.resolve(client.assetHub.query.Revive.OriginalAccount.getValue(h160)),
            TIMEOUTS.connect,
            'OriginalAccount lookup',
          )
          if (typeof ss58 !== 'string' || !ss58) {
            // A real answer, and a fact about the recipient: the chain holds no reverse mapping.
            diag.step('payments', 'skip', `${h160} has no Revive.OriginalAccount entry`)
            return { status: 'unmapped' }
          }

          // A DECODE, not a derivation — it recovers the exact bytes the chain encoded. Checked
          // against the one measured mapping: `5EJ3VTQ…` → `0x62a4c082…903d2f`, which is byte for
          // byte what the old raw storage read returned. `payment.request.destination` is
          // `S.Hex(32)` in `@parity/truapi`, so the length check below is the wire contract.
          const { publicKey } = address.ss58Decode(ss58) as { publicKey: Uint8Array }
          const destination = destinationFromPublicKey(publicKey)
          diag.step('payments', 'ok', `${h160} → ${ss58}`)
          return { status: 'ready', destination }
        } catch (error) {
          // ⛔ REFUSE, AND SAY IT WAS US. Never report a failed lookup as a fact about the recipient
          // — that is exactly the bug this branch used to hide.
          const reason = describe(error)
          diag.step('payments', 'fail', `recipient lookup failed · ${reason}`)
          return { status: 'unavailable', reason }
        }
      },

      async sendTip(destination, amount): Promise<TipOutcome> {
        const manager = await payments()
        if (!manager) return { status: 'failed', reason: 'This Polkadot app build offers no payment service.' }

        let id: string
        try {
          diag.step('payments', 'running', `requesting ${amount} base units`)
          const response = await manager.requestPayment(amount, destination)
          id = response?.id
          if (!id) throw new Error('the host returned no payment id')
        } catch (error) {
          // The host surfaces the user's own decision as an error. Read it back apart from a real
          // failure, because "you cancelled" must never be reported as "something broke".
          const text = describe(error)
          if (/reject/i.test(text)) {
            diag.step('payments', 'skip', 'the user declined the payment')
            return { status: 'rejected' }
          }
          if (/insufficient/i.test(text)) {
            diag.step('payments', 'skip', 'insufficient balance')
            return { status: 'insufficient' }
          }
          // ⚠️ FIRST SUSPECT IF THIS EVER FAILS ON A REAL DEVICE, and it is NOT a malformed call:
          // pUSD (asset 50000413) is the only PROTECTED asset on this chain — every value method on
          // its ERC-20 precompile reverts with "Protected asset access requires value-transfer
          // authorization", and what grants that authorization is unknown to us. Reproduce with
          // `node contracts/scripts/probe-tipping.mjs`. Do not start by rewriting this call.
          diag.step('payments', 'fail', text)
          return { status: 'failed', reason: text }
        }

        /**
         * `requestPayment` returning means AUTHORIZED, NOT SETTLED — RFC-0006 says so, and Parity's
         * own app notes the native host returns before the extrinsic is even broadcast. So watch the
         * status to a terminal state rather than claiming success here.
         */
        return await new Promise<TipOutcome>((resolve) => {
          let done = false
          let handle: { unsubscribe: () => void } | null = null
          const finish = (outcome: TipOutcome) => {
            if (done) return
            done = true
            try {
              handle?.unsubscribe?.()
            } catch {
              /* ignore */
            }
            resolve(outcome)
          }
          // A status stream that never speaks must not hang the UI for ever. Reported as sent-but-
          // unconfirmed rather than failed: double-charging by retrying is the worse error.
          const timer = setTimeout(() => {
            diag.step('payments', 'skip', `${id} · no terminal status; treating as sent unconfirmed`)
            finish({ status: 'sent' })
          }, TIMEOUTS.write)

          try {
            handle = manager.subscribePaymentStatus(id, (status: { tag?: string; value?: { reason?: string } } | null) => {
              if (status?.tag === 'Completed') {
                clearTimeout(timer)
                diag.step('payments', 'ok', `${id} completed`)
                finish({ status: 'sent' })
              } else if (status?.tag === 'Failed') {
                clearTimeout(timer)
                const reason = status.value?.reason ?? 'the host reported a failure'
                diag.step('payments', 'fail', `${id} failed · ${reason}`)
                finish({ status: 'failed', reason })
              }
              // 'Processing' — keep waiting.
            })
          } catch (error) {
            clearTimeout(timer)
            // The payment was accepted; only the WATCHING failed. Saying "failed" here would be a
            // lie that invites a retry, i.e. a second charge.
            diag.step('payments', 'skip', `${id} accepted but status unavailable · ${describe(error)}`)
            finish({ status: 'sent' })
          }
        })
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
