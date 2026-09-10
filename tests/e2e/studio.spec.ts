import { expect, test, type Page } from '@playwright/test';
import { NormalizedEvent } from '@xbam/shared/contracts';
import {
  accounts as accountsRepo,
  events as eventsRepo,
  query,
  withTransaction,
  users as usersRepo,
} from '@xbam/database';
import { deleteAgentsNamed, signIn, uniqueName, useInterface } from './helpers';

test.describe.configure({ mode: 'serial' });

const AGENT_NAME = uniqueName('Studio E2E');

/**
 * X Studio, on an agent that has done nothing yet.
 *
 * That is the case worth testing rather than a convenience. Every view here has
 * an empty state, and on a new installation every one of them is what somebody
 * actually sees -- so a Studio that renders beautifully with data and shows six
 * blank panels on day one has failed at the only moment it was going to be
 * judged.
 *
 * Each empty state has to say what would have been there and why nothing is.
 * `InboxPage` learned the same lesson: five of its six buckets said "Nothing
 * here" and stopped, which reads as a screen that failed to load.
 */

async function createAgent(page: Page, name: string): Promise<string> {
  return page.evaluate(async (agentName) => {
    const token = localStorage.getItem('ai17z.session') ?? localStorage.getItem('xbam.session');
    const response = await fetch('/api/agents', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: agentName,
        description: 'Created by the Studio end-to-end spec.',
        persona: { displayName: agentName, topics: ['rollups'] },
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error?.message ?? 'Could not create the agent.');
    return body.data.id as string;
  }, name);
}

test('opens Studio from the agent page and shows every view', async ({ page }) => {
  await useInterface(page, 'advanced');
  await signIn(page);
  const agentId = await createAgent(page, AGENT_NAME);

  await page.goto(`/agents/${agentId}`);
  await page.getByRole('link', { name: 'Studio' }).first().click();
  await expect(page).toHaveURL(new RegExp(`/agents/${agentId}/studio$`));

  // Command lands first and says where things stand rather than showing a
  // wall of gauges nobody can read.
  await expect(page.getByRole('heading', { name: 'Where things stand' })).toBeVisible();
  await expect(page.getByText('worth answering')).toBeVisible();

  for (const [tab, heading] of [
    ['Growth', 'Worth speaking into'],
    ['Radar', 'What is being said'],
    ['People', 'Who leads somewhere new'],
    ['Analytics', 'What has worked'],
    ['Launches', 'What is being launched'],
    ['Create', 'Something to say'],
    ['Experiments', 'Try one thing against another'],
  ] as const) {
    await page.getByRole('button', { name: tab, exact: true }).click();
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }
});

