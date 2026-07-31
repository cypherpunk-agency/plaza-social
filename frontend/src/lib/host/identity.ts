// ⭐ THE IDENTITY INSTRUMENT. It answers ONE question and it answers it with provenance:
//
//     "Which account did this device get, and what did it get it FOR?"
//
// ⛔ IT PROPOSES NO EXPLANATION. Two devices belonging to one human showed two different product
// accounts on 2026-07-31 and three theories were offered and rejected. This module exists because
// the correct next move is not a fourth theory — it is to put every input of the derivation on a
// screen the user can read off a phone and paste into a chat. Every field here is therefore either
// a MEASURED value with a named source, or an explicit `unavailable` with the reason it is absent.
// ⚠️ A MISSING FIELD IS ITSELF EVIDENCE. Absent ≠ empty ≠ zero — never render a blank, and never
// substitute a plausible default.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THE DERIVATION ACTUALLY TAKES, so it is obvious which fields matter.
//
//   productAccount = publicSoft(rootPublicKey, ["product", productId, derivationIndex])
//
// (`@parity/product-sdk-keys@0.3.16` `dist/index.js`, read verbatim — gotchas.md § THE ACCOUNT IS
// PER-WALLET-ROOT.) Three inputs. None of them is a device, an install, a clock or a nonce. So two
// devices agree iff they present the same ROOT and ask for the same PRODUCT ID. This panel can see
// the product id (we choose it) and the derivation index (the SDK hardcodes it), and it CANNOT see
// the root — the host never discloses it. What it can see instead is the `primaryUsername`, which is
// the diagnostic gotchas.md actually prescribes: same username → one identity, a pairing problem;
// different usernames → two identities the platform cannot merge.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// ⛔ NOTHING IN THIS FILE MAY CALL THE HOST. It is a pure record plus a pure formatter. `session.ts`
// fills the record during the handshake it was already running; the panel renders whatever is there.
// That is what makes the screen safe to open on a device mid-investigation: opening it performs no
// host call, so it cannot sign, cannot prompt, and cannot mint an allowance.
//
// ⛔ AND IT NEVER DERIVES AN ACCOUNT. There is no h160→SS58 anywhere here. `Revive.OriginalAccount`
// is the only sound route and it lives in `session.ts` `resolveRecipient`. See `lib/recipient.ts`.

/* ================================================================= values == */

/**
 * One field's value. TWO states, deliberately — there is no third "empty" state.
 *
 * `unavailable` carries a REASON rather than a flag, because on this screen the reason is the
 * finding. "The host returns no product identifier" is not a gap in the panel; it is the answer to
 * the question the panel was built to ask.
 */
export type IdentityValue =
  | { status: 'value'; value: string }
  | { status: 'unavailable'; reason: string }

export const value = (v: string): IdentityValue => ({ status: 'value', value: v })
export const unavailable = (reason: string): IdentityValue => ({ status: 'unavailable', reason })

/** `value` when the input is a non-empty string, `unavailable` with `reason` otherwise. */
export function present(v: string | null | undefined, reason: string): IdentityValue {
  return typeof v === 'string' && v.length > 0 ? value(v) : unavailable(reason)
}

/**
 * `value` either way — for fields whose ABSENCE is itself a measured fact rather than a gap.
 *
 * ⚠️ THE DISTINCTION MATTERS AND IT IS NOT PEDANTRY. "the signer reported no error" is something we
 * KNOW, and rendering it as `unavailable — none` reads as "we could not find out", which is the
 * opposite. Use this only when the caller has already established that the field was actually read.
 */
export function valueOr(v: string | null | undefined, whenAbsent: string): IdentityValue {
  return typeof v === 'string' && v.length > 0 ? value(v) : value(whenAbsent)
}

export interface IdentityField {
  /** Stable machine key. This is what appears in the COPY ALL block, so it must not drift. */
  key: string
  value: IdentityValue
  /** Where the value came from — a file, an SDK call, or a browser global. Never a guess. */
  source: string
}

