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
    // Both read from the environment, because a second installation on one
    // machine is an ordinary thing to want and a hardcoded 8787 sends its
    // interface at whichever API happens to be on that port -- which, when the
    // other installation is the one running somebody's live agent, means
    // editing the wrong data while everything looks correct.
    port: Number(process.env.AI17Z_WEB_DEV_PORT ?? process.env.XBAM_WEB_DEV_PORT ?? 5173),
    // Same-origin /api in dev matches how the container serves it in production.
    proxy: {
      '/api': {
        target: `http://localhost:${Number(process.env.AI17Z_API_PORT ?? process.env.XBAM_API_PORT ?? 8787)}`,
        changeOrigin: true,
      },
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
