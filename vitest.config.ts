import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'tests/e2e/**'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
  resolve: {
    alias: {
      // Longest first: these are matched in order, so a bare '@xbam/shared'
      // above a subpath would swallow it.
      '@xbam/shared/contracts': r('./packages/shared/src/contracts/index.ts'),
      '@xbam/shared/util': r('./packages/shared/src/util.ts'),
      '@xbam/shared': r('./packages/shared/src/index.ts'),
      '@xbam/database': r('./packages/database/src/index.ts'),
      '@xbam/jobs': r('./packages/jobs/src/index.ts'),
      '@xbam/models': r('./packages/models/src/index.ts'),
      '@xbam/memory': r('./packages/memory/src/index.ts'),
      '@xbam/persona': r('./packages/persona/src/index.ts'),
      '@xbam/prompts': r('./packages/prompts/src/index.ts'),
      '@xbam/channels': r('./packages/channels/src/index.ts'),
      '@xbam/browser': r('./packages/browser/src/index.ts'),
      '@xbam/tools': r('./packages/tools/src/index.ts'),
      '@xbam/runtime': r('./packages/runtime/src/index.ts'),
    },
  },
});