export interface IdentitySection {
  title: string
  /** One sentence on what the section is for, when that is not obvious from the title. */
  note?: string
  fields: IdentityField[]
}

/* =============================================================== snapshot == */

/** One account exactly as the signer handed it over. Every field nullable; nothing is invented. */
export interface SnapshotAccount {
  /** SS58, in full. Never truncated anywhere in this module. */
  address: string | null
  /** The 0x mapping the SDK derived from the same public key. */
  h160Address: string | null
  /** The 32-byte product-account public key, hex. The exact bytes two devices must agree on. */
  publicKeyHex: string | null
  /**
   * ⭐ THE MOST USEFUL FIELD ON THIS SCREEN, AND IT COSTS NOTHING EXTRA.
   *
   * `SignerAccount.name` is filled by the SDK from `account.getUserId().primaryUsername` during
   * `connect()` — verified in `@parity/product-sdk-signer/src/providers/host.ts`
   * `fetchProductSignerAccount`, whose `dappName` branch passes `requestName = true`. So the
   * username is ALREADY IN HAND after the handshake, and this panel needs no `getUserId()` call of
   * its own (which the SDK's own comment says "triggers a host identity-permission prompt").
   *
   * `null` when that fetch failed — `NotConnected`, `PermissionDenied` and codec drift all resolve
   * to null there, which is why the panel reports the absence rather than a name.
   */
  name: string | null
  /** `ProviderType` — "host" inside the container. */
  source: string | null
}

/**
 * Everything `session.ts` learned about identity during the handshake it was already performing.
 *
 * ⚠️ RECORDED, NOT FETCHED. Adding a host call to fill a field here would put an identity RPC on the
 * load path of every anonymous reader. Every value below is a by-product of work the session does
 * anyway.
 */
export interface HostIdentitySnapshot {
  /** Epoch ms the snapshot was written. */
  at: number

  /* -- what we ASKED for ------------------------------------------------- */
  /** `App.tsx` `APP_NAME`, passed straight through as `SignerManager({ dappName })`. */
  dappName: string
  /** What `productIdentifierFromDappName` makes of it. The second derivation junction. */
  productIdentifierRequested: string
  /** The SDK hardcodes 0 on the `dappName` path. Not configurable from here. */
  derivationIndex: number

  /* -- what came BACK ---------------------------------------------------- */
  connect: 'pending' | 'ok' | 'failed'
  connectError: string | null
  /** ⚠️ THE WHOLE LIST, not just the selected one. A second account is itself the finding. */
  accounts: SnapshotAccount[]
  selected: SnapshotAccount | null
  signerStatus: string | null
  activeProvider: string | null
  signerError: string | null

  /* -- the session it happened in ---------------------------------------- */
  /**
   * ⚠️ NULLABLE, AND THE NULL IS THE POINT. The snapshot is published BEFORE the container check
   * runs, so `false` here would be a fabricated default sitting in the field where a measurement
   * belongs — the exact thing this panel refuses to do everywhere else.
   */
  sdkInstalled: boolean | null
  insideContainer: boolean | null
  chainEnvironment: string
  bulletinNetworkPreferred: string
  chainReaderLabel: string | null
}

export function emptySnapshot(): HostIdentitySnapshot {
  return {
    at: 0,
    dappName: '',
    productIdentifierRequested: '',
    derivationIndex: 0,
    connect: 'pending',
    connectError: null,
    accounts: [],
    selected: null,
    signerStatus: null,
    activeProvider: null,
    signerError: null,
    sdkInstalled: null,
    insideContainer: null,
    chainEnvironment: '',
    bulletinNetworkPreferred: '',
    chainReaderLabel: null,
  }
}

/* ================================================================== store == */

/**
 * ⚠️ A MODULE STORE, AND THE REASON IS STRUCTURAL RATHER THAN LAZY.
 *
 * The panel lives in `SettingsView`, which `App.tsx` renders with a fixed prop list. `App.tsx` is
 * owned by another change and must not grow an `identity` prop for this, and `useHostSession` must
 * not be called a second time from a leaf — that hook opens a BACKEND PER MOUNT (see its header), so
 * a settings panel calling it would open a second container session and double every permission
 * round trip. One backend exists per page, so one record per page is the honest shape.
 *
 * The same reasoning `hooks/useDiagnostics.tsx` writes down for the boot console.
 */
