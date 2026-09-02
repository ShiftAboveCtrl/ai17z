import { describe, expect, it } from 'vitest';
import { accounts as accountsRepo, jobs as jobsRepo } from '@xbam/database';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * A post nobody expects a reply to any more.
 *
 * The monitors scroll, and scrolling reaches last week. Connecting an account
 * exposes a notifications tab with a year of history in it. Adding a source, or
 * switching an agent on after a break, surfaces everything at once. Each of
 * those is a first sighting of an old post, and each one used to queue a job:
 * take the account, spend a model call, and delay the message that arrived a
 * minute ago in favour of one from a month ago.
 *
 * The event is still recorded. It shows in the inbox and a person can trigger it
 * deliberately. What it does not do is generate work on its own.
 */

async function linkedAccount(ownerId: string, agentId: string) {
  const account = await accountsRepo.createAccount({
    ownerId,
    channel: 'mock',
    handle: `fresh_${uniqueSuffix()}`,
  });
  await accountsRepo.updateAccount(account.id, { status: 'CONNECTED', enabled: true });
  await accountsRepo.linkAgentAccount({ agentId, accountId: account.id });
  return account;
}

const agesAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

describe('how old is too old', () => {
  it('answers something posted a minute ago', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);

    const outcome = await ingestNormalizedEvent({
      accountId: account.id,
      event: mockEvent('what do you make of this?', { occurredAt: agesAgo(60_000) }),
    });

    expect(outcome.jobs).toHaveLength(1);
  });

  it('records a day-old post without queueing anything', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);

    const outcome = await ingestNormalizedEvent({
      accountId: account.id,
      event: mockEvent('this was yesterday', { occurredAt: agesAgo(24 * 60 * 60_000) }),
    });

    expect(outcome.jobs).toHaveLength(0);
    expect(outcome.eventCreated).toBe(true);
    expect(outcome.skipped[0]!.reason).toMatch(/freshness/i);
  });

  it('says how old it was, so the decision can be checked', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);

    const outcome = await ingestNormalizedEvent({
      accountId: account.id,
      event: mockEvent('a month ago', { occurredAt: agesAgo(30 * 24 * 60 * 60_000) }),
    });

    expect(outcome.skipped[0]!.reason).toMatch(/\d+h ago/);
  });

  it('treats an unreadable timestamp as current rather than dropping it', async () => {
    // Refusing what cannot be measured would silently lose real mentions the
    // first time X changes its markup. Wrong in the safe direction.
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);

    const outcome = await ingestNormalizedEvent({
      accountId: account.id,
      event: mockEvent('no timestamp anywhere', { occurredAt: null }),
    });

    expect(outcome.jobs).toHaveLength(1);
  });

  it('is not fooled by a clock that disagrees', async () => {
    // A timestamp in the future is two machines disagreeing, not an old post.
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);

    const outcome = await ingestNormalizedEvent({
      accountId: account.id,
      event: mockEvent('from the future', { occurredAt: new Date(Date.now() + 600_000).toISOString() }),
    });

    expect(outcome.jobs).toHaveLength(1);
  });

  it('lets a person trigger an old one on purpose', async () => {
    // The gate is about what the agent does unprompted. Somebody deciding to
    // answer something old is a decision, and it is theirs.
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);

    const outcome = await ingestNormalizedEvent({
      accountId: account.id,
      event: mockEvent('old but wanted', { occurredAt: agesAgo(7 * 24 * 60 * 60_000) }),
      onlyAgentId: fixture.agentId,
    });

    expect(outcome.jobs).toHaveLength(1);
  });

  it('leaves the queue clear for what actually arrived', async () => {
    // The point of all of it: a backlog of history must not delay the message
    // somebody just sent.
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);

    for (let i = 0; i < 5; i += 1) {
      await ingestNormalizedEvent({
        accountId: account.id,
        event: mockEvent(`history ${i}`, { occurredAt: agesAgo((i + 3) * 60 * 60_000) }),
      });
    }
    const recent = await ingestNormalizedEvent({
      accountId: account.id,
      event: mockEvent('just now', { occurredAt: agesAgo(30_000) }),
    });

    const queued = await jobsRepo.listJobs({ agentId: fixture.agentId, limit: 50 });
    expect(queued.items).toHaveLength(1);
    expect(queued.items[0]!.id).toBe(recent.jobs[0]!.job.id);
  });
});
