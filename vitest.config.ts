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
    /**
     * One process, and the database is the reason.
     *
     * Integration tests create a database per test process and truncate between
     * cases, which needs an exclusive lock on every table at once -- anything
     * else running at the same moment either deadlocks or has rows pulled out
     * from under it, and the failure lands in whichever test happened to be
     * running. A shared test database made the suite fail in a different place
     * each time and look exactly like a concurrency bug in the code under test.
     *
     * This was `poolOptions.forks.singleFork: true` until Vitest 4 removed
     * `poolOptions` entirely.
     *
     * Vitest's own migration guide maps that setting to `maxWorkers: 1` **and**
     * `isolate: false`. Half of that is wrong here, and it fails loudly: with
     * isolation off, twenty-three tests break the moment more than one file
     * runs, because fifteen files mock `undici` at module scope and a shared
     * registry hands one file's mock to another file's request. Each of those
     * files passes alone, which is the signature of leakage rather than of an
     * API change.
     *
     * So only the half that matters is taken. `maxWorkers: 1` is what keeps the
     * database work to one process at a time; isolation stays at its default,
     * which is what `singleFork` actually gave us under Vitest 3.
     */
    maxWorkers: 1,
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
      '@xbam/upstream': r('./packages/upstream/src/index.ts'),
      '@xbam/runtime': r('./packages/runtime/src/index.ts'),
    },
  },
});