let current: HostIdentitySnapshot | null = null
const listeners = new Set<(snapshot: HostIdentitySnapshot | null) => void>()

/** `null` until a host session has reported. `?backend=fake` never reports, and that is correct. */
export function getHostIdentity(): HostIdentitySnapshot | null {
  return current
}

/** Called by `session.ts` only. Replaces wholesale — a partial merge would hide a lost field. */
export function setHostIdentity(snapshot: HostIdentitySnapshot): void {
  current = snapshot
  for (const listener of listeners) listener(current)
}

export function subscribeHostIdentity(
  listener: (snapshot: HostIdentitySnapshot | null) => void,
): () => void {
  listeners.add(listener)
  listener(current)
  return () => {
    listeners.delete(listener)
  }
}

/* =========================================================== derived rule == */

/**
 * ⭐ THE TRANSFORMATION THAT PICKS THE ACCOUNT, REIMPLEMENTED HERE ON PURPOSE.
 *
 * Verbatim from `@parity/product-sdk-signer/src/providers/host.ts` (the shipped source, read
 * 2026-07-31):
 *
 * ```js
 * function productIdentifierFromDappName(dappName) {
 *   const isLocalHost = /^(?:localhost|127\.0\.0\.1|[^:]+\.localhost)(?::\d+)?$/i.test(dappName);
 *   return dappName.endsWith(".dot") || isLocalHost ? dappName : `${dappName}.dot`;
 * }
 * ```
 *
 * ⚠️ IT IS NOT EXPORTED FROM THE PACKAGE — it is module-private in `providers/host.ts`, so it cannot
 * be imported and shown "honestly as the SDK's own value". Copying the rule and citing the file is
 * the next best thing, and the panel labels the field as DERIVED BY US rather than reported by the
 * host, so nobody can mistake it for a measurement.
 *
 * ⛔ AND THIS IS THE LANDMINE, NOT A CURIOSITY: `APP_NAME = 'plaza'` becomes `plaza.dot`, while the
 * bundle is published as `plaza-social.dot`. `productId` is the second derivation junction, so those
 * are two different accounts (`plaza.dot` idx 0 → `5Feyyz…`, `plaza-social.dot` idx 0 → `5DfG1E…`
 * for one wallet, measured). Do NOT "fix" it by renaming — that orphans the profile and the two
 * threads already on chain. See STATUS.md.
 */
export function productIdentifierFromDappName(dappName: string): string {
  const isLocalHost = /^(?:localhost|127\.0\.0\.1|[^:]+\.localhost)(?::\d+)?$/i.test(dappName)
  return dappName.endsWith('.dot') || isLocalHost ? dappName : `${dappName}.dot`
}

/**
 * The DotNS name this bundle is actually published under.
 *
 * ⚠️ A REPO CONSTANT, NOT A MEASUREMENT. Nothing at runtime tells the app which DotNS name served
 * it — the page only knows its sandbox hostname. Sourced from `docs/products-platform/STATUS.md`
 * and labelled as such in the panel, so it can never be read as something the host said.
 */
export const DEPLOYED_DOT_NAME = 'plaza-social.dot'

/* ============================================================ environment == */

/**
 * What the PAGE is, as opposed to what the app asked to be. Every field is read from a browser
 * global and every one of them is nullable, because this same code runs in `node --test`.
 */
