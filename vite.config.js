import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// three's WebGPU/TSL entry points use top-level await, so we need an esnext
// target for both the dev optimizer and the production build.
export default defineConfig({
  // Fixed port so the URL never drifts (siblings grok/codex use 5173/5180).
  server: { host: true, port: 5174, strictPort: true },
  build: {
    target: 'esnext',
    // Two pages: the sim, and the destruction test rig at /test-destruction/.
    // Vite serves both in dev off the directory layout; the build has to be told.
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        testDestruction: resolve(import.meta.dirname, 'test-destruction/index.html'),
      },
    },
  },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
});
