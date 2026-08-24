import type { Page } from '@playwright/test';

export const OWNER_EMAIL = process.env.XBAM_E2E_EMAIL ?? 'hamza@cloudtalha.com';
export const OWNER_PASSWORD = process.env.XBAM_E2E_PASSWORD ?? 'xbam-local-dev-2026';

/**
 * Signs in through the real form. The session token lands in localStorage, so
 * subsequent navigations in the same context stay authenticated.
 */
export async function signIn(page: Page): Promise<void> {
  // These run against a real stack, so the first request after an idle or
  // just-restarted API can be slow. One reload beats a flaky suite.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const emailField = page.locator('#email');
    if (await emailField.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await emailField.fill(OWNER_EMAIL);
      await page.locator('#password').fill(OWNER_PASSWORD);
      await page.getByRole('button', { name: /sign in|create account/i }).click();
    }
    const landed = await page
      .getByRole('heading', { name: 'Your agents' })
      .waitFor({ timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    if (landed) return;
  }
  throw new Error('Never reached the agents page after signing in.');
}

/** A name unique to this run, so repeated runs never collide. */
export function uniqueName(prefix: string): string {
  return `${prefix} ${Date.now().toString(36).slice(-5)}`;
}

export async function openAgent(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('heading', { name, exact: true }).first().click();
  await page.locator('#identity').waitFor({ timeout: 20_000 });
}