test('every empty state says what would have been there', async ({ page }) => {
  await useInterface(page, 'advanced');
  await signIn(page);
  const agentId = await createAgent(page, `${AGENT_NAME} empty`);
  await page.goto(`/agents/${agentId}/studio`);

  // A brand new agent has nothing connected, so the per-account views all say
  // the one thing somebody can do about it rather than four different ways of
  // saying nothing happened.
  for (const tab of ['Radar', 'People', 'Launches'] as const) {
    await page.getByRole('button', { name: tab, exact: true }).click();
    await expect(page.getByText('Nothing connected yet')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Connect an account' })).toBeVisible();
  }

  // The two that are about the agent rather than about what it can see say what
  // would have been there and why nothing is. That sentence is the difference
  // between an empty screen and one that failed to load.
  for (const [tab, text] of [
    ['Analytics', /at least five measured posts on each side/],
    ['Create', /An empty backlog means silence/],
  ] as const) {
    await page.getByRole('button', { name: tab, exact: true }).click();
    await expect(page.getByText(text)).toBeVisible();
  }
});

test('an idea written in Studio lands in the backlog the posting engine reads', async ({ page }) => {
  await useInterface(page, 'advanced');
  await signIn(page);
  const agentId = await createAgent(page, `${AGENT_NAME} idea`);
  await page.goto(`/agents/${agentId}/studio`);
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  const idea = 'Sequencer downtime is becoming a pattern';
  await page.getByRole('textbox').first().fill(idea);
  await page.getByRole('button', { name: 'Add to the backlog' }).click();
  await expect(page.getByRole('heading', { name: idea })).toBeVisible();

  // The same backlog, not a Studio-only copy: the Behaviour screen is where it
  // was edited before this page existed, and both have to be looking at one
  // list or the posting engine is reading the wrong one.
  await page.goto(`/agents/${agentId}`);
  await page.getByRole('button', { name: 'Behaviour', exact: true }).first().click();
  await expect(page.getByText(idea).first()).toBeVisible();
});

/**
 * The populated case, seeded straight into the database.
 *
 * The empty states above are what somebody meets on day one; this is what the
 * screens are actually for, and it is the only way to find out whether a real
 * narrative wraps, whether a contract address overflows its card, and whether
 * the reasons under a score are readable rather than a wall.
 *
 * Seeded through the repositories rather than through the interface because
 * there is no interface for "this account saw forty posts this morning" -- the
 * radar does that, against X. Everything it writes is removed afterwards: these
 * specs run against somebody's real installation, and thirty synthetic posts
 * left in a real account's history is exactly the kind of mess a test should
 * not make.
 */
test.describe('with something to show', () => {
  // Named under the same prefix the suite cleans up by. A block that invents
  // its own name leaves its agents behind in somebody's real list, which is
  // how thirty-seven "E2E Agent" rows accumulated once already.
  const SEEDED = `${AGENT_NAME} seeded`;
  let agentId = '';
  let accountId = '';

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await useInterface(page, 'advanced');
    await signIn(page);
    agentId = await createAgent(page, SEEDED);
    await page.close();

    const owner = (await usersRepo.listUsers())[0]!;
    const account = await accountsRepo.createAccount({
      ownerId: owner.id,
      channel: 'x',
      handle: `studio_${Date.now().toString(36).slice(-6)}`,
    });
    accountId = account.id;
    await accountsRepo.linkAgentAccount({ agentId, accountId, actionType: 'REPLY' });

    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const seed = async (handle: string, text: string) => {
      await withTransaction(async (tx) => {
        await eventsRepo.ingestEvent(
          tx,
          accountId,
          NormalizedEvent.parse({
            channel: 'x',
            type: 'MENTION',
            remoteEventId: `studio-${handle}-${Math.random().toString(36).slice(2)}`,
            remoteAuthorHandle: handle,
            remoteAuthorDisplayName: handle,
            text,
            occurredAt: oneHourAgo,
          }),
        );
      });
    };

    // Fourteen accounts on one subject, each saying it differently.
    //
    // Deliberately not fourteen copies of one sentence. Identical posts make
    // every word in them equally well attested, so "becoming" ranks with
    // "sequencer" -- which is the honest answer to a question nobody would ask.
    // Real timelines vary around a shared subject, and that variation is what
    // makes the subject stand out at all.
    const said = [
      'the sequencer went down again and nobody has said why',
      'third sequencer outage this month, at some point that is the product',
      'watching my transaction sit there because the sequencer is having a morning',
      'sequencer is back. no post-mortem, as usual',
      'genuinely asking: what is the plan when the sequencer stops',
      'sequencer downtime is fine until it is your money in the queue',
      'every chain has one sequencer and every chain pretends that is temporary',
      'if the sequencer is centralised just say so on the front page',
      'been down twenty minutes. sequencer, obviously',
      'the sequencer question is the only interesting question left here',
      'nobody wants to talk about who actually runs the sequencer',
      'sequencer uptime numbers would be a nice thing to publish',
      'i can live with a slow sequencer. i cannot live with a silent one',
      'the sequencer stopped and the dashboard says everything is green',
    ];
    for (const [i, text] of said.entries()) await seed(`voice${i}`, text);
    // A ticker two accounts disagree about, which is the warning worth seeing.
    await seed('alice', '$demo is live 0x1111111111111111111111111111111111111111 get in');
    await seed('bob', '$demo real contract 0x2222222222222222222222222222222222222222');
  });

  test.afterAll(async () => {
    if (!accountId) return;
    // events.account_id is NO ACTION rather than a cascade, so the rows have to
    // go before the account they point at.
    await query('DELETE FROM events WHERE account_id = $1', [accountId]);
    await query('DELETE FROM accounts WHERE id = $1', [accountId]);
  });

  test('shows a narrative several accounts are saying, and lets it become an idea', async ({ page }) => {
    await useInterface(page, 'advanced');
    await signIn(page);
    await page.goto(`/agents/${agentId}/studio`);
    await page.getByRole('button', { name: 'Radar', exact: true }).click();

    // Scoped to the card, not the first button on the page: which subject leads
    // is the module's decision and not this test's business, but the button has
    // to belong to the row it appears under.
    const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'sequencer' }) });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Add as an idea' }).click();
    await expect(card.getByRole('button', { name: 'In the backlog' })).toBeVisible();

    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText(/Something worth saying about sequencer/)).toBeVisible();
  });

  test('warns when two accounts post different addresses for one ticker', async ({ page }) => {
    await useInterface(page, 'advanced');
    await signIn(page);
    await page.goto(`/agents/${agentId}/studio`);
    await page.getByRole('button', { name: 'Launches', exact: true }).click();

    await expect(page.getByRole('heading', { name: '$demo' })).toBeVisible();
    await expect(page.getByText(/2 different addresses are being posted/)).toBeVisible();
    // Both addresses in full. A truncated one that somebody copies is worse
    // than none at all.
    await expect(page.getByText('0x1111111111111111111111111111111111111111', { exact: true })).toBeVisible();
    await expect(page.getByText('0x2222222222222222222222222222222222222222', { exact: true })).toBeVisible();
    await expect(page.getByText(/Verify an address at its source/)).toBeVisible();
  });
});

test('starts one experiment and refuses a second', async ({ page }) => {
  await useInterface(page, 'advanced');
  await signIn(page);
  const agentId = await createAgent(page, `${AGENT_NAME} experiment`);
  await page.goto(`/agents/${agentId}/studio`);
  await page.getByRole('button', { name: 'Experiments', exact: true }).click();

  await page.getByRole('textbox').first().fill('Do shorter posts get more replies?');
  await page.getByRole('button', { name: 'Start' }).click();

  // The verdict most of this screen ever shows, and the one it has to keep
  // showing for a fortnight: an agent posts twice a day, and a winner announced
  // on Thursday is how somebody rewrites their agent's voice on eleven posts.
  await expect(page.getByRole('heading', { name: 'Running now' })).toBeVisible();
  await expect(page.getByText('Not yet')).toBeVisible();
  await expect(page.getByText(/more posts needed/)).toBeVisible();

  // One at a time. The form is gone while one is running, which is the only
  // honest way to say "not two" on a screen.
  await expect(page.getByRole('button', { name: 'Start' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('heading', { name: 'Try one thing against another' })).toBeVisible();
  // Stopped, never deleted: a null result is most of what this teaches.
  await expect(page.getByText('Do shorter posts get more replies?')).toBeVisible();
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await useInterface(page, 'advanced');
  await signIn(page);
  await deleteAgentsNamed(page, AGENT_NAME);
  await page.close();
});
