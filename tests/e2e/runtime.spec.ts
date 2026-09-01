import { expect, test, type Page } from '@playwright/test';
import { deleteAgentsNamed, deleteMockAccountsNamed, signIn, uniqueName, useInterface } from './helpers';

test.describe.configure({ mode: 'serial' });

const AGENT_NAME = uniqueName('E2E Runtime');
const PROVIDER_LABEL = uniqueName('E2E Mock');

// Serial mode, one worker: later tests act on the agent the earlier one made.
let agentId = '';

async function token(page: Page): Promise<string> {
  const value = await page.evaluate(() => window.localStorage.getItem('ai17z.session'));
  if (!value) throw new Error('No session token in localStorage after signing in.');
  return value;
}

/** Waits for a job on this agent to reach one of the given statuses. */
async function waitForStatus(page: Page, agentId: string, statuses: string[], timeoutMs = 45_000): Promise<string> {
  const auth = await token(page);
  const deadline = Date.now() + timeoutMs;
  let last = 'none';
  while (Date.now() < deadline) {
    const response = await page.request.get(`/api/jobs?agentId=${agentId}&limit=1`, {
      headers: { authorization: `Bearer ${auth}` },
    });
    const body = await response.json();
    last = body.data?.items?.[0]?.status ?? 'none';
    if (statuses.includes(last)) return last;
    await page.waitForTimeout(1000);
  }
  throw new Error(`Job never reached ${statuses.join('/')}; last status was ${last}.`);
}

test('adds a model provider from settings', async ({ page }) => {
  await useInterface(page, 'advanced');
  await signIn(page);
  await page.goto('/settings');
  await page.getByRole('button', { name: /add provider/i }).click();

  await page.locator('#pkind').selectOption('mock');
  await page.locator('#plabel').fill(PROVIDER_LABEL);
  await page.getByRole('button', { name: /^add provider$/i }).last().click();

  // The label also appears in the system health list, so scope to the section.
  const providers = page.locator('#providers');
  await expect(providers.getByText(PROVIDER_LABEL, { exact: true })).toBeVisible({ timeout: 20_000 });

  // Test Connection is a real call, and the stored status updates.
  const row = providers.locator('li').filter({ hasText: PROVIDER_LABEL });
  await row.getByRole('button', { name: /test/i }).click();
  await expect(row).toContainText(/healthy/i, { timeout: 20_000 });
});

test('runs a dry run end to end and shows the trace', async ({ page }) => {
  await useInterface(page, 'advanced');
  await signIn(page);
  const auth = await token(page);

  // The agent itself is created through the API; the wizard is covered elsewhere.
  const created = await page.request.post('/api/agents', {
    headers: { authorization: `Bearer ${auth}` },
    data: {
      name: AGENT_NAME,
      description: 'Runtime flow coverage.',
      persona: { displayName: AGENT_NAME, identityKind: 'DISCLOSED_AI' },
      policy: { automation: { mode: 'AUTONOMOUS', dryRunDefault: true } },
    },
  });
  agentId = (await created.json()).data.id as string;

  const providers = await page.request.get('/api/providers', { headers: { authorization: `Bearer ${auth}` } });
  const provider = (await providers.json()).data.items.find(
    (p: { label: string }) => p.label === PROVIDER_LABEL,
  );
  expect(provider).toBeTruthy();

  await page.goto(`/agents/${agentId}`);
  await page.locator('#intelligence').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: /primary model/i }).click();
  await page.locator('#mprovider').selectOption(provider.id);
  await page.locator('#mmodel').fill('mock-echo');
  await page.getByRole('button', { name: /^save$/i }).click();
  await expect(page.locator('#intelligence')).toContainText('mock-echo', { timeout: 20_000 });

  // Inject a real event through the UI and let the worker process it.
  await page.locator('#activity').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: /inject a test event/i }).first().click();
  await page.locator('#ihandle').fill('e2e_user');
  await page.locator('#itext').fill('Remember that my favourite colour is teal.');
  await page.locator('#ithread').fill('e2e-thread-1');
  await page.getByRole('button', { name: /^inject$/i }).click();

  const status = await waitForStatus(page, agentId, ['DRY_RUN_COMPLETED']);
  expect(status).toBe('DRY_RUN_COMPLETED');

  // The trace is the point: open it and check it answers what happened.
  await page.goto(`/activity?agentId=${agentId}`);
  await page.getByText('Remember that my favourite colour is teal.').first().click();

  await expect(page.getByText('Lifecycle')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/target verified/i).first()).toBeVisible();
  await expect(page.getByText(/dry run stopped/i).first()).toBeVisible();
  await expect(page.getByText(/prompt layers/i)).toBeVisible();

  // Prompt layers expand to show exactly what the model was told.
  await page.getByRole('button', { name: /immediate context/i }).click();
  await expect(page.getByText(/INCOMING MESSAGE/)).toBeVisible();
});

