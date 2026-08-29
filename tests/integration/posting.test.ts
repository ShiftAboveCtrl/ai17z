import { describe, expect, it } from 'vitest';
import { accounts, agents, content, jobs, posting } from '@xbam/database';
import { originatePost, runDuePosts } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture, seedCatalogue } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * Posting when nobody asked.
 *
 * The failure worth designing against is an agent that posts because a timer
 * fired. The schedule is permission to look at the idea backlog, and an empty
 * backlog means silence with a reason recorded. The other failure is posting
 * the same thing twice, which is why the idea id anchors the idempotency key.
 */

async function connectedAccount(ownerId: string, agentId: string): Promise<string> {
  const suffix = uniqueSuffix();
  const account = await accounts.createAccount({
    ownerId,
    channel: 'mock',
    handle: `poster-${suffix}`,
    displayName: 'Poster',
  });
  await accounts.linkAgentAccount({
    agentId,
    accountId: account.id,
    triggerEventTypes: ['MENTION'],
    actionType: 'REPLY',
    enabled: true,
  });
  return account.id;
}

describe('deciding to post', () => {
  it('says nothing when the backlog is empty, and says why', async () => {
    await seedCatalogue();
    const fixture = await createFixture();
    await agents.updateAgent(fixture.agentId, { state: 'ACTIVE' });
    const accountId = await connectedAccount(fixture.ownerId, fixture.agentId);

    const result = await originatePost({ agentId: fixture.agentId, accountId });
    expect(result.posted).toBe(false);
    expect(result.reason).toContain('backlog');
    expect(result.jobId).toBeNull();
  });

  it('creates one POST job from the best idea', async () => {
    await seedCatalogue();
    const fixture = await createFixture();
    await agents.updateAgent(fixture.agentId, { state: 'ACTIVE' });
    const accountId = await connectedAccount(fixture.ownerId, fixture.agentId);
    await content.addIdea({
      agentId: fixture.agentId,
      summary: 'Fees are a design choice, not a law of nature.',
      score: 90,
    });

    const result = await originatePost({ agentId: fixture.agentId, accountId });
    expect(result.posted).toBe(true);
    expect(result.jobId).toBeTruthy();

    const job = await jobs.getJob(result.jobId!);
    expect(job?.actionType).toBe('POST');
    // A post is a real action or it is nothing. There is no target to dry run
    // against, and review still holds it for a person.
    expect(job?.dryRun).toBe(false);
  });

  it('refuses when the agent is not active', async () => {
    await seedCatalogue();
    const fixture = await createFixture();
    const accountId = await connectedAccount(fixture.ownerId, fixture.agentId);
    await content.addIdea({ agentId: fixture.agentId, summary: 'Something.', score: 90 });

    // The fixture agent is DRAFT until activated.
    const result = await originatePost({ agentId: fixture.agentId, accountId });
    expect(result.posted).toBe(false);
    expect(result.reason).toContain('draft');
  });

  it('refuses when automation is monitor only', async () => {
    await seedCatalogue();
    const fixture = await createFixture({ policy: { automation: { mode: 'MONITOR_ONLY', dryRunDefault: false } } });
    await agents.updateAgent(fixture.agentId, { state: 'ACTIVE' });
    const accountId = await connectedAccount(fixture.ownerId, fixture.agentId);
    await content.addIdea({ agentId: fixture.agentId, summary: 'Something.', score: 90 });

    const result = await originatePost({ agentId: fixture.agentId, accountId });
    expect(result.posted).toBe(false);
    expect(result.reason).toContain('monitor only');
  });

  it('refuses when no account is connected', async () => {
    await seedCatalogue();
    const fixture = await createFixture();
    await agents.updateAgent(fixture.agentId, { state: 'ACTIVE' });
    await content.addIdea({ agentId: fixture.agentId, summary: 'Something.', score: 90 });

    const result = await originatePost({ agentId: fixture.agentId, accountId: null });
    expect(result.posted).toBe(false);
    expect(result.reason).toContain('No account');
  });
});

