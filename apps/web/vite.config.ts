import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const contracts = fileURLToPath(new URL('../../packages/shared/src/contracts/index.ts', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Only the isomorphic contracts are shared with the browser bundle.
      // Nothing under @xbam/shared that touches node built-ins is reachable here.
      '@xbam/shared/contracts': contracts,
      '@app': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Same-origin /api in dev matches how the container serves it in production.
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
    },
    fs: { allow: ['..', '../..'] },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          // Three.js is only needed by the portrait; keep it out of the entry chunk.
          three: ['three', '@react-three/fiber', '@react-three/drei'],
          motion: ['framer-motion'],
        },
      },
    },
  },
});
