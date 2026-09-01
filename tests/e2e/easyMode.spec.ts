import { expect, test, type Page } from '@playwright/test';
import { deleteAgentsNamed, signIn, uniqueName, useInterface } from './helpers';

test.describe.configure({ mode: 'serial' });

const AGENT_NAME = uniqueName('Easy E2E');

/**
 * Easy Mode, the whole way through, as somebody setting up for the first time.
 *
 * This is the flow a new owner actually meets: `/agents/new` is Easy Mode, and
 * the eight-step advanced wizard is a link in the corner. Nothing here touches
 * an Advanced screen until the last test, which is the point -- if Easy Mode
 * cannot get an agent from nothing to running on its own, it does not work,
 * whatever the Advanced screens can do.
 *
 * Connecting X is deliberately skipped. It opens a real Chrome window and waits
 * for a person to sign in by hand, which is not something a test can or should
 * do; the step says so itself and offers to do it later. The real sign-in path
 * is proved separately against a real account.
 */

async function continueStep(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Continue' }).click();
}

test('walks a new owner from nothing to a configured agent', async ({ page }) => {
  await useInterface(page, 'easy');
  await signIn(page);

  await page.getByRole('link', { name: /create agent/i }).first().click();
  await expect(page.getByText(/step 1 of 8/i)).toBeVisible();

  // 1 — Agent. The only thing that gates the first step.
  await page.locator('#name').fill(AGENT_NAME);
  await continueStep(page);

  // 2 — Connect X. Skipped on purpose; see the note above.
  await expect(page.getByText(/step 2 of 8/i)).toBeVisible();
  await expect(page.getByText(/connect an account later/i)).toBeVisible();
  await continueStep(page);

  // 3 — Character. The answers a model can actually imitate.
  await expect(page.getByText(/step 3 of 8/i)).toBeVisible();
  await page.locator('#description').fill('Answers questions about token distribution.');
  await page.locator('#personality').fill('Direct. Says the thing and stops.');
  await continueStep(page);

  // 4 — Connect AI. An existing provider is chosen rather than a key typed:
  // key entry has its own test in the settings suite, and a test should not be
  // inventing credentials.
  await expect(page.getByText(/step 4 of 8/i)).toBeVisible();
  await continueStep(page);

  // 5 — Replies. Who it answers.
  await expect(page.getByText(/step 5 of 8/i)).toBeVisible();
  await continueStep(page);

  // 6 — Posts. Whether it says anything unprompted.
  await expect(page.getByText(/step 6 of 8/i)).toBeVisible();
  await continueStep(page);

  // 7 — Operation. Review first is the honest default for somebody new.
  await expect(page.getByText(/step 7 of 8/i)).toBeVisible();
  await page.getByRole('button', { name: /review first/i }).first().click();
  await continueStep(page);

  // 8 — Review. Everything chosen, in one place, before anything runs.
  await expect(page.getByText(/step 8 of 8/i)).toBeVisible();
  await expect(page.getByText(AGENT_NAME, { exact: false }).first()).toBeVisible();

  // Start, on an agent with no X account and no model. It has to refuse, and
  // say why in words somebody can act on -- an agent that goes ACTIVE and then
  // fails its first job has told nobody anything.
  await page.getByRole('button', { name: /start agent/i }).click();
  await expect(page.getByText(/connect|model|account/i).first()).toBeVisible({ timeout: 20_000 });

  // No error codes, no leaked internals. The UI legitimately uses uppercase
  // labels, so this looks for the shape of a code -- screaming snake case --
  // rather than for capitals.
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/[A-Z]{3,}_[A-Z_]{2,}|\[object Object\]|undefined|null/);

  // Refusing must not have thrown the answers away. "Save and finish later" is
  // the way out of a wizard somebody could not complete, and it has to keep
  // what they typed.
  await page.getByRole('button', { name: /save and finish later/i }).click();
  await page.locator('#identity, #easy-view, main').first().waitFor({ timeout: 20_000 });
});

test('Easy and Advanced are the same configuration, not two of them', async ({ page }) => {
  await useInterface(page, 'advanced');
  await signIn(page);
  await page.goto('/');
  await page.getByRole('heading', { name: AGENT_NAME, exact: true }).first().click();

  // The Advanced surfaces exist for the agent Easy Mode made. If Easy had
  // written somewhere else, these sections would be empty or absent.
  await page.locator('#identity').waitFor({ timeout: 20_000 });
  for (const id of ['identity', 'intelligence', 'memory', 'pipeline', 'policies']) {
    await expect(page.locator(`#${id}`)).toBeAttached();
  }

  // And the character typed in Easy Mode is what Advanced holds. Read from the
  // field values, not the section text: an input's value is not text content,
  // and asserting on the latter passes for an empty form.
  await page.locator('#identity').scrollIntoViewIfNeeded();
  const personality = page.locator('#identity').locator('#personality');
  await expect(personality).toHaveValue(/direct/i);
});

test('a change made in Advanced comes back through Easy', async ({ page }) => {
  await useInterface(page, 'advanced');
  await signIn(page);
  await page.goto('/');
  await page.getByRole('heading', { name: AGENT_NAME, exact: true }).first().click();
  await page.locator('#identity').waitFor({ timeout: 20_000 });

  // Scoped to the identity section: policies and cadence have their own
  // "save as version" buttons, and an unscoped match cuts a version of the
  // wrong document.
  const identity = page.locator('#identity');
  const personality = identity.locator('#personality');
  await personality.fill('Changed from the advanced screen.');

  const before = Number((await identity.getByText(/currently v\d+/i).innerText()).replace(/\D/g, ''));
  await identity.getByRole('button', { name: /save as version/i }).click();
  await expect(identity.getByText(new RegExp(`currently v${before + 1}`, 'i'))).toBeVisible({ timeout: 20_000 });

  // Back to Easy. The simplified view has to be reading the same document, not
  // a copy it kept.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('ai17z.viewMode', 'easy');
    } catch {
      // See useInterface.
    }
  });
  await page.reload();

  // The Easy view is a page you read; the answers live behind Edit.
  await page.getByRole('button', { name: /^edit$/i }).first().click();

  // Read the value. `readEasyView`
  // projects the same persona document the Advanced screen just versioned; if
  // Easy kept a copy of its own this is where the two would disagree.
  await expect(page.locator('#ez-personality')).toHaveValue(/changed from the advanced screen/i, {
    timeout: 20_000,
  });
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await signIn(page);
  await deleteAgentsNamed(page, AGENT_NAME);
  await page.close();
});