export interface PageEnvironment {
  hostname: string | null
  origin: string | null
  href: string | null
  /** `lib/host/container.ts` `productIdentifier()` — display-only; see the field's note. */
  containerProductIdentifier: string | null
  inIframe: boolean | null
  referrer: string | null
  /** Chromium only. The parent chain of a nested browsing context, outermost last. */
  ancestorOrigins: string[] | null
  /** The bundle chunk's own URL. On a Bulletin-served build this carries the bundle CID. */
  moduleUrl: string | null
  userAgent: string | null
  /** Key NAMES only, sorted. Values are disclosed for exactly one prefix — see below. */
  localStorageKeys: string[] | null
  /**
   * `product-sdk:signer:{dappName}:selectedAccount` — the address the SDK persisted for THIS
   * browser profile. A stale one here is a concrete, checkable cause of a surprising account.
   */
  persistedSelectedAccount: string | null
  /** Declared `@parity/*` ranges from `frontend/package.json`. NOT the resolved versions. */
  sdkRanges: Array<[string, string]> | null
  /** `import.meta.env.MODE`. Read by the caller so this module stays free of bundler globals. */
  buildMode: string | null
}

export function emptyEnvironment(): PageEnvironment {
  return {
    hostname: null,
    origin: null,
    href: null,
    containerProductIdentifier: null,
    inIframe: null,
    referrer: null,
    ancestorOrigins: null,
    moduleUrl: null,
    userAgent: null,
    localStorageKeys: null,
    persistedSelectedAccount: null,
    sdkRanges: null,
    buildMode: null,
  }
}

/* ================================================================ report == */

export interface ReportInput {
  snapshot: HostIdentitySnapshot | null
  environment: PageEnvironment
  /** `HostSession.label` — "Polkadot host container", "fake backend (…)". */
  backendLabel: string
  /** `capabilities.address` — the single string the rest of the app branches on. */
  capabilityAddress: string | null
  capabilityInsideHost: boolean
}

/** The reason used everywhere a field needs a host session that never happened. */
function noSession(label: string): string {
  return `no host session has reported — ${label}`
}

/**
 * Build the whole report. PURE, so it has tests and so the COPY ALL block and the on-screen list
 * cannot drift apart: they are two renderings of this one array.
 */
