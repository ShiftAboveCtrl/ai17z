import type { Page } from '@playwright/test';

// A local development identity, not anybody's real address. The suite creates
// this owner on a fresh database and signs in as it; point the environment
// variables at something else to run against an existing installation.
export const OWNER_EMAIL = process.env.AI17Z_E2E_EMAIL ?? process.env.XBAM_E2E_EMAIL ?? 'owner@ai17z.local';
export const OWNER_PASSWORD =
  process.env.AI17Z_E2E_PASSWORD ?? process.env.XBAM_E2E_PASSWORD ?? 'ai17z-local-dev-2026';

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
 * A session this process was handed rather than one it signed in for.
 *
 * `npm run session:e2e` mints one against the local database and prints it.
 * That exists so these specs can run against an installation somebody is
 * already using -- a real one has a real owner with a real password, and the
 * alternative is putting that password in an environment variable so a test
 * runner can type it into a form.
 *
 * Unset in the ordinary case, where the suite runs on a fresh database and
 * creates the owner it signs in as.
 */
const OWNER_TOKEN = process.env.AI17Z_E2E_TOKEN ?? '';

/**
 * Signs in through the real form. The session token lands in localStorage, so
 * subsequent navigations in the same context stay authenticated.
 */
export async function signIn(page: Page): Promise<void> {
  if (OWNER_TOKEN) {
    // Before the app's own scripts, on every navigation: the first render reads
    // this, so a later write would paint the sign-in screen and then replace it.
    await page.addInitScript((token) => {
      try {
        window.localStorage.setItem('ai17z.session', token as string);
      } catch {
        // Storage blocked; the spec fails on its own assertion, not here.
      }
    }, OWNER_TOKEN);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Your agents' }).waitFor({ timeout: 20_000 });
    return;
  }

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
  throw new Error(await whySignInFailed(page));
}

/**
 * Says why sign-in failed, rather than that it did.
 *
 * There is exactly one owner: `POST /api/bootstrap/owner` refuses once a user
 * exists, and login answers "incorrect email or password" without saying which,
 * because telling an attacker that an address exists is worse than being vague
 * at a person. Both are right, and together they turn the common contributor
 * mistake -- running this suite against an installation that already has an
 * owner -- into a timeout with no explanation. Sixty seconds later you have
 * nine failures and a screenshot of a login form.
 *
 * So the reason is worked out here, where the answer is cheap and harms nobody:
 * an unauthenticated status endpoint already says whether an owner exists, and
 * this is a test helper on the same machine as the database.
 */
async function whySignInFailed(page: Page): Promise<string> {
  const needsOwner = await page
    .evaluate(async () => {
      const res = await fetch('/api/bootstrap/status');
      const body = await res.json();
      return Boolean(body?.data?.needsOwner ?? body?.needsOwner);
    })
    .catch(() => null);

  if (needsOwner === null) {
    return (
      `Could not reach the API behind ${page.url()}. ` +
      'Start the stack (npm run dev, or docker compose up) and check XBAM_E2E_URL.'
    );
  }
  if (needsOwner) {
    return (
      'The database has no owner and creating one did not work. ' +
      'This is a real failure in the bootstrap screen, not a configuration problem.'
    );
  }
  return (
    `This installation already has an owner, and ${OWNER_EMAIL} is not it. ` +
    'These specs sign in as the owner, so run them against a fresh database, or set ' +
    'AI17Z_E2E_EMAIL and AI17Z_E2E_PASSWORD to an owner that exists.'
  );
}

/** A name unique to this run, so repeated runs never collide. */
export function uniqueName(prefix: string): string {
  return `${prefix} ${Date.now().toString(36).slice(-5)}`;
}

/**
 * Which of the agent page's five areas holds a section.
 *
 * The page used to be fifteen sections on one scroll, so every spec found what
 * it wanted with `#identity` and no navigation. It is five areas now and only
 * the selected one is rendered, which turned most of this suite into a
 * twenty-second wait for an element that was never going to exist. Kept here
 * rather than imported from the app: a test that reads the map it is checking
 * asserts nothing, and the point is that a section somebody moved has to be
 * moved here too.
 */
const AREA_OF_SECTION: Record<string, string> = {
  activity: 'Overview',
  identity: 'Character',
  voice: 'Character',
  beliefs: 'Character',
  accounts: 'Reach',
  intelligence: 'Reach',
  tools: 'Reach',
  memory: 'Memory',
  knowledge: 'Memory',
  relationships: 'Memory',
  learned: 'Memory',
  content: 'Behaviour',
  behaviour: 'Behaviour',
  policies: 'Behaviour',
  pipeline: 'Behaviour',
};

/**
 * Selects the area holding a section and waits for it, the way a person would.
 *
 * Clicking the area tab rather than setting a hash on purpose: the tab is what
 * somebody uses, and an anchor is a separate contract with its own test.
 */
export async function goToSection(page: Page, section: string): Promise<void> {
  const area = AREA_OF_SECTION[section];
  if (!area) throw new Error(`No area holds #${section}. Add it to AREA_OF_SECTION in helpers.ts.`);
  // `.first()` because the page renders its navigation twice, once for a phone
  // and once for a desktop, and only one is visible at a time. A bare locator
  // matches both and throws on strict mode, which used to be swallowed and
  // reappear twenty seconds later as "#identity never became visible".
  const tab = page.getByRole('button', { name: area, exact: true }).first();
  await tab.click({ timeout: 20_000 });
  await page.locator(`#${section}`).waitFor({ timeout: 20_000 });
}

/** Opens an agent from the list and lands on the area holding `section`. */
export async function openAgent(page: Page, name: string, section = 'identity'): Promise<void> {
  await page.goto('/');
  await page.getByRole('heading', { name, exact: true }).first().click();
  await goToSection(page, section);
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

/**
 * Removes providers a test created.
 *
 * Without this, every run leaves one behind and they accumulate on the health
 * page, which lists each provider by label. Twenty-four "E2E Mock" rows sitting
 * above the real ones is not a broken feature, but a health page nobody can
 * read is a health page nobody reads.
 */
export async function deleteProvidersLabelled(page: Page, prefix: string): Promise<number> {
  return page.evaluate(async (labelPrefix) => {
    const token = localStorage.getItem('ai17z.session') ?? localStorage.getItem('xbam.session');
    if (!token) return 0;
    const headers = { Authorization: `Bearer ${token}` };

    const listed = await fetch('/api/providers', { headers }).then((r) => r.json());
    const items: { id: string; label: string }[] = listed?.data?.items ?? [];
    let removed = 0;
    for (const provider of items) {
      if (!provider.label.startsWith(labelPrefix)) continue;
      const res = await fetch(`/api/providers/${provider.id}`, { method: 'DELETE', headers });
      if (res.ok) removed += 1;
    }
    return removed;
  }, prefix);
}
