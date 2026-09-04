import { describe, expect, it } from 'vitest';
import { accounts as accountsRepo, agents as agentsRepo, notifications as notificationsRepo, query } from '@xbam/database';
import {
  accountIsWell,
  accountNeedsUser,
  checkWorkerPresence,
  notificationKey,
  notificationSummary,
  sweepNotifications,
} from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

async function makeAccount(ownerId: string, status: string): Promise<string> {
  const account = await accountsRepo.createAccount({
    ownerId,
    channel: 'x',
    handle: `acct${uniqueSuffix()}`.slice(0, 15),
    displayName: 'Test account',
  });
  await accountsRepo.updateAccount(account.id, { status: status as never });
  return account.id;
}

/**
 * The whole point of the dedupe key. A poller that fails every thirty seconds
 * must produce one row with a count, not two thousand rows overnight, and the
 * unique index is what enforces that rather than application logic.
 */
describe('the same problem happening again', () => {
  it('is one notification with a count', async () => {
    const fixture = await createFixture();
    const accountId = await makeAccount(fixture.ownerId, 'CHALLENGE_REQUIRES_USER');

    for (let i = 0; i < 5; i += 1) {
      await accountNeedsUser({ accountId, handle: 'someone', challengeKind: 'captcha', detail: 'A CAPTCHA is waiting.' });
    }

    const open = await notificationsRepo.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0]!.occurrences).toBe(5);
  });

  it('keeps when it started and updates when it last happened', async () => {
    const fixture = await createFixture();
    const accountId = await makeAccount(fixture.ownerId, 'CHALLENGE_REQUIRES_USER');
    const first = await accountNeedsUser({ accountId, handle: 'someone', challengeKind: null, detail: 'One.' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const again = await accountNeedsUser({ accountId, handle: 'someone', challengeKind: null, detail: 'Two.' });

    expect(again!.firstSeenAt).toBe(first!.firstSeenAt);
    expect(Date.parse(again!.lastSeenAt)).toBeGreaterThan(Date.parse(first!.lastSeenAt));
    // The latest wording wins: a newer error is more use than the first one.
    expect(again!.body).toContain('Two.');
  });

  it('keeps the worse severity when a problem gets worse and stays worse', async () => {
    const fixture = await createFixture();
    await notificationsRepo.raise({
      kind: 'TEST',
      severity: 'WARNING',
      title: 'Something',
      dedupeKey: `t-${fixture.agentId}`,
    });
    await notificationsRepo.raise({
      kind: 'TEST',
      severity: 'CRITICAL',
      title: 'Something worse',
      dedupeKey: `t-${fixture.agentId}`,
    });
    const escalated = await notificationsRepo.raise({
      kind: 'TEST',
      severity: 'INFO',
      title: 'Something calmer',
      dedupeKey: `t-${fixture.agentId}`,
    });
    expect(escalated!.severity).toBe('CRITICAL');
  });

  it('separates one account from another', async () => {
    const fixture = await createFixture();
    const a = await makeAccount(fixture.ownerId, 'CHALLENGE_REQUIRES_USER');
    const b = await makeAccount(fixture.ownerId, 'CHALLENGE_REQUIRES_USER');
    await accountNeedsUser({ accountId: a, handle: 'one', challengeKind: null, detail: 'x' });
    await accountNeedsUser({ accountId: b, handle: 'two', challengeKind: null, detail: 'x' });
    expect(await notificationsRepo.listOpen()).toHaveLength(2);
  });
});

