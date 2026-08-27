import { describe, expect, it } from 'vitest';
import { accounts as accountsRepo, actions as actionsRepo, capabilities, jobs as jobsRepo } from '@xbam/database';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { drainJobs } from '../support/runner';
import { uniqueSuffix } from '../support/db';

installHarness();

async function linkedAccount(ownerId: string, agentId: string, actionType = 'REPLY') {
  const account = await accountsRepo.createAccount({
    ownerId,
    channel: 'mock',
    handle: `cap_${uniqueSuffix()}`,
  });
  await accountsRepo.updateAccount(account.id, { status: 'CONNECTED', enabled: true });
  await accountsRepo.linkAgentAccount({
    agentId,
    accountId: account.id,
    triggerEventTypes: ['MENTION'],
    actionType,
  });
  return account;
}

describe('capability grants', () => {
  it('gives a new link exactly what it needs and nothing more', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId, 'REPLY');

    const granted = await capabilities.grantsFor(fixture.agentId, account.id);
    expect([...granted].sort()).toEqual(['GENERATE', 'READ', 'REPLY']);
    expect(granted.has('POST')).toBe(false);
    expect(granted.has('DIRECT_MESSAGE')).toBe(false);
  });

  it('grants the action the link was created for, not a fixed one', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId, 'LIKE');
    const granted = await capabilities.grantsFor(fixture.agentId, account.id);
    expect(granted.has('LIKE')).toBe(true);
    expect(granted.has('REPLY')).toBe(false);
  });

  it('does not reset capabilities when the link is edited', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId, 'REPLY');
    await capabilities.setGrants(fixture.agentId, account.id, ['READ', 'GENERATE', 'REPLY', 'POST'], null);

    // Changing which events trigger the agent must not touch what it may do.
    await accountsRepo.linkAgentAccount({
      agentId: fixture.agentId,
      accountId: account.id,
      triggerEventTypes: ['MENTION', 'REPLY'],
      actionType: 'REPLY',
    });

    const granted = await capabilities.grantsFor(fixture.agentId, account.id);
    expect(granted.has('POST')).toBe(true);
  });

  it('replaces the whole set rather than merging, so revoking works', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);

    await capabilities.setGrants(fixture.agentId, account.id, ['READ'], null);
    const granted = await capabilities.grantsFor(fixture.agentId, account.id);
    expect([...granted]).toEqual(['READ']);
  });

  it('ignores anything that is not a capability', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);
    const granted = await capabilities.setGrants(
      fixture.agentId,
      account.id,
      ['READ', 'DROP TABLE' as never, 'REPLY'],
      null,
    );
    expect(granted).toEqual(['READ', 'REPLY']);
  });
});

describe('capabilities decide what reaches the queue', () => {
  it('creates a job when the action is granted', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);

    const outcome = await ingestNormalizedEvent({
      accountId: account.id,
      event: mockEvent('hello there'),
    });
    expect(outcome.jobs).toHaveLength(1);
  });

  it('records the event but queues nothing when the action is not granted', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId, 'REPLY');
    await capabilities.setGrants(fixture.agentId, account.id, ['READ', 'GENERATE'], null);

    const outcome = await ingestNormalizedEvent({
      accountId: account.id,
      event: mockEvent('you may not answer this'),
    });

    // The event is still on record: revoking permission is not the same as
    // pretending nothing arrived.
    expect(outcome.eventId).toBeTruthy();
    expect(outcome.jobs).toHaveLength(0);
    expect(outcome.skipped[0]?.reason).toMatch(/not permitted to REPLY/);
  });

  it('stops reading the account entirely when READ is revoked', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);
    await capabilities.setGrants(fixture.agentId, account.id, ['GENERATE', 'REPLY'], null);

    const outcome = await ingestNormalizedEvent({
      accountId: account.id,
      event: mockEvent('not even looked at'),
    });
    expect(outcome.jobs).toHaveLength(0);
    expect(outcome.skipped[0]?.reason).toMatch(/not permitted to read/);
  });

  it('leaves a manual trigger alone, since it carries no account link', async () => {
    const fixture = await createFixture();
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('run this by hand'),
    });
    expect(outcome.jobs).toHaveLength(1);
  });
});

describe('capabilities are enforced at execution, not only in the UI', () => {
  it('refuses permanently when a grant is revoked after the job is queued', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);

    const outcome = await ingestNormalizedEvent({
      accountId: account.id,
      event: mockEvent('this one gets revoked mid-flight'),
    });
    expect(outcome.jobs).toHaveLength(1);

    // The permission goes away while the job is already on the queue. Ingest has
    // been and gone; only the execution check can stop this.
    await capabilities.setGrants(fixture.agentId, account.id, ['READ', 'GENERATE'], null);

    await drainJobs();
    const job = await jobsRepo.requireJob(outcome.jobs[0]!.job.id);

    expect(job.status).toBe('PERMANENT_FAILURE');
    expect(job.lastError).toMatch(/not permitted to REPLY/i);
    // Permanent, because no amount of retrying restores a revoked permission.
    expect(await actionsRepo.listJobActions(job.id)).toHaveLength(0);
  });

  it('still executes when the grant is intact', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);
    const outcome = await ingestNormalizedEvent({
      accountId: account.id,
      event: mockEvent('this one is allowed through'),
    });

    await drainJobs();
    const job = await jobsRepo.requireJob(outcome.jobs[0]!.job.id);
    expect(job.status).toBe('EXECUTED');
  });
});
