import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect } from '@playwright/test';
import type { Browser, Page, Route } from '@playwright/test';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import tailwindcss from 'tailwindcss';
import loadConfig from 'tailwindcss/loadConfig';
import type { DevUpdate, DevUpdateProject } from '../../apps/web/src/lib/devUpdates';

const project: DevUpdateProject = {
  id: 'project', projectKey: 'demo', displayName: 'Demo', agentId: 'agent', accountId: 'account',
  mode: 'DRAFT', enabled: true, rehearse: false, dailyCap: 2, minSpacingMinutes: 60,
  senderToken: { active: false, hint: null, issuedAt: null }, lastDispatchReason: null, createdAt: '', updatedAt: '',
};
const draft: DevUpdate = {
  id: 'draft', kind: 'FEATURE', title: 'Draft to review', summary: 'Finished a useful feature.', why: 'It saves time.',
  evidence: [], post: 'A useful feature is ready.', proposedPost: '', edited: false, status: 'PENDING_REVIEW',
  reason: null, url: null, jobId: null, history: [], decidedAt: null, dispatchedAt: null, finishedAt: null,
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
};
const token = `ai17z_dus_${'a'.repeat(24)}`;
const success = (route: Route, data: unknown) => route.fulfill({ json: { ok: true, data } });

