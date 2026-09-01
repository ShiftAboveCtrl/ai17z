import { expect, test } from '@playwright/test';
import { signIn, uniqueName, useInterface, deleteAgentsNamed, deleteMockAccountsNamed } from './helpers';

/**
 * The inbox: who said something, and did they get an answer.
 *
 * The jobs list could never show this. A mention the agent never picked up has
 * no job, so it had no card, so there was no screen anywhere that could tell
 * you a monitor had found something and nothing had happened to it. That is
 * exactly the shape the reply bug had -- nineteen replies discovered, recorded,
 * and silently dropped -- and it went unnoticed for as long as it did partly
 * because there was nowhere to see it.
 */

test('shows what came in and what became of it', async ({ page }) => {
  await useInterface(page, 'advanced');
  await signIn(page);
  await page.goto('/activity');

  // The inbox is the default view: what arrived matters more day to day than
  // which pipeline step each job is on.
  await expect(page.getByRole('button', { name: 'Mentions' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Jobs' })).toHaveAttribute('aria-pressed', 'false');

  // The two questions, in the header, before any card is read.
  await expect(page.locator('main')).toContainText(/answered/);
  await expect(page.locator('main')).toContainText(/left alone/);
});

test('separates the answered from the unanswered', async ({ page }) => {
  await useInterface(page, 'advanced');
  await signIn(page);
  await page.goto('/activity');

  // Every state is its own filter with its own count, so "did anybody go
  // unanswered" is a question the screen answers rather than one you audit.
  for (const label of ['Replied', 'Waiting for you', 'Left alone', 'Not picked up']) {
    await expect(page.getByRole('button', { name: new RegExp(`^${label}`) })).toBeVisible();
  }

  await page.getByRole('button', { name: /^Replied/ }).click();
  await expect(page.getByRole('button', { name: /^Replied/ })).toHaveAttribute('aria-pressed', 'true');
});

test('switching to jobs still shows the pipeline', async ({ page }) => {
  await useInterface(page, 'advanced');
  await signIn(page);
  await page.goto('/activity');

  await page.getByRole('button', { name: 'Jobs' }).click();
  await expect(page.getByRole('button', { name: 'Everything' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Needs review' })).toBeVisible();
});

test('a mention that arrives lands in the inbox with what happened to it', async ({ page }) => {
  await useInterface(page, 'advanced');
  await signIn(page);
  await page.goto('/activity');

  const name = uniqueName('Inbox agent');
  const handle = `inbox_${Date.now().toString(36).slice(-5)}`;
  try {
    const result = await page.evaluate(
      async ({ agentName, accountHandle }) => {
        const token = localStorage.getItem('ai17z.session') ?? localStorage.getItem('xbam.session');
        const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
        const json = (r: Response) => r.json();

        const agent = await fetch('/api/agents', {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: agentName, description: 'inbox check' }),
        }).then(json);
        const agentId = agent?.data?.id;

        const account = await fetch('/api/accounts', {
          method: 'POST',
          headers,
          body: JSON.stringify({ channel: 'mock', handle: accountHandle }),
        }).then(json);
        const accountId = account?.data?.id;

        const linked = await fetch(`/api/agents/${agentId}/accounts`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ accountId, actionType: 'REPLY' }),
        }).then(json);

        const injected = await fetch('/api/mock/inject', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            agentId,
            accountId,
            authorHandle: 'inbox_visitor',
            text: 'Does this show up in the inbox with what happened to it?',
            dryRun: true,
          }),
        }).then(json);

        const inbox = await fetch(`/api/mentions?agentId=${agentId}&limit=10`, { headers }).then(json);

        return {
          triggers: linked?.data?.items?.[0]?.triggerEventTypes ?? [],
          injected: injected?.ok === true,
          rows: inbox?.data?.items ?? [],
        };
      },
      { agentName: name, accountHandle: handle },
    );

    // The fix, seen from outside: a link made through the API is triggered by a
    // reply as well as a mention.
    expect(result.triggers).toContain('MENTION');
    expect(result.triggers).toContain('REPLY');

    expect(result.injected).toBe(true);
    const mine = result.rows.find((r: { authorHandle: string | null }) => r.authorHandle === 'inbox_visitor');
    expect(mine).toBeTruthy();
    // Not "not picked up": a job exists for it, which is the whole distinction
    // the inbox was built to show.
    expect(mine.state).not.toBe('NOT_ACTIONED');
    expect(mine.text).toContain('show up in the inbox');
  } finally {
    await deleteAgentsNamed(page, 'Inbox agent').catch(() => 0);
    await deleteMockAccountsNamed(page, 'inbox_').catch(() => 0);
  }
});
