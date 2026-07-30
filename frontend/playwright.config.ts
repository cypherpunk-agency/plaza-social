import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the host-protocol integration harness.
 *
 * `npm run test:host` starts the probe app (tests/fixture-app) on :5199 and runs
 * the specs in tests/. The Polkadot Products *host* is provided in-process by
 * `@parity/host-api-test-sdk` via the fixture in tests/host-fixture.ts — there
 * is no second server to start for it.
 */
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  // Keep every artefact inside tests/.artifacts so the harness owns one
  // directory instead of scattering playwright-report/ and test-results/ at the
  // frontend root.
  outputDir: './tests/.artifacts/results',
  reporter: process.env.CI
    ? [['list']]
    : [['list'], ['html', { open: 'never', outputFolder: './tests/.artifacts/report' }]],
  use: {
    trace: 'retain-on-failure',
    video: 'off',
  },
  webServer: {
    command:
      'npx vite build --config tests/fixture-app/vite.config.ts && npx vite preview --config tests/fixture-app/vite.config.ts',
    url: 'http://localhost:5199',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
