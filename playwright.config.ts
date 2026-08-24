import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against a running XBAM, not a mocked one.
 *
 * Default target is the Docker stack on :8080, which serves the built bundle
 * behind nginx exactly as a user would see it. Point XBAM_E2E_URL at :5173 to
 * run them against the dev server instead.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.XBAM_E2E_URL ?? 'http://localhost:8080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
