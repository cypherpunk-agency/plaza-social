import { defineConfig } from 'vite';

/**
 * Build + serve config for the host-protocol probe app.
 *
 * The harness serves a **built** bundle (`vite build` then `vite preview`), not
 * the dev server. That is deliberate: vite's dep pre-bundling discovers
 * `polkadot-api` / `@parity/bulletin-sdk` lazily and triggers a full iframe
 * reload the first time a probe imports one, which destroys Playwright's
 * execution context mid-call and makes the suite flaky for reasons that have
 * nothing to do with the SDK.
 *
 * Use `npm run test:host:probe` for a hot-reloading dev server when editing the
 * probe itself.
 */
export default defineConfig({
  root: __dirname,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext',
    sourcemap: true,
  },
  server: {
    port: 5199,
    strictPort: true,
    headers: { 'X-Frame-Options': 'ALLOWALL' },
  },
  preview: {
    port: 5199,
    strictPort: true,
    headers: { 'X-Frame-Options': 'ALLOWALL' },
  },
  optimizeDeps: {
    include: [
      '@parity/product-sdk-host',
      '@parity/product-sdk-cloud-storage',
      '@parity/bulletin-sdk',
      'polkadot-api',
    ],
  },
});