test('holds a job for approval, then executes the edited text', async ({ page }) => {
  await useInterface(page, 'advanced');
  await signIn(page);
  await page.goto(`/agents/${agentId}`);

  // Switch to review mode and turn dry run off, through the policy UI.
  const policies = page.locator('#policies');
  await policies.scrollIntoViewIfNeeded();
  await policies.getByRole('button', { name: /review before action/i }).click();
  const dryRun = policies.getByRole('switch', { name: /dry run by default/i });
  if ((await dryRun.getAttribute('aria-checked')) === 'true') await dryRun.click();
  await policies.getByRole('button', { name: /save as version/i }).click();
  await expect(policies.getByText('saved')).toBeVisible({ timeout: 20_000 });

  await page.locator('#activity').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: /inject a test event/i }).first().click();
  await page.locator('#ihandle').fill('e2e_user');
  await page.locator('#itext').fill('Does the approval gate hold this?');
  await page.locator('#ithread').fill('e2e-thread-approval');
  const dialogDryRun = page.getByRole('dialog').getByRole('switch', { name: /dry run/i });
  if ((await dialogDryRun.getAttribute('aria-checked')) === 'true') await dialogDryRun.click();
  await page.getByRole('button', { name: /^inject$/i }).click();

  expect(await waitForStatus(page, agentId, ['WAITING_FOR_APPROVAL'])).toBe('WAITING_FOR_APPROVAL');

  await page.goto(`/activity?agentId=${agentId}`);
  await page.getByText('Does the approval gate hold this?').first().click();
  await expect(page.getByRole('textbox', { name: /reply text/i })).toBeVisible({ timeout: 20_000 });

  await page.getByRole('textbox', { name: /reply text/i }).fill('Approved and edited by the end-to-end suite.');
  await page.getByRole('button', { name: /approve with edits/i }).click();

  expect(await waitForStatus(page, agentId, ['EXECUTED'])).toBe('EXECUTED');
  await page.reload();
  await expect(page.getByText('Approved and edited by the end-to-end suite.')).toBeVisible({ timeout: 20_000 });
});

test('shows why a memory was retrieved in a different conversation', async ({ page }) => {
  await useInterface(page, 'advanced');
  await signIn(page);
  await page.goto(`/agents/${agentId}`);

  // A new thread, same person, asking about the fact stated earlier.
  await page.locator('#activity').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: /inject a test event/i }).first().click();
  await page.locator('#ihandle').fill('e2e_user');
  await page.locator('#itext').fill('What colour did I say I liked?');
  await page.locator('#ithread').fill('e2e-thread-elsewhere');
  await page.getByRole('button', { name: /^inject$/i }).click();

  await waitForStatus(page, agentId, ['EXECUTED', 'DRY_RUN_COMPLETED']);

  await page.goto(`/activity?agentId=${agentId}`);
  await page.getByText('What colour did I say I liked?').first().click();

  const retrieved = page.locator('section').filter({ hasText: /retrieved memories/i }).first();
  await expect(retrieved).toBeVisible({ timeout: 20_000 });
  await expect(retrieved).toContainText(/teal/i);
  // The justification is recorded at the moment of the decision, and shown here.
  await expect(retrieved).toContainText(/why: same remote user @e2e_user/i);
});

test('memory section counts what the agent actually learned', async ({ page }) => {
  await useInterface(page, 'advanced');
  await signIn(page);
  await page.goto(`/agents/${agentId}`);
  const memory = page.locator('#memory');
  await memory.scrollIntoViewIfNeeded();

  await expect(memory.getByRole('button', { name: /^\d+ USER$/ })).toBeVisible({ timeout: 20_000 });
  await memory.getByRole('button', { name: /USER/ }).click();
  await expect(memory).toContainText(/teal/i, { timeout: 20_000 });
});

/**
 * These run against the real stack as the real owner, so what they create ends
 * up in somebody's actual agent list. Cleaning up is part of the test.
 */
test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  try {
    await useInterface(page, 'advanced');
  await signIn(page);
    const agents = await deleteAgentsNamed(page, 'E2E Runtime');
    const accounts = await deleteMockAccountsNamed(page, 'e2e_runtime_');
    console.log(`cleanup: removed ${agents} agent(s) and ${accounts} mock account(s)`);
  } catch (error) {
    // Never fail a passing run on cleanup, but say so: a silent leak is how
    // thirty-seven of these accumulated.
    console.warn('cleanup failed:', (error as Error).message);
  } finally {
    await page.close();
  }
});
