/**
 * ⭐ The fixture that runs **PLAZA ITSELF** inside the simulated Polkadot Products host.
 *
 * `host-fixture.ts` drives `tests/fixture-app`, a minimal probe whose job is to ask the host
 * protocol direct questions. This file points the *same* upstream test host at
 * `frontend/dist` — the real bundle, the one `pad` publishes — so the app's own code paths
 * execute: `openBackend` → `openHostSession` → permissions → account → chain client →
 * `PostRegistry.getHeadsPaged` → `walkChain`.
 *
 * ⛔ THIS IS A TEST SEAM, NOT A SECOND WAY INTO THE PLATFORM. Nothing here is imported by
 * `src/`. Plaza does not know it is being tested; there is no test-only branch in production
 * code and none may be added. See gotchas.md § THE SDK PATH IS THE ONLY PATH.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THE SIMULATED HOST REALLY DOES, because it changes how you read a green test:
 *
 *  - **Chain traffic is REAL.** `handleChainConnection` opens a websocket to whatever RPC the
 *    network entry names and proxies the new JSON-RPC family to it. Declare the devnet Asset
 *    Hub below and Plaza reads OUR DEPLOYED CONTRACTS on the live chain.
 *  - **Bulletin content is NOT.** `handlePreimageLookupSubscribe` answers from an in-memory
 *    `Map` seeded only by `seedPreimage()` and by the product's own `preimageSubmit`. It never
 *    reaches the Bulletin chain. So chain heads resolve and **post bodies do not** — the app
 *    correctly renders holes. That is the simulator's limit, not a Plaza bug.
 *  - **Signing is real sr25519 over a DEV key** (`//Alice//plaza.dot/0`), and the account is
 *    unfunded on devnet. A contract write encodes and signs; it cannot land.
 *  - **`requestResourceAllocation` returns `Allocated` for everything, unconditionally.** It
 *    models none of the personhood-gated statement-store slot behaviour that broke the browser
 *    host on 2026-07-31.
 *
 * Verified against `@parity/host-api-test-sdk@0.11.0` (`dist/host-bundle.js`, read verbatim).
 */
import { test as base, expect, type Frame, type Page } from '@playwright/test';
import { createTestHostFixture, type TestHost } from '@parity/host-api-test-sdk/playwright';
import type { NetworkConfig } from '@parity/host-api-test-sdk';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Where `tests/plaza-app.vite.config.ts` serves `frontend/dist`. */
export const PLAZA_URL = process.env.PLAZA_URL ?? 'http://localhost:5200';

/** Screenshots land here. Gitignored with the rest of `tests/.artifacts`. */
export const SCREENSHOT_DIR = resolve(here, '.artifacts', 'screens');

/**
 * ⭐ The chain Plaza's four contracts are actually deployed on.
 *
 * Genesis and endpoint verified live 2026-07-31 by `chain_getBlockHash(0)`:
 * `wss://asset-hub-paseo-rpc.n.dwellir.com` answers `0xd6eec261…`, which is exactly
 * `@parity/product-sdk-descriptors/devnet-asset-hub`'s `.genesis`. The test SDK's built-in
 * `PASEO_ASSET_HUB` is a DIFFERENT chain (`0xbf0488db…`, `paseo-asset-hub-next-rpc`) and our
 * contracts are not on it — declaring only that one makes every read return empty and looks
 * exactly like a broken deployment.
 */
export const DEVNET_ASSET_HUB: NetworkConfig = {
  id: 'devnet-asset-hub',
  name: 'Products Devnet Asset Hub',
  genesisHash: '0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2',
  rpcUrl: 'wss://asset-hub-paseo-rpc.n.dwellir.com',
  tokenSymbol: 'PAS',
  tokenDecimals: 10,
};

/** `CloudStorageNetworks.devnet` — "Bulletin Paseo". Genesis from `devnet-bulletin` descriptor. */
export const DEVNET_BULLETIN: NetworkConfig = {
  id: 'devnet-bulletin',
  name: 'Bulletin Paseo',
  genesisHash: '0xe101f0fa4627d29a257645e02be86d80378fea1a2bf8fa6a918d150ebc760a59',
  rpcUrl: 'wss://bulletin-paseo.tservices.es:8443',
  tokenSymbol: 'PGAS',
  tokenDecimals: 10,
};

/** `CloudStorageNetworks.paseo` — "Paseo Bulletin Next". */
export const PASEO_BULLETIN: NetworkConfig = {
  id: 'paseo-bulletin',
  name: 'Paseo Bulletin Next',
  genesisHash: '0x8cfe6717dc4becfda2e13c488a1e2061ff2dfee96e7d031157f72d36716c0a22',
  rpcUrl: 'wss://paseo-bulletin-next-rpc.polkadot.io',
  tokenSymbol: 'PAS',
  tokenDecimals: 10,
};

