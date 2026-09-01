import type { Page } from '@playwright/test';

export const OWNER_EMAIL = process.env.XBAM_E2E_EMAIL ?? 'hamza@cloudtalha.com';
export const OWNER_PASSWORD = process.env.XBAM_E2E_PASSWORD ?? 'xbam-local-dev-2026';

/**
 * Picks Easy or Advanced before the app boots.
 *
 * The switch is one setting for the whole application, kept in localStorage and
 * defaulting to Easy. Every test that asserts on an Advanced surface has to say
 * so: the agent page renders a completely different view in Easy, and a test
 * that does not choose is really asserting "whatever the default happens to be
 * today". These tests were written before the switch existed and were doing
 * exactly that.
 *
 * `addInitScript` runs before the page's own scripts on every navigation, which
 * is the only point early enough for the first render to see it.
 */
export async function useInterface(page: Page, mode: 'easy' | 'advanced'): Promise<void> {
  await page.addInitScript((chosen) => {
    try {
      window.localStorage.setItem('ai17z.viewMode', chosen as string);
    } catch {
      // Storage blocked; the test will fail on its own assertion, not here.
    }
  }, mode);
}

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

/**
 * Removes an agent this run created, through the API the UI uses.
 *
 * These specs run against the real stack signed in as the real owner, so
 * anything they leave behind is left in somebody's actual list of agents. That
 * is how thirty-seven "E2E Agent" rows accumulated. Deleting an agent cascades
 * to its personas, policies, jobs, traces, and memories.
 *
 * Best-effort: a cleanup failure must not fail a passing test, but it is
 * reported so a leak does not go unnoticed.
 */
export async function deleteAgentsNamed(page: Page, prefix: string): Promise<number> {
  return page.evaluate(async (namePrefix) => {
    const token = localStorage.getItem('ai17z.session') ?? localStorage.getItem('xbam.session');
    if (!token) return 0;
    const headers = { Authorization: `Bearer ${token}` };

    const listed = await fetch('/api/agents', { headers }).then((r) => r.json());
    const items: { id: string; name: string }[] = listed?.data?.items ?? [];
    let removed = 0;
    for (const agent of items) {
      if (!agent.name.startsWith(namePrefix)) continue;
      const res = await fetch(`/api/agents/${agent.id}`, { method: 'DELETE', headers });
      if (res.ok) removed += 1;
    }
    return removed;
  }, prefix);
}

/**
 * Mock accounts a run created. Named after the agent, so the same prefix finds
 * them, and only ever mock: nothing here can touch a real X account.
 */
export async function deleteMockAccountsNamed(page: Page, handlePrefix: string): Promise<number> {
  return page.evaluate(async (prefix) => {
    const token = localStorage.getItem('ai17z.session') ?? localStorage.getItem('xbam.session');
    if (!token) return 0;
    const headers = { Authorization: `Bearer ${token}` };

    const listed = await fetch('/api/accounts', { headers }).then((r) => r.json());
    const items: { id: string; channel: string; handle: string }[] = listed?.data?.items ?? [];
    let removed = 0;
    for (const account of items) {
      if (account.channel !== 'mock' || !account.handle.startsWith(prefix)) continue;
      const res = await fetch(`/api/accounts/${account.id}`, { method: 'DELETE', headers });
      if (res.ok) removed += 1;
    }
    return removed;
  }, handlePrefix);
}