describe('acknowledging', () => {
  it('clears it from the list', async () => {
    const fixture = await createFixture();
    const raised = await notificationsRepo.raise({ kind: 'TEST', severity: 'WARNING', title: 'A thing', dedupeKey: `k-${fixture.agentId}` });
    await notificationsRepo.acknowledge({ id: raised!.id, by: 'someone@example.test' });
    expect(await notificationsRepo.listOpen()).toHaveLength(0);
  });

  it('lets the same problem be news again afterwards', async () => {
    // "I fixed it and it broke again" is information, not a duplicate.
    const fixture = await createFixture();
    const key = `k-${fixture.agentId}`;
    const first = await notificationsRepo.raise({ kind: 'TEST', severity: 'WARNING', title: 'A thing', dedupeKey: key });
    await notificationsRepo.acknowledge({ id: first!.id, by: 'someone@example.test' });

    const second = await notificationsRepo.raise({ kind: 'TEST', severity: 'WARNING', title: 'A thing', dedupeKey: key });
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first!.id);
    expect(second!.occurrences).toBe(1);
  });

  it('stays quiet while a mute is running, and counts what happened anyway', async () => {
    const fixture = await createFixture();
    const key = `k-${fixture.agentId}`;
    const first = await notificationsRepo.raise({ kind: 'TEST', severity: 'WARNING', title: 'A thing', dedupeKey: key });
    await notificationsRepo.acknowledge({ id: first!.id, by: 'someone@example.test', muteMs: 60_000 });

    // Null rather than a row: the caller can tell "told them" from
    // "deliberately did not".
    expect(await notificationsRepo.raise({ kind: 'TEST', severity: 'WARNING', title: 'A thing', dedupeKey: key })).toBeNull();
    expect(await notificationsRepo.listOpen()).toHaveLength(0);

    const [row] = await query<{ occurrences: number }>('SELECT occurrences FROM notifications WHERE id = $1', [first!.id]);
    expect(row!.occurrences).toBe(2);
  });

  it('speaks up again once the mute has run out', async () => {
    const fixture = await createFixture();
    const key = `k-${fixture.agentId}`;
    const first = await notificationsRepo.raise({ kind: 'TEST', severity: 'WARNING', title: 'A thing', dedupeKey: key });
    await notificationsRepo.acknowledge({ id: first!.id, by: 'someone@example.test', muteMs: 60_000 });
    await query("UPDATE notifications SET muted_until = now() - interval '1 minute' WHERE id = $1", [first!.id]);

    expect(await notificationsRepo.raise({ kind: 'TEST', severity: 'WARNING', title: 'A thing', dedupeKey: key })).not.toBeNull();
  });

  it('is not an error when somebody else already cleared it', async () => {
    const fixture = await createFixture();
    const raised = await notificationsRepo.raise({ kind: 'TEST', severity: 'INFO', title: 'A thing', dedupeKey: `k-${fixture.agentId}` });
    await notificationsRepo.acknowledge({ id: raised!.id, by: 'one@example.test' });
    expect(await notificationsRepo.acknowledge({ id: raised!.id, by: 'two@example.test' })).toBeNull();
  });
});

/**
 * A notification left on the screen after the problem went away teaches people
 * to ignore the screen. Everything that can fix itself is cleared by the sweep
 * that would have raised it.
 */
describe('a problem that fixed itself', () => {
  it('is cleared rather than left sitting there', async () => {
    const fixture = await createFixture();
    const accountId = await makeAccount(fixture.ownerId, 'CHALLENGE_REQUIRES_USER');
    await accountNeedsUser({ accountId, handle: 'someone', challengeKind: null, detail: 'x' });
    expect(await notificationsRepo.listOpen()).toHaveLength(1);

    await accountIsWell(accountId);
    expect(await notificationsRepo.listOpen()).toHaveLength(0);
  });

  it('keeps the record that it happened', async () => {
    const fixture = await createFixture();
    const accountId = await makeAccount(fixture.ownerId, 'CHALLENGE_REQUIRES_USER');
    await accountNeedsUser({ accountId, handle: 'someone', challengeKind: null, detail: 'x' });
    await accountIsWell(accountId);

    const recent = await notificationsRepo.listRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0]!.acknowledgedBy).toBe('resolved');
  });
});

