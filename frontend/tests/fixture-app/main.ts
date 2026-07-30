/**
 * Probe app for the Polkadot Products host protocol.
 *
 * This is NOT part of Plaza. It is a deliberately minimal "product" that gets
 * embedded by `@parity/host-api-test-sdk`'s test host so Playwright can drive
 * real `@parity/product-sdk` calls and observe what the host actually does.
 *
 * Everything is exposed on `window.__PROBE__` so a test can call one thing at a
 * time and read the raw result, rather than baking assertions into the page.
 */

const logEl = document.getElementById('log') as HTMLPreElement;
const statusEl = document.getElementById('status') as HTMLSpanElement;

const lines: string[] = [];
function log(msg: string) {
  lines.push(msg);
  logEl.textContent = lines.join('\n');
  console.log('[probe]', msg);
}

/** JSON.stringify that survives bigint, Uint8Array, Error and cyclic values. */
function safe(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === 'bigint') return `${v}n`;
    if (v instanceof Uint8Array) return `u8a(${v.length}):${Array.from(v.slice(0, 32)).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    if (v instanceof Error) return { __error: v.name, message: v.message, ...(v as unknown as Record<string, unknown>) };
    if (typeof v === 'function') return `[function ${v.name}]`;
    if (v && typeof v === 'object') {
      if (seen.has(v as object)) return '[cyclic]';
      seen.add(v as object);
      if (Array.isArray(v)) return v.map(walk);
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>)) {
        out[k] = walk((v as Record<string, unknown>)[k]);
      }
      // surface class name so `Result`/error wrappers are identifiable
      const ctor = (v as object).constructor?.name;
      if (ctor && ctor !== 'Object') out.__ctor = ctor;
      return out;
    }
    return v;
  };
  return walk(value);
}

type ProbeResult = { ok: true; value: unknown } | { ok: false; error: unknown };

/** Minimal shape of the decoded metadata we actually read. */
interface MetaV {
  lookup: Array<{ id: number; def?: { value?: unknown } }>;
  pallets: Array<{ name: string; index: number; calls?: number | { type: number } | null }>;
}

async function attempt(label: string, fn: () => unknown): Promise<ProbeResult> {
  try {
    const value = await fn();
    log(`${label} -> ${JSON.stringify(safe(value))}`);
    return { ok: true, value: safe(value) };
  } catch (e) {
    log(`${label} THREW ${String(e)}`);
    return { ok: false, error: safe(e) };
  }
}

const probe = {
  /** 2 — prove the harness supplies a container. */
  async detectContainer() {
    const host = await import('@parity/product-sdk-host');
    return {
      sync: await attempt('isInsideContainerSync()', () => host.isInsideContainerSync()),
      async: await attempt('isInsideContainer()', () => host.isInsideContainer()),
      truApi: await attempt('getTruApi() != null', async () => (await host.getTruApi()) !== null),
      accountsProvider: await attempt(
        'getAccountsProvider() != null',
        async () => (await host.getAccountsProvider()) !== null,
      ),
      localStorage: await attempt(
        'getHostLocalStorage() != null',
        async () => (await host.getHostLocalStorage()) !== null,
      ),
    };
  },

  /** 2 — session handshake + account resolution (sdk-notes §1). */
  async handshake() {
    const host = await import('@parity/product-sdk-host');
    const provider = await host.getAccountsProvider();
    if (!provider) return { error: 'getAccountsProvider() returned null' };

    const legacy = await attempt('getLegacyAccounts()', () =>
      provider.getLegacyAccounts().match(
        (v: unknown) => ({ tag: 'ok', value: v }),
        (e: unknown) => ({ tag: 'err', error: e }),
      ),
    );
    const chainSubmit = await attempt('requestPermission(ChainSubmit)', () =>
      host.requestPermission({ tag: 'ChainSubmit', value: undefined } as never),
    );
    const productAccount = await attempt('getProductAccount(0)', () =>
      // signature differs across versions; probe reflectively
      (provider as unknown as Record<string, (i: number) => { match: (a: (v: unknown) => unknown, b: (e: unknown) => unknown) => unknown }>)
        .getProductAccount?.(0)
        ?.match(
          (v: unknown) => ({ tag: 'ok', value: v }),
          (e: unknown) => ({ tag: 'err', error: e }),
        ) ?? 'getProductAccount not present on provider',
    );
    const userId = await attempt('getUserId()', async () => {
      const api = await host.getTruApi();
      const anyApi = api as unknown as Record<string, () => unknown>;
      return anyApi?.getUserId ? await anyApi.getUserId() : 'no getUserId on TruApi';
    });

    return { legacy, chainSubmit, productAccount, userId };
  },

  /** List the method names the provider / truapi actually expose at runtime. */
  async surface() {
    const host = await import('@parity/product-sdk-host');
    const provider = await host.getAccountsProvider();
    const api = await host.getTruApi();
    const names = (o: unknown) => {
      if (!o) return null;
      const out = new Set<string>();
      let cur: object | null = o as object;
      while (cur && cur !== Object.prototype) {
        for (const k of Object.getOwnPropertyNames(cur)) out.add(k);
        cur = Object.getPrototypeOf(cur) as object | null;
      }
      return [...out].sort();
    };
    return { hostExports: Object.keys(host).sort(), provider: names(provider), truApi: names(api) };
  },

  /** 3a — the allowance request, spelled both ways. */
  async requestAllowance(tag: string, value?: unknown) {
    const host = await import('@parity/product-sdk-host');
    return attempt(`requestResourceAllocation([{tag:'${tag}'}])`, () =>
      host.requestResourceAllocation([{ tag, value } as never]),
    );
  },

  /** 3a — several tags in one call, to see per-resource outcome ordering. */
  async requestAllowances(tags: string[]) {
    const host = await import('@parity/product-sdk-host');
    return attempt(`requestResourceAllocation(${JSON.stringify(tags)})`, () =>
      host.requestResourceAllocation(tags.map((tag) => ({ tag, value: undefined })) as never),
    );
  },

  /**
   * 3b — the real Cloud Storage client, up to but NOT including `send()`.
   *
   * `StoreBuilder` has no sign-only path — `send()` is the only terminal — so
   * this deliberately stops at `checkAuthorization`, which is a read. It answers
   * "does the SDK's cloud-storage client construct and connect inside the host,
   * and does the chain consider the product account authorized to store", which
   * is the precondition every Bulletin write depends on.
   */
  async bulletinStore(environment: 'paseo' | 'devnet' = 'paseo') {
    const host = await import('@parity/product-sdk-host');
    return attempt(`CloudStorageClient.create({environment:'${environment}'})`, async () => {
      const cs = await import('@parity/product-sdk-cloud-storage');
      const provider = await host.getAccountsProvider();
      if (!provider) return 'no accounts provider';
      const acct = await provider.getProductAccount('probe.dot', 0).match(
        (v) => v,
        (e) => ({ __err: e }) as never,
      );
      if ((acct as unknown as { __err?: unknown }).__err) return { getProductAccountFailed: safe(acct) };
      const signer = provider.getProductAccountSigner(acct);

      let client: Awaited<ReturnType<typeof cs.CloudStorageClient.create>> | null = null;
      try {
        client = await cs.CloudStorageClient.create({ environment, signer } as never);
      } catch (e) {
        return { createThrew: String(e) };
      }
      try {
        const address = (await import('@polkadot-api/substrate-bindings')).AccountId()
          .dec(acct.publicKey);
        const auth = await client.checkAuthorization(address);
        const builderMethods = Object.getOwnPropertyNames(
          Object.getPrototypeOf(client.store(new Uint8Array([1]))),
        ).sort();
        return { address, authorization: safe(auth), storeBuilderMethods: builderMethods };
      } catch (e) {
        return { threw: String(e) };
      } finally {
        try {
          await client.destroy();
        } catch {
          /* ignore */
        }
      }
    });
  },

  /**
   * 3b — the host preimage path Cloud Storage reads/writes sit on.
   * `PreimageManager.submit(bytes): Promise<HexString>` — a plain promise, no
   * Result wrapper.
   */
  async preimageSubmit(text: string) {
    const host = await import('@parity/product-sdk-host');
    return attempt('preimageManager.submit', async () => {
      const mgr = await host.getPreimageManager();
      if (!mgr) return 'getPreimageManager() returned null';
      const shape = Object.keys(mgr).sort();
      try {
        const key = await mgr.submit(new TextEncoder().encode(text));
        return { shape, key, keyType: typeof key };
      } catch (e) {
        return { shape, threw: String(e) };
      }
    });
  },

  /**
   * 3b — statement store submit, the other allowance-backed write.
   * `Statement` fields are hex strings (`topics: HexString[]`, `data: HexString`),
   * not byte arrays — passing Uint8Array throws inside the codec.
   */
  async statementSubmit(topicText: string, bodyText: string) {
    const host = await import('@parity/product-sdk-host');
    return attempt('statementStore createProofAuthorized + submit', async () => {
      const store = await host.getStatementStore();
      if (!store) return 'getStatementStore() returned null';
      const shape = Object.keys(store).sort();
      const hex = (u: Uint8Array) => `0x${Array.from(u).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
      const topic32 = new Uint8Array(32);
      topic32.set(new TextEncoder().encode(topicText).slice(0, 32));
      const statement = { topics: [hex(topic32)], data: hex(new TextEncoder().encode(bodyText)) };

      let proof: unknown;
      try {
        const r = await host.createProofAuthorized(statement as never);
        proof = r;
      } catch (e) {
        proof = { threw: String(e) };
      }

      // unwrap @parity/result
      const proofValue =
        proof && typeof proof === 'object' && 'ok' in (proof as object)
          ? (proof as { ok: boolean; value?: unknown; error?: unknown }).ok
            ? (proof as { value: unknown }).value
            : undefined
          : undefined;

      let submitted: unknown;
      if (proofValue === undefined) {
        submitted = 'skipped — no proof';
      } else {
        try {
          await store.submit({ ...statement, proof: proofValue } as never);
          submitted = 'ok';
        } catch (e) {
          submitted = { threw: String(e) };
        }
      }
      return { shape, proof: safe(proof), submitted: safe(submitted) };
    });
  },

  /** Raw-bytes signing via the host, using the product account's signer. */
  async hostSignBytes(text: string) {
    const host = await import('@parity/product-sdk-host');
    return attempt('signer.signBytes', async () => {
      const provider = await host.getAccountsProvider();
      if (!provider) return 'no accounts provider';
      const acct = await provider.getProductAccount('probe.dot', 0).match(
        (v) => v,
        (e) => ({ __err: e }) as never,
      );
      if ((acct as unknown as { __err?: unknown }).__err) return { getProductAccountFailed: safe(acct) };
      const signer = provider.getProductAccountSigner(acct);
      const sig = await signer.signBytes(new TextEncoder().encode(text));
      return { signerKeys: Object.keys(signer), signature: sig };
    });
  },

  /**
   * 3b/3c — build a real extrinsic against a real chain and SIGN IT, without
   * broadcasting. `.sign()` on a PAPI tx returns the signed bytes and never
   * submits, so this exercises the host's signing path (the thing that prompts)
   * with zero on-chain effect.
   *
   * @param genesisHash which network the host should proxy to
   * @param pallet      e.g. 'TransactionStorage' (Bulletin) or 'Revive' (contracts)
   * @param call        e.g. 'store' or 'call'
   * @param args        JSON-ish call args; `{__bytes: 'hex'}` becomes a Uint8Array
   * @param useLegacy   sign with the user's wallet account instead of the product account
   */
  async chainSignTx(
    genesisHash: string,
    pallet: string,
    call: string,
    args: Record<string, unknown>,
    useLegacy = false,
  ) {
    const host = await import('@parity/product-sdk-host');
    return attempt(`sign ${pallet}.${call} on ${genesisHash.slice(0, 10)} (legacy=${useLegacy})`, async () => {
      const provider = await host.getAccountsProvider();
      if (!provider) return 'no accounts provider';

      const jsonRpc = await host.getHostProvider(genesisHash as `0x${string}`);
      if (!jsonRpc) return 'getHostProvider() returned null — host refused this genesis hash';

      const papi = await import('polkadot-api');
      // `polkadot-api`'s root export has no runtime `FixedSizeBinary` (only the
      // type). PAPI's compatibility check rejects a plain `Binary` in a
      // fixed-size metadata slot (H160, H256, [u8; 32]), so the real class has
      // to come from substrate-bindings.
      const { FixedSizeBinary } = await import('@polkadot-api/substrate-bindings');
      const client = papi.createClient(jsonRpc);
      try {
        const spec = await client.getChainSpecData();
        const api = client.getUnsafeApi();

        const revive = (v: unknown): unknown => {
          if (typeof v === 'string' && /^__bigint:/.test(v)) return BigInt(v.slice(9));
          if (v && typeof v === 'object') {
            const rec = v as Record<string, unknown>;
            if (typeof rec.__bytes === 'string') return papi.Binary.fromHex(rec.__bytes);
            if (typeof rec.__text === 'string') return papi.Binary.fromText(rec.__text);
            if (typeof rec.__fixed === 'string') return FixedSizeBinary.fromHex(rec.__fixed);
            if (Array.isArray(v)) return v.map(revive);
            const o: Record<string, unknown> = {};
            for (const k of Object.keys(rec)) o[k] = revive(rec[k]);
            return o;
          }
          return v;
        };

        const palletApi = (api.tx as unknown as Record<string, Record<string, (a: unknown) => unknown>>)[pallet];
        if (!palletApi) {
          const pallets = Object.keys(api.tx as unknown as object).sort();
          return { chain: spec.name, error: `no pallet ${pallet}`, pallets };
        }
        const callApi = palletApi[call];
        if (!callApi) {
          return { chain: spec.name, error: `no call ${pallet}.${call}`, calls: Object.keys(palletApi).sort() };
        }

        const tx = callApi(revive(args)) as {
          sign: (s: unknown) => Promise<Uint8Array>;
          getEncodedData: () => Promise<{ asHex: () => string }>;
        };
        const callData = await tx
          .getEncodedData()
          .then((d) => {
            const anyD = d as unknown as { asHex?: () => string };
            return typeof anyD.asHex === 'function' ? anyD.asHex() : String(d);
          })
          .catch((e) => `encode failed: ${String(e)}`);

        let signer: unknown;
        if (useLegacy) {
          const accounts = await provider.getLegacyAccounts().match(
            (v) => v,
            () => [] as never,
          );
          const first = (accounts as Array<{ publicKey: Uint8Array; name?: string }>)[0];
          if (!first) return { chain: spec.name, error: 'no legacy accounts' };
          signer = provider.getLegacyAccountSigner(first);
        } else {
          const acct = await provider.getProductAccount('probe.dot', 0).match(
            (v) => v,
            (e) => ({ __err: e }) as never,
          );
          if ((acct as unknown as { __err?: unknown }).__err) return { chain: spec.name, getProductAccountFailed: safe(acct) };
          signer = provider.getProductAccountSigner(acct);
        }

        let signed: unknown;
        try {
          const bytes = await tx.sign(signer);
          signed = { signedLength: bytes.length, prefix: Array.from(bytes.slice(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join('') };
        } catch (e) {
          signed = { threw: String(e) };
        }
        return { chain: spec.name, callData, signed };
      } finally {
        try {
          client.destroy();
        } catch {
          /* ignore */
        }
      }
    });
  },

  /**
   * What the host actually proxies: pallets and call variants read from the
   * chain's own metadata, fetched through the host's JSON-RPC proxy.
   *
   * Note `client.getUnsafeApi().tx` is a Proxy — `Object.keys()` on it returns
   * `[]`, so enumeration has to come from metadata, not from the API object.
   */
  async listCalls(genesisHash: string, pallet?: string) {
    const host = await import('@parity/product-sdk-host');
    return attempt(`listCalls(${genesisHash.slice(0, 10)}, ${pallet ?? '*'})`, async () => {
      const jsonRpc = await host.getHostProvider(genesisHash as `0x${string}`);
      if (!jsonRpc) return 'getHostProvider() returned null';
      const papi = await import('polkadot-api');
      const { decAnyMetadata } = await import('@polkadot-api/substrate-bindings');
      const client = papi.createClient(jsonRpc);
      try {
        const spec = await client.getChainSpecData();
        // NB: the host does NOT proxy legacy JSON-RPC. `state_getMetadata` comes
        // back as `-32601 Method "state_getMetadata" is not supported by the
        // host`; only the chainHead_v1_* family is bridged. So fetch metadata
        // through the runtime API instead, which rides on chainHead_v1_call.
        const api = client.getUnsafeApi();
        const opt = (await (api as unknown as {
          apis: { Metadata: { metadata_at_version: (v: number) => Promise<{ asBytes(): Uint8Array } | undefined> } };
        }).apis.Metadata.metadata_at_version(15)) as { asBytes(): Uint8Array } | undefined;
        if (!opt) return { chain: spec.name, error: 'metadata_at_version(15) returned none' };
        const bytes =
          typeof (opt as { asBytes?: unknown }).asBytes === 'function'
            ? opt.asBytes()
            : opt instanceof Uint8Array
              ? opt
              : (() => {
                  throw new Error(
                    `unexpected metadata_at_version shape: ${Object.prototype.toString.call(opt)} keys=${Object.keys(opt as object).join(',')}`,
                  );
                })();
        const meta = (decAnyMetadata(bytes) as unknown as { metadata: { value: MetaV } }).metadata.value;
        const byId = new Map(meta.lookup.map((t) => [t.id, t]));
        if (!pallet) {
          return { chain: spec.name, pallets: meta.pallets.map((p) => `${p.name}#${p.index}`) };
        }
        const p = meta.pallets.find((x) => x.name === pallet);
        if (!p) return { chain: spec.name, error: `no pallet ${pallet}`, pallets: meta.pallets.map((x) => x.name) };
        if (p.calls == null) return { chain: spec.name, pallet, index: p.index, calls: null };
        const ty = byId.get(typeof p.calls === 'object' ? (p.calls as { type: number }).type : p.calls);
        const variants = (ty?.def?.value ?? []) as Array<{
          name: string;
          fields: Array<{ name?: string; typeName?: string }>;
        }>;
        return {
          chain: spec.name,
          pallet,
          index: p.index,
          calls: variants.map((v) => `${v.name}(${v.fields.map((f) => `${f.name}: ${f.typeName}`).join(', ')})`),
        };
      } finally {
        try {
          client.destroy();
        } catch {
          /* ignore */
        }
      }
    });
  },

  /**
   * Wrap every truapi namespace method so we can count the exact host wire
   * calls an operation makes. This is the answer to "how many prompts, in what
   * order" that does not depend on the test host's own logging choices.
   */
  async installWireSpy() {
    const host = await import('@parity/product-sdk-host');
    const api = (await host.getTruApi()) as unknown as Record<string, Record<string, unknown>> | null;
    if (!api) return 'no truApi';
    const calls: Array<{ ns: string; method: string; at: number }> = [];
    (window as unknown as { __WIRE__: typeof calls }).__WIRE__ = calls;
    const wrapped: string[] = [];
    for (const ns of Object.keys(api)) {
      const group = api[ns];
      if (!group || typeof group !== 'object') continue;
      for (const method of Object.keys(group)) {
        const fn = (group as Record<string, unknown>)[method];
        if (typeof fn !== 'function') continue;
        if ((fn as { __spied?: boolean }).__spied) continue;
        const spy = function (this: unknown, ...a: unknown[]) {
          calls.push({ ns, method, at: Date.now() });
          return (fn as (...x: unknown[]) => unknown).apply(this, a);
        };
        (spy as { __spied?: boolean }).__spied = true;
        (group as Record<string, unknown>)[method] = spy;
        wrapped.push(`${ns}.${method}`);
      }
    }
    return { wrapped: wrapped.sort() };
  },

  readWireSpy() {
    return (window as unknown as { __WIRE__?: Array<{ ns: string; method: string }> }).__WIRE__ ?? [];
  },

  clearWireSpy() {
    const w = (window as unknown as { __WIRE__?: unknown[] }).__WIRE__;
    if (Array.isArray(w)) w.length = 0;
    return true;
  },

  /** Everything logged so far, for a human reading the trace. */
  getLog() {
    return lines.slice();
  },
};

declare global {
  interface Window {
    __PROBE__: typeof probe;
    __PROBE_READY__: boolean;
  }
}

window.__PROBE__ = probe;

(async () => {
  try {
    const host = await import('@parity/product-sdk-host');
    const sync = host.isInsideContainerSync();
    statusEl.textContent = sync ? 'inside-container' : 'outside-container';
    document.title = sync ? 'probe: inside-container' : 'probe: outside-container';
    log(`boot: isInsideContainerSync() = ${sync}`);
    // Actively open the transport. Nothing else in the SDK does the handshake
    // for you, so without this the host never reports a connected product and
    // `testHost.waitForConnection()` hangs forever.
    const api = await host.getTruApi().catch((e) => {
      log(`boot: getTruApi() threw ${String(e)}`);
      return null;
    });
    log(`boot: getTruApi() = ${api ? 'object' : String(api)}`);
    const provider = await host.getAccountsProvider().catch((e) => {
      log(`boot: getAccountsProvider() threw ${String(e)}`);
      return null;
    });
    log(`boot: getAccountsProvider() = ${provider ? 'object' : String(provider)}`);
  } catch (e) {
    statusEl.textContent = 'import-failed';
    log(`boot: import of @parity/product-sdk-host threw ${String(e)}`);
  }
  window.__PROBE_READY__ = true;
  const marker = document.createElement('div');
  marker.id = 'probe-ready';
  marker.textContent = 'probe ready';
  document.body.appendChild(marker);
})();
