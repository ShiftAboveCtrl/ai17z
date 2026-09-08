import { expect, test, type Page } from '@playwright/test';
import { deleteAgentsNamed, deleteProvidersLabelled, signIn, uniqueName, useInterface } from './helpers';

test.describe.configure({ mode: 'serial' });

const EASY_NAME = uniqueName('Setup Easy');
const ADVANCED_NAME = uniqueName('Setup Adv');
const PROVIDER_LABEL = uniqueName('Setup Provider');

/**
 * The two wizards, on the things they share rather than on what each asks.
 *
 * Easy and Advanced are one configuration system behind two sets of questions.
 * These tests are about the shared half: that going back does not lose what was
 * typed, that a model can be named by hand when the provider offers no list,
 * and that both create an agent whether or not it is ready to run.
 */

const cont = (page: Page) => page.getByRole('button', { name: 'Continue' }).click();

test('Easy Mode keeps the answers when you step back and forward', async ({ page }) => {
  await useInterface(page, 'easy');
  await signIn(page);
  await page.goto('/agents/new');

  await page.locator('#name').fill(EASY_NAME);
  await cont(page);
  await expect(page.getByText(/step 2 of 8/i)).toBeVisible();

  // Back to the first step. The agent has already been created by this point,
  // which is what makes losing the field dangerous rather than annoying: a
  // second Continue would be editing an agent whose name it had forgotten.
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByText(/step 1 of 8/i)).toBeVisible();
  await expect(page.locator('#name')).toHaveValue(EASY_NAME);

  // Connect X, Connect AI, then Character.
  await cont(page);
  await cont(page);
  await cont(page);
  await expect(page.getByText(/step 4 of 8/i)).toBeVisible();
  await page.locator('#personality').fill('Says one thing and stops.');

  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByText(/step 2 of 8/i)).toBeVisible();
  await cont(page);
  await cont(page);
  await expect(page.locator('#personality')).toHaveValue('Says one thing and stops.');
});

test('Advanced keeps the answers when you step back and forward', async ({ page }) => {
  await useInterface(page, 'advanced');
  await signIn(page);
  await page.goto('/agents/new/advanced');

  await page.locator('#name').fill(ADVANCED_NAME);
  await page.locator('#description').fill('Written on the first step.');
  await cont(page);
  await cont(page);
  await expect(page.getByText(/step 3 of 8/i)).toBeVisible();
  await page.locator('#tone').fill('Direct and brief.');

  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.locator('#name')).toHaveValue(ADVANCED_NAME);
  await expect(page.locator('#description')).toHaveValue('Written on the first step.');

  await cont(page);
  await cont(page);
  await expect(page.locator('#tone')).toHaveValue('Direct and brief.');
});

test('a model can be named by hand when no list offers it', async ({ page }) => {
  await useInterface(page, 'advanced');
  await signIn(page);

  // A provider whose models have never been fetched, so there is no list. This
  // is the ordinary case for a key added a moment ago, and for a model released
  // this morning that no /models endpoint mentions yet.
  await page.goto('/settings');
  await page.getByRole('button', { name: /add provider/i }).first().click();
  await page.locator('#pkind').selectOption('mock');
  await page.locator('#plabel').fill(PROVIDER_LABEL);
  await page.getByRole('button', { name: /^add provider$/i }).last().click();
  // The label also appears in the system health list, so scope to the section.
  await expect(page.locator('#providers').getByText(PROVIDER_LABEL, { exact: true })).toBeVisible({
    timeout: 20_000,
  });

  await page.goto('/agents/new/advanced');
  await page.locator('#name').fill(`${ADVANCED_NAME} manual`);
  await cont(page);
  await cont(page);
  await cont(page);
  await expect(page.getByText(/step 4 of 8/i)).toBeVisible();

  // The model field appears once a provider is chosen, because until then
  // there is nothing to name a model for.
  await page.locator('#provider').selectOption({ label: `${PROVIDER_LABEL} (mock)` });

  // A box rather than a list: nobody has asked this provider what it offers
  // yet. That is the ordinary case for a key added a moment ago, and for a
  // model released this morning that no /models response mentions.
  await expect(page.locator('input#model')).toBeVisible();
  await page.locator('#model').fill('mock-echo');
  await expect(page.locator('#model')).toHaveValue('mock-echo');

  // And it survives the trip to Review, which is where it would be written.
  await cont(page);
  await cont(page);
  await cont(page);
  await cont(page);
  await expect(page.getByText(/step 8 of 8/i)).toBeVisible();
  await expect(page.getByText('mock-echo')).toBeVisible();
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await signIn(page);
  await deleteAgentsNamed(page, EASY_NAME);
  await deleteAgentsNamed(page, ADVANCED_NAME);
  await deleteProvidersLabelled(page, PROVIDER_LABEL);
  await page.close();
});
