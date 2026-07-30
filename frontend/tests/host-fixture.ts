/**
 * Reusable Playwright fixture for the Polkadot Products host protocol.
 *
 * Wraps `@parity/host-api-test-sdk`'s `createTestHostFixture` and adds the two
 * things every test here needs and the upstream fixture does not give you:
 *
 *  - `probe`: a typed handle for calling `window.__PROBE__` inside the product
 *    iframe (the upstream `productFrame()` is a `FrameLocator`, which cannot
 *    `evaluate`).
 *  - `record`: a helper that clears the signing/permission logs, runs one probe
 *    call, and returns the call result together with the logs it produced —
 *    which is the actual unit of evidence for "did this prompt?".
 *
 * Verified against @parity/host-api-test-sdk@0.11.0.
 */
import { test as base, expect, type Frame } from '@playwright/test';
import {
  createTestHostFixture,
  PASEO_ASSET_HUB,
  type TestHost,
} from '@parity/host-api-test-sdk/playwright';
import type { NetworkConfig, PermissionLogEntry, SigningLogEntry } from '@parity/host-api-test-sdk';

export const PRODUCT_URL = process.env.PROBE_URL ?? 'http://localhost:5199';

/**
 * Paseo Bulletin, the chain Cloud Storage writes to. Not one of the test SDK's
 * built-in networks, so we declare it: the test host routes by genesis hash and
 * refuses connections for hashes it was not given.
 *
 * Genesis hash verified live 2026-07-29 via `chainSpec_v1_genesisHash` against
 * `wss://paseo-bulletin-next-rpc.polkadot.io` (matches
 * `BULLETIN_RPCS.paseo` in @parity/product-sdk-host).
 */
export const PASEO_BULLETIN: NetworkConfig = {
  id: 'paseo-bulletin',
  name: 'Paseo Bulletin',
  genesisHash: '0x8cfe6717dc4becfda2e13c488a1e2061ff2dfee96e7d031157f72d36716c0a22',
  rpcUrl: 'wss://paseo-bulletin-next-rpc.polkadot.io',
  tokenSymbol: 'PAS',
  tokenDecimals: 10,
};

/** Names of probe entry points exposed by `tests/fixture-app/main.ts`. */
export type ProbeMethod =
  | 'detectContainer'
  | 'handshake'
  | 'surface'
  | 'requestAllowance'
  | 'requestAllowances'
  | 'bulletinStore'
  | 'preimageSubmit'
  | 'statementSubmit'
  | 'hostSignBytes'
  | 'chainSignTx'
  | 'listCalls'
  | 'installWireSpy'
  | 'readWireSpy'
  | 'clearWireSpy'
  | 'getLog';

export interface Recorded<T = unknown> {
  result: T;
  signingLog: SigningLogEntry[];
  permissionLog: PermissionLogEntry[];
}

export interface HostProbe {
  /** The product iframe as a `Frame` (evaluate-capable, unlike FrameLocator). */
  frame(): Promise<Frame>;
  /** Call one probe method inside the product iframe and return its raw result. */
  call<T = unknown>(method: ProbeMethod, ...args: unknown[]): Promise<T>;
  /** Call a probe method with the signing + permission logs cleared first. */
  record<T = unknown>(method: ProbeMethod, ...args: unknown[]): Promise<Recorded<T>>;
}

const upstream = createTestHostFixture({
  productUrl: PRODUCT_URL,
  accounts: ['alice'],
  networks: [PASEO_ASSET_HUB, PASEO_BULLETIN],
});

export const test = base.extend<{ testHost: TestHost; probe: HostProbe }>({
  testHost: upstream.testHost,

  // The second parameter is Playwright's fixture `use` callback. It is named
  // `provide` here so eslint's react-hooks/rules-of-hooks does not mistake it
  // for React's `use()` — `npm run lint` in this package lints tests too.
  probe: async ({ testHost }, provide) => {
    const frame = async (): Promise<Frame> => {
      const page = testHost.page;
      for (let i = 0; i < 100; i++) {
        const f = page
          .frames()
          .find((x) => x !== page.mainFrame() && !x.isDetached() && x.url().startsWith(PRODUCT_URL));
        if (f) {
          await f.waitForFunction(() => (window as unknown as { __PROBE_READY__?: boolean }).__PROBE_READY__ === true, null, {
            timeout: 30_000,
          });
          return f;
        }
        await page.waitForTimeout(100);
      }
      throw new Error(`product iframe (${PRODUCT_URL}) never appeared; frames: ${page.frames().map((f) => f.url()).join(', ')}`);
    };

    const callOnce = async <T>(method: ProbeMethod, args: unknown[]): Promise<T> => {
      const f = await frame();
      return (await f.evaluate(
        async ([m, a]) => {
          const p = (window as unknown as { __PROBE__: Record<string, (...x: unknown[]) => unknown> }).__PROBE__;
          if (!p || typeof p[m as string] !== 'function') return { __probeError: `no probe method ${m}` };
          try {
            return await p[m as string](...(a as unknown[]));
          } catch (e) {
            return { __probeError: String(e) };
          }
        },
        [method, args] as [string, unknown[]],
      )) as T;
    };

    /**
     * Vite can reload the iframe mid-call when it discovers a new dependency,
     * which destroys the execution context. Retry once against the new frame
     * rather than failing the test on a dev-server artefact.
     */
    const call = async <T>(method: ProbeMethod, ...args: unknown[]): Promise<T> => {
      try {
        return await callOnce<T>(method, args);
      } catch (e) {
        if (!/Execution context was destroyed|frame was detached|Target closed/i.test(String(e))) throw e;
        await testHost.page.waitForTimeout(2000);
        return await callOnce<T>(method, args);
      }
    };

    await provide({
      frame,
      call,
      record: async <T>(method: ProbeMethod, ...args: unknown[]): Promise<Recorded<T>> => {
        await testHost.clearSigningLog();
        await testHost.clearPermissionLog();
        const result = await call<T>(method, ...args);
        return {
          result,
          signingLog: await testHost.getSigningLog(),
          permissionLog: await testHost.getPermissionLog(),
        };
      },
    });
  },
});

export { expect };
export type { TestHost };