describe('development updates browser regressions', () => {
  let server: ViteDevServer;
  let browser: Browser;
  let page: Page;
  let origin: string;
  let paused = false;
  let automationMode = 'AUTONOMOUS';
  let dryRun = false;
  let failPoll = false;
  let projects = [project];

  beforeAll(async () => {
    server = await createServer({
      configFile: resolve('apps/web/vite.config.ts'), root: resolve('apps/web'),
      css: { postcss: { plugins: [tailwindcss({ ...loadConfig(resolve('apps/web/tailwind.config.js')), content: [resolve('apps/web/src/**/*.{ts,tsx}').replaceAll('\\', '/')] })] } },
      server: { port: 0, host: '127.0.0.1' },
      plugins: [{ name: 'dev-updates-test-page', configureServer(vite) {
        vite.middlewares.use('/__test', async (_request, response) => {
          const fixture = resolve('tests/web/fixtures/devUpdates.tsx').replaceAll('\\', '/');
          const html = await vite.transformIndexHtml('/__test', `<html><body><div id="root"></div><script type="module" src="/@fs/${fixture}"></script></body></html>`);
          response.setHeader('Content-Type', 'text/html');
          response.end(html);
        });
      } }],
    });
    await server.listen();
    origin = server.resolvedUrls!.local[0]!;
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => { await browser?.close(); await server?.close(); });
  beforeEach(async () => {
    paused = false; automationMode = 'AUTONOMOUS'; dryRun = false; failPoll = false; projects = [project];
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(5_000);
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      if (failPoll) return route.fulfill({ status: 503, json: { ok: false, error: { code: 'UNAVAILABLE', message: 'The API is temporarily unavailable.' } } });
      if (url.pathname === '/api/dev-updates/projects') return success(route, { items: projects.map((p) => ({ ...p, enabled: !paused })) });
      if (url.pathname === '/api/agents') return success(route, { items: [{ id: 'agent', name: 'Builder', accounts: [
        { accountId: 'account', handle: 'demo', channel: 'mock', enabled: true, accountEnabled: true },
      ] }] });
      if (url.pathname.endsWith('/capabilities')) return success(route, { grants: { account: ['POST'] } });
      if (url.pathname === '/api/agents/agent') return success(route, { agent: { id: 'agent' }, policy: { config: { automation: { mode: automationMode, dryRunDefault: dryRun } } } });
      if (url.pathname === '/api/dev-updates/connection') return success(route, { serverName: 'ai17z-dev-updates', mcpServerPath: '/opt/ai17z/tools/dev-updates-mcp.mjs', reason: null });
      if (url.pathname === '/api/dev-updates/updates') return success(route, { items: [draft] });
      return success(route, { items: [] });
    });
  });
  afterEach(async () => { await page.close(); });

  for (const decision of ['approve', 'reject'] as const) {
    it(`sends ${decision} once while pending and after success until refresh`, async () => {
      let requests = 0;
      let finish: (() => void) | undefined;
      const pending = new Promise<void>((resolvePending) => { finish = resolvePending; });
      await page.route(`**/updates/draft/${decision}`, async (route) => {
        requests += 1;
        await pending;
        await success(route, {});
      });
      // Vite compiles the fixture on first navigation, which can exceed five seconds.
      await page.goto(`${origin}__test`, { timeout: 30_000 });
      if (decision === 'reject') {
        await page.getByRole('button', { name: 'Reject', exact: true }).click();
        await page.getByRole('textbox', { name: 'Why not' }).fill('Not announced yet.');
      }
      const button = page.getByRole('button', { name: decision === 'approve' ? 'Approve' : 'Reject it', exact: true });
      // Both events run before React commits a disabled button.
      await button.evaluate((element) => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await browserExpect(page.getByRole('button', { name: decision === 'approve' ? 'Approving…' : 'Rejecting…' })).toBeDisabled();
      expect(requests).toBe(1);
      finish!();
      await browserExpect(page.getByRole('button', { name: decision === 'approve' ? 'Approving…' : 'Rejecting…' })).toHaveCount(0);
      await browserExpect(page.getByRole('article').getByRole('button').first()).toBeDisabled();
      expect(requests).toBe(1);
    });
  }

  it('allows retrying a decision when its request fails', async () => {
    let requests = 0;
    await page.route('**/updates/draft/approve', async (route) => {
      requests += 1;
      if (requests === 1) return route.fulfill({ status: 503, json: { ok: false, error: { code: 'UNAVAILABLE', message: 'Approval is temporarily unavailable.' } } });
      return success(route, {});
    });
    await page.goto(`${origin}__test`);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await browserExpect(page.getByRole('article')).toContainText('Approval is temporarily unavailable.');
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await browserExpect(page.getByRole('button', { name: 'Approved', exact: true })).toBeDisabled();
    expect(requests).toBe(2);
  });

  for (const hold of ['paused', 'automation', 'dry run', 'unknown'] as const) {
    it(`explains the ${hold} hold beside the approval action`, async () => {
      paused = hold === 'paused'; automationMode = hold === 'automation' ? 'OFF' : 'AUTONOMOUS'; dryRun = hold === 'dry run';
      if (hold === 'unknown') await page.route('**/api/agents/agent', (route) => route.abort());
      await page.goto(`${origin}__test`);
      const article = page.getByRole('article');
      await browserExpect(article).toBeVisible();
      await browserExpect(page.getByText('Reading the agent', { exact: false })).toHaveCount(0);
      await browserExpect(article).not.toContainText('Approving queues it for');
      await browserExpect(article).toContainText(hold === 'paused' ? 'paused' : hold === 'automation' ? 'automation is off' : hold === 'dry run' ? 'dry run' : 'not known');
    });
  }

  it('keeps loaded projects and drafts visible after a failed poll and retries', async () => {
    await page.clock.install();
    await page.goto(`${origin}__test`);
    await browserExpect(page.getByRole('article')).toContainText(draft.title);
    failPoll = true;
    await page.clock.fastForward(20_001);
    await browserExpect(page.getByText('The API is temporarily unavailable.').first()).toBeVisible();
    await browserExpect(page.getByRole('article')).toContainText(draft.title);
    await browserExpect(page.getByText(/Showing the last/).first()).toBeVisible();
    failPoll = false;
    await page.getByRole('button', { name: 'Try again' }).first().click();
    await page.getByRole('button', { name: 'Try again' }).first().click();
    await browserExpect(page.getByText(/Showing the last/)).toHaveCount(0);
    await browserExpect(page.getByRole('article')).toContainText(draft.title);
    await page.clock.fastForward(20_001);
    await browserExpect(page.getByText('The API is temporarily unavailable.')).toHaveCount(0);
  });

  async function createProject() {
    await page.goto(`${origin}__test`);
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('New demo');
    await browserExpect(page.getByRole('button', { name: 'Create project', exact: true })).toBeEnabled();
  }

  it('confirms Escape and the close button before discarding a revealed token', async () => {
    await page.route('**/api/dev-updates/projects', (route) => route.request().method() === 'POST'
      ? success(route, { project, senderToken: token }) : success(route, { items: [project] }));
    await createProject();
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await browserExpect(page.getByText(token, { exact: true })).toBeVisible();
    let confirmations = 0;
    page.on('dialog', async (dialog) => { confirmations += 1; await dialog.dismiss(); });
    await page.keyboard.press('Escape');
    await browserExpect(page.getByRole('dialog')).toBeVisible();
    expect(confirmations).toBe(1);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    expect(confirmations).toBe(2);
    await page.getByRole('button', { name: 'I have copied it, close' }).click();
    await browserExpect(page.getByRole('dialog')).toHaveCount(0);
  });

  it('selects a newly created project using the current search parameters', async () => {
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolvePending) => { finish = resolvePending; });
    await page.route('**/api/dev-updates/projects', async (route) => {
      if (route.request().method() !== 'POST') return success(route, { items: projects });
      await pending;
      projects = [project, { ...project, id: 'new' }];
      return success(route, { project: projects[1], senderToken: token });
    });
    await createProject();
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await page.getByRole('button', { name: 'Change search' }).evaluate((button) => (button as HTMLButtonElement).click());
    await browserExpect(page.getByTestId('search')).toContainText('marker=current');
    finish!();
    await browserExpect(page.getByTestId('search')).toContainText('project=new');
    await browserExpect(page.getByTestId('search')).toContainText('marker=current');
  });

  it('explains that a hosted connection cannot prepare a sender command', async () => {
    await page.goto(`${origin}__test?hosted`);
    await browserExpect(page.getByText('Sender commands are not available through this hosted connection')).toBeVisible();
    await browserExpect(page.locator('pre')).toHaveCount(0);
  });

  it('renders the held review at desktop and mobile sizes', async () => {
    paused = true;
    await page.goto(`${origin}__test`);
    await browserExpect(page.getByRole('article')).toBeVisible();
    await browserExpect(page.getByRole('heading', { name: 'Post what you ship' })).toBeVisible();
    expect(await page.locator('article > div').evaluate((element) => getComputedStyle(element).display)).toBe('grid');
    await mkdir('.screenshots', { recursive: true });
    for (const [name, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await page.screenshot({ path: `.screenshots/dev-updates-${name}.png`, fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  });
});