describe('the posting schedule', () => {
  it('does not fire the moment it is switched on', async () => {
    // Enabling posting should not publish something before the person who
    // enabled it has finished reading the screen.
    const fixture = await createFixture();
    const row = await posting.setSchedule({
      agentId: fixture.agentId,
      accountId: null,
      enabled: true,
      intervalSeconds: 3_600,
    });
    expect(row.nextPostAt).toBeTruthy();
    expect(new Date(row.nextPostAt!).getTime()).toBeGreaterThan(Date.now() + 3_000_000);
    expect(await posting.claimDue(10)).toEqual([]);
  });

  it('keeps the appointment when an unrelated setting is saved', async () => {
    const fixture = await createFixture();
    const first = await posting.setSchedule({
      agentId: fixture.agentId,
      accountId: null,
      enabled: true,
      intervalSeconds: 3_600,
    });
    const again = await posting.setSchedule({
      agentId: fixture.agentId,
      accountId: null,
      enabled: true,
      intervalSeconds: 3_600,
    });
    expect(again.nextPostAt).toBe(first.nextPostAt);
  });

  it('moves the appointment when the rhythm changes', async () => {
    const fixture = await createFixture();
    const first = await posting.setSchedule({
      agentId: fixture.agentId,
      accountId: null,
      enabled: true,
      intervalSeconds: 3_600,
    });
    const changed = await posting.setSchedule({
      agentId: fixture.agentId,
      accountId: null,
      enabled: true,
      intervalSeconds: 79_200,
    });
    expect(changed.nextPostAt).not.toBe(first.nextPostAt);
  });

  it('clears the appointment when posting is turned off', async () => {
    const fixture = await createFixture();
    await posting.setSchedule({ agentId: fixture.agentId, accountId: null, enabled: true, intervalSeconds: 3_600 });
    const off = await posting.setSchedule({
      agentId: fixture.agentId,
      accountId: null,
      enabled: false,
      intervalSeconds: 3_600,
    });
    expect(off.nextPostAt).toBeNull();
    expect(await posting.claimDue(10)).toEqual([]);
  });

  it('claims a due schedule once and moves it on in the same statement', async () => {
    await seedCatalogue();
    const fixture = await createFixture();
    await agents.updateAgent(fixture.agentId, { state: 'ACTIVE' });
    const accountId = await connectedAccount(fixture.ownerId, fixture.agentId);
    await posting.setSchedule({ agentId: fixture.agentId, accountId, enabled: true, intervalSeconds: 3_600 });
    await makeDue(fixture.agentId);

    const [first, second] = await Promise.all([posting.claimDue(10), posting.claimDue(10)]);
    // Exactly one of the two passes sees it. Two workers must not both decide
    // it is time to speak.
    expect(first.length + second.length).toBe(1);
  });

  it('records why nothing was posted', async () => {
    await seedCatalogue();
    const fixture = await createFixture();
    await agents.updateAgent(fixture.agentId, { state: 'ACTIVE' });
    const accountId = await connectedAccount(fixture.ownerId, fixture.agentId);
    await posting.setSchedule({ agentId: fixture.agentId, accountId, enabled: true, intervalSeconds: 3_600 });
    await makeDue(fixture.agentId);

    const results = await runDuePosts(5);
    expect(results).toHaveLength(1);
    expect(results[0]!.posted).toBe(false);

    const row = await posting.getSchedule(fixture.agentId);
    // "It has not posted" needs an answer that is not a database query.
    expect(row?.lastReason).toContain('backlog');
    expect(row?.lastPostAt).toBeNull();
  });

  it('posts when there is something to say, and records that too', async () => {
    await seedCatalogue();
    const fixture = await createFixture();
    await agents.updateAgent(fixture.agentId, { state: 'ACTIVE' });
    const accountId = await connectedAccount(fixture.ownerId, fixture.agentId);
    await content.addIdea({ agentId: fixture.agentId, summary: 'Distribution changed; the vote did not.', score: 95 });
    await posting.setSchedule({ agentId: fixture.agentId, accountId, enabled: true, intervalSeconds: 3_600 });
    await makeDue(fixture.agentId);

    const results = await runDuePosts(5);
    expect(results[0]!.posted).toBe(true);

    const row = await posting.getSchedule(fixture.agentId);
    expect(row?.lastPostAt).toBeTruthy();
    expect(row?.lastJobId).toBe(results[0]!.jobId);
  });

  it('will not create two jobs for one idea', async () => {
    await seedCatalogue();
    const fixture = await createFixture();
    await agents.updateAgent(fixture.agentId, { state: 'ACTIVE' });
    const accountId = await connectedAccount(fixture.ownerId, fixture.agentId);
    const idea = await content.addIdea({ agentId: fixture.agentId, summary: 'Only once.', score: 95 });

    const first = await originatePost({ agentId: fixture.agentId, accountId });
    expect(first.posted).toBe(true);

    // Put the idea back as if a crash had released it, then try again. The
    // idempotency key is anchored to the idea, so the second attempt finds the
    // job that already exists rather than posting the same thought twice.
    await content.resolveIdea(idea.id, 'unused');
    const second = await originatePost({ agentId: fixture.agentId, accountId });
    expect(second.posted).toBe(false);
    expect(second.jobId).toBe(first.jobId);
  });
});

/** Brings a schedule forward so the test does not have to wait an hour. */
async function makeDue(agentId: string): Promise<void> {
  const { query } = await import('@xbam/database');
  await query(`UPDATE agent_posting SET next_post_at = now() - interval '1 minute' WHERE agent_id = $1`, [agentId]);
}