export function buildIdentityReport(input: ReportInput): IdentitySection[] {
  const { snapshot, environment: env, backendLabel, capabilityAddress, capabilityInsideHost } = input

  const fake = /fake backend/i.test(backendLabel)

  /**
   * ⚠️ THE REASON MUST MATCH THE STAGE THE SESSION ACTUALLY REACHED, and getting this wrong is the
   * one way this panel could mislead. An early version said "the SDK asked and got nothing back"
   * for a session in which `connect()` HAD NEVER RUN — a confident false statement about the host,
   * produced by the very screen built to stop people making those. Four distinct stages, four
   * sentences.
   */
  const connected = snapshot?.connect === 'ok'
  const absent = !snapshot
    ? fake
      ? 'the fake backend does not derive a product account (?backend=fake). Open Plaza inside the Polkadot app to read this.'
      : noSession('the wallet handshake has not reported an account')
    : snapshot.connect === 'pending'
      ? 'the wallet handshake never ran in this session — it stopped earlier. See signer.connect and the DIAGNOSTICS record above.'
      : snapshot.connect === 'failed'
        ? `the wallet handshake FAILED, so no account was ever derived: ${snapshot.connectError ?? 'no reason recorded'}`
        : 'connect() succeeded but the host supplied no such field'

  const account = snapshot?.selected ?? snapshot?.accounts[0] ?? null

  /* -- 1. the account, as handed to us ------------------------------------ */
  const accountFields: IdentityField[] = [
    {
      key: 'account.ss58',
      value: present(account?.address, absent),
      source: 'SignerManager.connect() → SignerAccount.address',
    },
    {
      key: 'account.h160',
      value: present(account?.h160Address, absent),
      source: 'SignerManager.connect() → SignerAccount.h160Address',
    },
    {
      key: 'account.publicKey',
      value: present(
        account?.publicKeyHex,
        // The trailing clause explains what is missing, not why — a reader who has never seen this
        // panel needs to know that this field, not the address, is the exact comparison.
        `${absent} It is the derived product-account public key, the exact bytes two devices must agree on.`,
      ),
      source: 'SignerManager.connect() → SignerAccount.publicKey (hex)',
    },
    {
      key: 'account.primaryUsername',
      value: present(
        account?.name,
        connected
          ? 'connect() succeeded and the username came back empty — the SDK\'s own getUserId() call inside connect() answered NotConnected, PermissionDenied, or drifted on codec, all of which it resolves to null. ⭐ THIS IS THE FIELD gotchas.md ASKS YOU TO COMPARE ACROSS DEVICES, so its absence is worth reporting.'
          : absent,
      ),
      source:
        'SignerAccount.name, which product-sdk-signer fills from account.getUserId().primaryUsername during connect()',
    },
    {
      key: 'account.provider',
      value: present(account?.source, absent),
      source: 'SignerManager.connect() → SignerAccount.source (ProviderType)',
    },
    {
      key: 'account.count',
      // ⚠️ Gated on `connected`, not on `snapshot`. A count of 0 from a handshake that never ran is
      // a number that looks like a measurement and is not one.
      value: connected ? value(String(snapshot.accounts.length)) : unavailable(absent),
      source: 'SignerManager.getState().accounts.length',
    },
    {
      key: 'capabilities.address',
      value: present(
        capabilityAddress,
        'this session has no account — an anonymous reader, or a refused handshake',
      ),
      source: 'Capabilities.address — h160Address ?? address, the string the rest of the app branches on',
    },
    {
      key: 'capabilities.insideHost',
      value: value(String(capabilityInsideHost)),
      source: 'Capabilities.insideHost',
    },
  ]

  // Every OTHER account, in full. A second entry here would change the diagnosis completely, so it
  // is listed rather than counted.
  const others = (snapshot?.accounts ?? []).filter((a) => a.address !== account?.address)
  if (others.length === 0) {
    accountFields.push({
      key: 'account.others',
      value: connected
        ? value('none — the host handed over exactly one account')
        : unavailable(absent),
      source: 'SignerManager.getState().accounts, minus the selected one',
    })
  } else {
    others.forEach((other, i) => {
      accountFields.push({
        key: `account.other[${i}]`,
        value: value(
          `${other.address ?? '(no ss58)'} · ${other.h160Address ?? '(no h160)'} · name=${other.name ?? '(none)'}`,
        ),
        source: 'SignerManager.getState().accounts',
      })
    })
  }

  accountFields.push(
    {
      key: 'signer.status',
      value: present(snapshot?.signerStatus, absent),
      source: 'SignerManager.getState().status',
    },
    {
      key: 'signer.activeProvider',
      value: present(snapshot?.activeProvider, absent),
      source: 'SignerManager.getState().activeProvider',
    },
    {
      key: 'signer.error',
      // `valueOr`, not `present`: once connect() has run, "no error" is something we KNOW, and
      // `unavailable — none` would read as "we could not find out", which is the opposite.
      value: connected
        ? valueOr(snapshot.signerError, 'none — the signer reported no error')
        : unavailable(absent),
      source: 'SignerManager.getState().error',
    },
    {
      // Always a value once a session exists — the STAGE is itself the finding, and every other
      // reason on this screen points at it.
      key: 'signer.connect',
      value: present(snapshot?.connect, absent),
      source: 'session.ts — the outcome of SignerManager.connect(): pending | ok | failed',
    },
    {
      key: 'signer.connectError',
      value: snapshot
        ? snapshot.connect === 'failed'
          ? valueOr(snapshot.connectError, 'connect() failed but recorded no reason')
          : value(`none — connect() is "${snapshot.connect}" and threw nothing`)
        : unavailable(absent),
      source: 'session.ts — the exception connect() threw, if any',
    },
  )

  /* -- 2. what we asked the host FOR -------------------------------------- */
  const askedFields: IdentityField[] = [
    {
      key: 'asked.dappName',
      value: present(snapshot?.dappName, noSession("App.tsx's APP_NAME is 'plaza'; nothing has used it yet")),
      source: "App.tsx APP_NAME → useHostSession(appName) → SignerManager({ dappName })",
    },
    {
      key: 'asked.productIdentifier',
      value: present(
        snapshot?.productIdentifierRequested,
        noSession(`the rule would give "${productIdentifierFromDappName('plaza')}" for APP_NAME 'plaza'`),
      ),
      source:
        'DERIVED BY US with the SDK\'s own rule (dappName.endsWith(".dot") || isLocalhost ? dappName : dappName + ".dot"), copied from product-sdk-signer/src/providers/host.ts — that function is module-private and cannot be imported',
    },
    {
      key: 'asked.derivationIndex',
      value: snapshot ? value(String(snapshot.derivationIndex)) : value('0'),
      source:
        'hardcoded 0 by the SDK on the dappName path — fetchProductSignerAccount(provider, id, 0, true)',
    },
    {
      key: 'deployed.dotName',
      value: value(DEPLOYED_DOT_NAME),
      source:
        'A REPO CONSTANT from docs/products-platform/STATUS.md, not a measurement. Nothing at runtime tells the page which DotNS name served it. ⛔ If this differs from asked.productIdentifier, the two are DIFFERENT ACCOUNTS by construction — and renaming APP_NAME is a migration, not a fix.',
    },
    {
      key: 'host.reportedProductIdentifier',
      value: unavailable(
        'THE HOST NEVER REPORTS ONE. ACCOUNT_GET_ACCOUNT takes { productAccountId: { dotNsIdentifier, derivationIndex } } and answers { account: { publicKey } } — the identifier is an INPUT and appears nowhere in the reply (@parity/truapi generated types, HostAccountGetResponse). So the host cannot tell us what it thought it derived for.',
      ),
      source: '@parity/truapi HostAccountGetResponse — checked, not assumed',
    },
    {
      key: 'host.reportedDomain',
      value: unavailable(
        'no such field anywhere in the account domain. The protocol does have a DomainNotValid error variant on HostAccountGetError, so a host CAN reject an identifier — but a host that silently substitutes one would be invisible from here.',
      ),
      source: '@parity/truapi HostAccountGetError / HostAccountGetResponse',
    },
  ]

  /* -- 3. what the page actually IS --------------------------------------- */
  const pageFields: IdentityField[] = [
    {
      key: 'page.hostname',
      value: present(env.hostname, 'no window.location in this environment'),
      source: 'location.hostname',
    },
    {
      key: 'page.origin',
      value: present(env.origin, 'no window.location in this environment'),
      source: 'location.origin',
    },
    {
      key: 'page.href',
      value: present(env.href, 'no window.location in this environment'),
      source: 'location.href',
    },
    {
      key: 'page.containerProductIdentifier',
      value: present(env.containerProductIdentifier, 'no window.location in this environment'),
      source:
        'lib/host/container.ts productIdentifier() — it returns location.hostname and is used ONLY for the diagnostics display. ⚠️ It is NEVER passed to SignerManager, so it takes no part in the derivation.',
    },
    {
      key: 'page.inIframe',
      value: env.inIframe === null ? unavailable('no window in this environment') : value(String(env.inIframe)),
      source: 'window.top !== window.self',
    },
    {
      key: 'page.referrer',
      value: present(env.referrer, 'empty — no referrer was sent for this document'),
      source: 'document.referrer — the shell that framed us, when it discloses one',
    },
    {
      key: 'page.ancestorOrigins',
      value:
        env.ancestorOrigins === null
          ? unavailable('location.ancestorOrigins is Chromium-only and absent here (Safari/Firefox/WebViews)')
          : env.ancestorOrigins.length === 0
            ? value('none — this document is not framed')
            : value(env.ancestorOrigins.join(' < ')),
      source: 'location.ancestorOrigins — the real parent chain, innermost first',
    },
    {
      key: 'page.moduleUrl',
      value: present(env.moduleUrl, 'import.meta.url is unavailable in this environment'),
      source:
        "import.meta.url — the built chunk's own URL. On a Bulletin-served build the bundle CID is in this path, which identifies WHICH BUILD produced these readings.",
    },
    {
      key: 'page.userAgent',
      value: present(env.userAgent, 'no navigator in this environment'),
      source: 'navigator.userAgent — distinguishes a phone WebView from a desktop browser tab',
    },
    {
      key: 'page.buildMode',
      value: present(env.buildMode, 'no bundler environment (this is the node test runner)'),
      source: 'import.meta.env.MODE',
    },
  ]

  /* -- 4. host / container / SDK ------------------------------------------ */
  const hostFields: IdentityField[] = [
    { key: 'backend.label', value: value(backendLabel), source: 'HostBackend.label' },
    {
      key: 'sdk.installed',
      value:
        typeof snapshot?.sdkInstalled === 'boolean'
          ? value(String(snapshot.sdkInstalled))
          : unavailable(snapshot ? 'the container check has not run yet in this session' : absent),
      source: 'lib/host/sdk.ts sdkAvailable()',
    },
    {
      key: 'container.inside',
      value:
        typeof snapshot?.insideContainer === 'boolean'
          ? value(String(snapshot.insideContainer))
          : unavailable(snapshot ? 'the container check has not run yet in this session' : absent),
      source: 'lib/host/container.ts insideContainer() → isInsideContainerSync()',
    },
    {
      key: 'chain.environment',
      value: present(snapshot?.chainEnvironment, absent),
      source: 'session.ts — the Asset Hub descriptor environment the session opened with',
    },
    {
      key: 'chain.readerLabel',
      value: present(snapshot?.chainReaderLabel, 'no chain reader was created (?rpc=off, or outside the host)'),
      source: 'ChainReader.label',
    },
    {
      key: 'chain.genesisHash',
      value: unavailable(
        'not read. Reading it opens the chain connection, and this panel makes NO host calls by contract — see the header. The Bulletin network that won is in the DIAGNOSTICS "bulletin" line above.',
      ),
      source: 'deliberately not fetched',
    },
    {
      key: 'bulletin.preferredNetwork',
      value: present(snapshot?.bulletinNetworkPreferred, absent),
      source: 'session.ts — the requested Bulletin preset (the one that WON is in DIAGNOSTICS)',
    },
    {
      key: 'sdk.declaredRanges',
      value:
        env.sdkRanges === null
          ? unavailable('frontend/package.json could not be read in this environment')
          : value(env.sdkRanges.map(([name, range]) => `${name}@${range}`).join(', ')),
      source:
        '⚠️ frontend/package.json dependencies — the DECLARED RANGES, not the resolved installed versions. No @parity package exports a runtime version constant.',
    },
    {
      key: 'storage.persistedSelectedAccount',
      value: present(
        env.persistedSelectedAccount,
        'nothing persisted under product-sdk:signer:<dappName>:selectedAccount for this origin',
      ),
      source:
        'localStorage["product-sdk:signer:{dappName}:selectedAccount"] — the account THIS browser profile last selected',
    },
    {
      key: 'storage.keys',
      value:
        env.localStorageKeys === null
          ? unavailable('localStorage is unavailable in this environment')
          : value(env.localStorageKeys.join(', ')),
      source:
        'localStorage key NAMES only. ⛔ Values are deliberately not dumped — one of these could carry something private, and this block gets pasted into a chat.',
    },
  ]

  /* -- 5. what was deliberately NOT done ---------------------------------- */
  //
  // ⚠️ THIS SECTION IS NOT AN APOLOGY. Each line is a fact about the platform that a reader would
  // otherwise have to rediscover, and each one names the rule that stopped us.
  const notDoneFields: IdentityField[] = [
    {
      key: 'notCalled.getUserId',
      value: unavailable(
        'not called by this panel — and it does not need to be. The SDK already calls it during connect() and the result is account.primaryUsername above. Calling it again would prompt: "getUserId triggers a host identity-permission prompt" (product-sdk-signer, its own words).',
      ),
      source: '@parity/product-sdk-host AccountsProvider.getUserId',
    },
    {
      key: 'notCalled.getLegacyAccounts',
      value: unavailable(
        '⭐ THE MOST DECISIVE FIELD WE CANNOT SAFELY READ. It lists the user\'s own (non-product) wallet accounts, i.e. the ROOT side of the derivation. It is an extra host call that can prompt for identity disclosure, and this panel is read-only by contract — so it is not called. If the investigation stalls here, this is the next thing to build, behind an explicit user-pressed control.',
      ),
      source: '@parity/product-sdk-host AccountsProvider.getLegacyAccounts',
    },
    {
      key: 'notCalled.createRingVRFProof',
      value: unavailable(
        'not called — generating a ring-VRF proof is a signing operation. Nothing on this screen signs.',
      ),
      source: '@parity/product-sdk-host AccountsProvider.createRingVRFProof',
    },
    {
      key: 'notCalled.getProductAccountAlias',
      value: unavailable(
        'not called — the contextual alias is derived from a proof context, not from the account, and it answers a different question (ring membership) than this panel asks.',
      ),
      source: '@parity/product-sdk-host AccountsProvider.getProductAccountAlias',
    },
    {
      key: 'notDerived.accountId32FromH160',
      value: unavailable(
        '⛔ NEVER DERIVED, AND THE PANEL WILL NOT ADD IT. h160ToSs58() yields a DIFFERENT account nobody holds a key for — measured against the real user: OriginalAccount gives 5EJ3VTQ…, the derivation gives 5CcnRhQ…. Paying the second destroys the money. Revive.OriginalAccount is the only sound route (session.ts resolveRecipient).',
      ),
      source: 'lib/recipient.ts / gotchas.md — a lookup, never a computation',
    },
    {
      key: 'notKnown.rootPublicKey',
      value: unavailable(
        'the host never discloses it. The product account is publicSoft(rootPublicKey, ["product", productId, index]) and the ROOT is the one input we cannot see — which is exactly why primaryUsername is the diagnostic to compare across devices instead.',
      ),
      source: '@parity/product-sdk-keys deriveProductAccountPublicKey — the parent key stays on the host',
    },
  ]

  return [
    {
      title: 'ACCOUNT, AS HANDED TO US',
      note: 'Full values, never truncated. Compare account.primaryUsername across the two devices FIRST — same username means one identity and a pairing problem; different usernames mean two identities.',
      fields: accountFields,
    },
    {
      title: 'WHAT WE ASKED THE HOST FOR',
      note: 'The second junction of the derivation. If two devices ask for different identifiers they get different accounts, whatever the wallet does.',
      fields: askedFields,
    },
    { title: 'WHAT THIS PAGE ACTUALLY IS', fields: pageFields },
    { title: 'HOST, CONTAINER AND SDK', fields: hostFields },
    {
      title: 'NOT CALLED, AND WHY',
      note: 'Absences with reasons. Each one is a fact about the platform, not a gap in this panel.',
      fields: notDoneFields,
    },
  ]
}

