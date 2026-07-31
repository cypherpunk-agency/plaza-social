import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `vite preview` config for serving the REAL Plaza bundle to the simulated host.
 *
 * The harness has two products now:
 *
 *  - `tests/fixture-app/` on :5199 — the minimal probe, for asking the host protocol
 *    direct questions.
 *  - **Plaza itself** on :5200 — this file. `frontend/dist`, exactly the bytes that get
 *    published to Bulletin, embedded in the same test host container.
 *
 * Notes that are load-bearing:
 *
 *  - `X-Frame-Options: ALLOWALL` — `vite preview` sends no framing header at all, which is
 *    fine, but being explicit documents that the app is *meant* to be framed. Chrome only
 *    blocks on `DENY`/`SAMEORIGIN`, and the host page is a different origin (127.0.0.1:PORT
 *    vs localhost:5200).
 *  - No plugins. `vite preview` serves static files; pulling in `@vitejs/plugin-react` here
 *    would only slow startup.
 *  - `root` is the frontend package, so `build.outDir` resolves to `frontend/dist` — the
 *    directory `npm run build` writes. This config never builds; the webServer command does
 *    `vite build` with the app's own config first.
 */
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(here, '..'),
  base: './',
  build: { outDir: 'dist' },
  preview: {
    port: 5200,
    strictPort: true,
    // ⚠️ `host: true` (all interfaces), not the default. `vite preview` binds `localhost`,
    // which on Windows can resolve to `::1` only — so `http://127.0.0.1:5200` is NOT served
    // and the origin-variation arm of `12-product-account.spec.ts` fails with "iframe never
    // appeared", which reads like an app bug rather than a bind address.
    host: true,
    headers: { 'X-Frame-Options': 'ALLOWALL' },
  },
});
