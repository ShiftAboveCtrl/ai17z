import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5178', headless: true },
  webServer: { command: 'node tests/browser/server.mjs', cwd: fileURLToPath(new URL('../..', import.meta.url)), url: 'http://127.0.0.1:5178', reuseExistingServer: true },
});
