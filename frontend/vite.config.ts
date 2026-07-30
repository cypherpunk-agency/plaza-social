import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  /**
   * ⚠️ `'./'`, NOT `'/'`. A RELATIVE BASE IS REQUIRED BY THE HOST CONTAINER — architecture.md §1a,
   * verified: all four deployed Products bundles and `dotli-starter` set it. The app is served from a
   * Bulletin/IPFS CID path inside a sandboxed iframe, so every absolute `/assets/...` URL resolves
   * against the wrong origin and the bundle 404s with no console anyone can reach.
   *
   * The env override is kept only for the GitHub Pages build (`build:deploy`), which serves from a
   * subdirectory. Do not make an absolute path the default again.
   */
  base: process.env.VITE_BASE_PATH || './',
  server: {
    port: 5173,
    host: true,
    open: false,
    hmr: {
      overlay: true, // Show errors as overlay
    },
  },
})