/* =============================================================== copy all == */

/**
 * ⭐ THE HIGHEST-VALUE CONTROL ON THE SCREEN, so it is a pure function with tests.
 *
 * The user reads this off a phone and pastes it into a chat. Therefore: one `key: value` per line,
 * plain ASCII, no box-drawing, no truncation ever, and the provenance as a trailing `#` comment so
 * a line stays a line. A header names the build, so a later reading can be told apart from this one.
 */
export function formatIdentityReport(
  sections: IdentitySection[],
  options: { generatedAt: number; diagnostics?: Array<{ id: string; status: string; detail: string }> },
): string {
  const lines: string[] = []
  lines.push('PLAZA DEBUG / IDENTITY')
  lines.push(`generated: ${new Date(options.generatedAt).toISOString()}`)
  lines.push('')

  for (const section of sections) {
    lines.push(`== ${section.title}`)
    for (const field of section.fields) {
      const rendered =
        field.value.status === 'value' ? field.value.value : `unavailable — ${field.value.reason}`
      lines.push(`${field.key}: ${rendered}   # ${field.source}`)
    }
    lines.push('')
  }

  if (options.diagnostics && options.diagnostics.length > 0) {
    lines.push('== DIAGNOSTICS (the session record, same as the panel above)')
    for (const step of options.diagnostics) {
      lines.push(`diag.${step.id}: ${step.status}${step.detail ? ` — ${step.detail}` : ''}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