describe('the sweep', () => {
  it('raises for an account that needs a person and clears when it does not', async () => {
    const fixture = await createFixture();
    const accountId = await makeAccount(fixture.ownerId, 'CHALLENGE_REQUIRES_USER');

    await sweepNotifications();
    const open = await notificationsRepo.listOpen();
    expect(open.some((n) => n.dedupeKey === notificationKey.accountNeedsUser(accountId))).toBe(true);

    await accountsRepo.updateAccount(accountId, { status: 'CONNECTED' });
    await sweepNotifications();
    const after = await notificationsRepo.listOpen();
    expect(after.some((n) => n.dedupeKey === notificationKey.accountNeedsUser(accountId))).toBe(false);
  });

  it('says nothing about an agent nobody has switched on yet', async () => {
    // An agent still being set up has no model by definition. Saying so is
    // noise, not news.
    const fixture = await createFixture();
    await agentsRepo.updateAgent(fixture.agentId, { state: 'DRAFT' });
    await query('DELETE FROM model_configs WHERE agent_id = $1', [fixture.agentId]);

    await sweepNotifications();
    const open = await notificationsRepo.listOpen();
    expect(open.some((n) => n.dedupeKey === notificationKey.noModel(fixture.agentId))).toBe(false);
  });

  it('says so about an active agent that cannot write anything', async () => {
    const fixture = await createFixture();
    await agentsRepo.updateAgent(fixture.agentId, { state: 'ACTIVE' });
    await query('DELETE FROM model_configs WHERE agent_id = $1', [fixture.agentId]);

    await sweepNotifications();
    const open = await notificationsRepo.listOpen();
    const found = open.find((n) => n.dedupeKey === notificationKey.noModel(fixture.agentId));
    expect(found?.severity).toBe('CRITICAL');
    expect(found?.actionLabel).toBeTruthy();
  });

  it('is safe to run twice, because that is what a loop does', async () => {
    const fixture = await createFixture();
    await makeAccount(fixture.ownerId, 'CHALLENGE_REQUIRES_USER');
    await sweepNotifications();
    const first = (await notificationsRepo.listOpen()).length;
    await sweepNotifications();
    expect((await notificationsRepo.listOpen()).length).toBe(first);
  });
});

describe('no worker running', () => {
  it('is critical, because nothing else on any screen will look wrong', async () => {
    const raised = await checkWorkerPresence();
    expect(raised?.severity).toBe('CRITICAL');
    expect(raised?.body).toContain('dev:worker');
  });

  it('clears the moment one reports in', async () => {
    await checkWorkerPresence();
    await query(
      `INSERT INTO workers (id, role, browser_capable, jobs_capable) VALUES ($1,'worker',false,true)
       ON CONFLICT (id) DO UPDATE SET last_seen_at = now()`,
      [`w-${uniqueSuffix()}`],
    );
    expect(await checkWorkerPresence()).toBeNull();
    expect((await notificationsRepo.listOpen()).some((n) => n.kind === 'WORKER_STOPPED')).toBe(false);
  });
});

describe('the badge in the header', () => {
  it('reports the worst thing open rather than only a number', async () => {
    // "3" reads the same whether it is three notes or an account locked out.
    const fixture = await createFixture();
    await notificationsRepo.raise({ kind: 'TEST', severity: 'INFO', title: 'a', dedupeKey: `a-${fixture.agentId}` });
    await notificationsRepo.raise({ kind: 'TEST', severity: 'CRITICAL', title: 'b', dedupeKey: `b-${fixture.agentId}` });

    const summary = await notificationSummary();
    expect(summary.total).toBe(2);
    expect(summary.worst).toBe('CRITICAL');
  });

  it('says nothing when there is nothing', async () => {
    const summary = await notificationSummary();
    expect(summary.worst).toBeNull();
    expect(summary.total).toBe(0);
  });
});

describe('ordering', () => {
  it('puts what stops the agent above what merely degrades it', async () => {
    const fixture = await createFixture();
    await notificationsRepo.raise({ kind: 'TEST', severity: 'INFO', title: 'a note', dedupeKey: `a-${fixture.agentId}` });
    await notificationsRepo.raise({ kind: 'TEST', severity: 'WARNING', title: 'degraded', dedupeKey: `b-${fixture.agentId}` });
    await notificationsRepo.raise({ kind: 'TEST', severity: 'CRITICAL', title: 'stopped', dedupeKey: `c-${fixture.agentId}` });

    const open = await notificationsRepo.listOpen();
    expect(open.map((n) => n.severity)).toEqual(['CRITICAL', 'WARNING', 'INFO']);
  });

  it('shows an installation-wide problem on the list for one agent', async () => {
    // A worker that is not running is the reason this agent is doing nothing.
    const fixture = await createFixture();
    await checkWorkerPresence();
    const open = await notificationsRepo.listOpen({ agentId: fixture.agentId });
    expect(open.some((n) => n.kind === 'WORKER_STOPPED')).toBe(true);
  });
});
