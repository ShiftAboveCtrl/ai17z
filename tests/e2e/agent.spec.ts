import { expect, test } from '@playwright/test';
import { deleteAgentsNamed, deleteMockAccountsNamed, openAgent, signIn, uniqueName } from './helpers';

test.describe.configure({ mode: 'serial' });

const AGENT_NAME = uniqueName('E2E Agent');

test('signs in and shows the agents page', async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Your agents' })).toBeVisible();
});

test('creates an agent through the wizard', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: /create agent/i }).first().click();

  await expect(page.getByText(/step 1 of 8/i)).toBeVisible();
  await page.locator('#name').fill(AGENT_NAME);
  await page.locator('#description').fill('Created by the end-to-end suite.');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Portrait, persona, intelligence, channel, memory, automation.
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: /disclosed ai/i }).first().click();
  await page.locator('#tone').fill('Direct and brief.');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: /autonomous/i }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByText(/^review$/i).first()).toBeVisible();
  await page.getByRole('button', { name: /create agent/i }).last().click();

  await page.locator('#identity').waitFor({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: AGENT_NAME, exact: true })).toBeVisible();
});

test('shows the agent sections and the pipeline it actually runs', async ({ page }) => {
  await signIn(page);
  await openAgent(page, AGENT_NAME);

  for (const id of ['identity', 'accounts', 'intelligence', 'memory', 'pipeline', 'tools', 'policies', 'activity']) {
    await expect(page.locator(`#${id}`)).toBeAttached();
  }

  await page.locator('#pipeline').scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: /resolve context/i })).toBeVisible();
  await page.getByRole('button', { name: /retrieve memory/i }).click();
  await expect(page.getByRole('dialog')).toContainText(/every selection records why/i);
  await page.getByRole('button', { name: 'Close' }).click();
});

test('edits the persona and cuts a new version', async ({ page }) => {
  await signIn(page);
  await openAgent(page, AGENT_NAME);

  // Identity and policies both offer a version button, so scope to the section.
  const identity = page.locator('#identity');
  await identity.scrollIntoViewIfNeeded();
  const version = identity.getByText(/currently v\d+/i);
  const before = await version.innerText();

  await page.locator('#personality').fill('Edited by the end-to-end suite.');
  await identity.getByRole('button', { name: /save as version/i }).click();

  await expect(identity.getByText('saved')).toBeVisible({ timeout: 20_000 });
  await expect(version).not.toHaveText(before, { timeout: 20_000 });
});

/**
 * These run against the real stack as the real owner, so what they create ends
 * up in somebody's actual agent list. Cleaning up is part of the test.
 */
test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  try {
    await signIn(page);
    const agents = await deleteAgentsNamed(page, 'E2E Agent');
    const accounts = await deleteMockAccountsNamed(page, 'e2e_agent_');
    console.log(`cleanup: removed ${agents} agent(s) and ${accounts} mock account(s)`);
  } catch (error) {
    // Never fail a passing run on cleanup, but say so: a silent leak is how
    // thirty-seven of these accumulated.
    console.warn('cleanup failed:', (error as Error).message);
  } finally {
    await page.close();
  }
});