/** The Individuality / People chain — where `PeopleLite.LitePeople` lives. */
export const DEVNET_INDIVIDUALITY: NetworkConfig = {
  id: 'devnet-individuality',
  name: 'Products Devnet Individuality',
  genesisHash: '0xe6c30d6e148f250b887105237bcaa5cb9f16dd203bf7b5b9d4f1da7387cb86ec',
  rpcUrl: 'wss://people-paseo.rotko.net',
  tokenSymbol: 'PAS',
  tokenDecimals: 10,
};

/**
 * ⚠️ `DEVNET_BULLETIN` IS DELIBERATELY NOT IN THIS LIST.
 *
 * `bulletin-paseo.tservices.es:8443` answers the harness with **HTTP 429** on the websocket
 * handshake and PAPI retries it in a tight loop — measured 2026-07-31, 17 failed handshakes in
 * 15 seconds, filling the console and starving the run. Leaving it undeclared makes
 * `featureSupported({Chain: 0xe101f0fa…})` answer `false`, which is a state `session.ts`
 * already handles: it falls back to the paseo Bulletin exactly as it does on a real
 * `rpc-gateway` host. So the omission exercises the fallback rather than hiding it.
 *
 * It changes nothing about content reads either way — those go through the host preimage
 * channel, which in this simulator is an in-memory map and touches no Bulletin chain at all.
 */
export const PLAZA_NETWORKS: NetworkConfig[] = [
  DEVNET_ASSET_HUB,
  PASEO_BULLETIN,
  DEVNET_INDIVIDUALITY,
];

/** Phone-first, then the width at which the forum's `xl` split appears. */
export const VIEWPORTS = {
  phone: { width: 375, height: 812 },
  desktop: { width: 1280, height: 900 },
} as const;

export interface PlazaHarness {
  /** URL of the in-process host page (the thing that owns the iframe). */
  hostUrl: string;
  /**
   * Load Plaza with a query string. The host page forwards its own
   * `location.search` into the iframe src — the same thing the real dot.li shell does — so
   * `?backend=fake&caps=live` or `?cid=…` reaches the app exactly as it would in production.
   */
  open(query?: string, viewport?: { width: number; height: number }): Promise<Frame>;
  /** The Plaza iframe as an evaluate-capable `Frame`. */
  frame(): Promise<Frame>;
  /** Screenshot the whole host page (i.e. the container with Plaza in it). Returns the path. */
  shot(name: string): Promise<string>;
  /** Console lines the app emitted, newest last. Cleared on every `open()`. */
  logs(): string[];
}

const upstream = createTestHostFixture({
  productUrl: PLAZA_URL,
  accounts: ['alice'],
  networks: PLAZA_NETWORKS,
});

async function plazaFrame(page: Page): Promise<Frame> {
  for (let i = 0; i < 150; i++) {
    const f = page
      .frames()
      .find((x) => x !== page.mainFrame() && !x.isDetached() && x.url().startsWith(PLAZA_URL));
    if (f) return f;
    await page.waitForTimeout(100);
  }
  throw new Error(
    `Plaza iframe (${PLAZA_URL}) never appeared; frames: ${page.frames().map((f) => f.url()).join(', ')}`,
  );
}

export const test = base.extend<{ testHost: TestHost; plaza: PlazaHarness }>({
  testHost: upstream.testHost,

  // Named `provide` rather than `use` so eslint's react-hooks rule does not read it as React's
  // `use()` — `npm run lint` covers this directory.
  plaza: async ({ testHost }, provide) => {
    const page = testHost.page;
    const hostUrl = new URL(page.url()).origin;
    const captured: string[] = [];

    page.on('console', (msg) => {
      captured.push(`[${msg.type()}] ${msg.text()}`);
    });
    page.on('pageerror', (err) => captured.push(`[pageerror] ${String(err)}`));

    const harness: PlazaHarness = {
      hostUrl,
      logs: () => [...captured],

      async open(query = '', viewport) {
        if (viewport) await page.setViewportSize(viewport);
        captured.length = 0;
        const target = query ? `${hostUrl}/${query.startsWith('?') ? query : `?${query}`}` : hostUrl;
        await page.goto(target);
        await page.waitForFunction(() => !!window.__TEST_HOST__, { timeout: 30_000 });
        const frame = await plazaFrame(page);
        // React has mounted when the wordmark is there. `#root` alone is in index.html and so
        // is present before a single component renders — waiting on it proves nothing.
        await frame.waitForSelector('h1', { timeout: 30_000 });
        return frame;
      },

      frame: () => plazaFrame(page),

      async shot(name) {
        await mkdir(SCREENSHOT_DIR, { recursive: true });
        const path = join(SCREENSHOT_DIR, `${name}.png`);
        await page.screenshot({ path, fullPage: false });
        return path;
      },
    };

    await provide(harness);
  },
});

export { expect };
export type { TestHost };
