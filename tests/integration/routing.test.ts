import { describe, expect, it } from 'vitest';
import { accountLease, accounts as accountsRepo, jobs as jobsRepo } from '@xbam/database';
import { capabilitiesFor } from '@xbam/jobs';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

describe('worker capability routing', () => {
  it('maps roles to what each worker may claim', () => {
    expect(capabilitiesFor('all')).toEqual({ browserCapable: true, jobsCapable: true });
    expect(capabilitiesFor('jobs')).toEqual({ browserCapable: false, jobsCapable: true });
    expect(capabilitiesFor('browser')).toEqual({ browserCapable: true, jobsCapable: false });
  });

  it('marks a mock-channel job as needing no browser', async () => {
    const fixture = await createFixture();
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('no browser needed'),
    });
    expect(outcome.jobs[0]?.job.requiresBrowser).toBe(false);
  });

  it('lets a jobs-only worker claim non-browser work', async () => {
    const fixture = await createFixture();
    await ingestNormalizedEvent({ accountId: null, onlyAgentId: fixture.agentId, event: mockEvent('claim me') });

    const claimed = await jobsRepo.claimJobs('jobs-worker', 5, 60_000, capabilitiesFor('jobs'));
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.requiresBrowser).toBe(false);
  });

  it('stops a browser-only worker taking work it cannot serve', async () => {
    const fixture = await createFixture();
    await ingestNormalizedEvent({ accountId: null, onlyAgentId: fixture.agentId, event: mockEvent('not yours') });

    // The mock job needs no browser, so a browser-only worker must leave it.
    expect(await jobsRepo.claimJobs('browser-worker', 5, 60_000, capabilitiesFor('browser'))).toHaveLength(0);
    expect(await jobsRepo.claimJobs('jobs-worker', 5, 60_000, capabilitiesFor('jobs'))).toHaveLength(1);
  });
});

describe('account leases', () => {
  async function account(ownerId: string) {
    return accountsRepo.createAccount({ ownerId, channel: 'x', handle: `acct-${Date.now()}` });
  }

  it('grants the account to one worker at a time', async () => {
    const fixture = await createFixture();
    const acct = await account(fixture.ownerId);

    const first = await accountLease.acquireAccountLease({
      accountId: acct.id, workerId: 'w1', reason: 'posting', ttlMs: 60_000,
    });
    expect(first).not.toBeNull();

    const second = await accountLease.acquireAccountLease({
      accountId: acct.id, workerId: 'w2', reason: 'polling', ttlMs: 60_000,
    });
    expect(second).toBeNull();

    // The holder can say who has it, so the UI can explain the wait.
    expect((await accountLease.currentAccountLease(acct.id))?.reason).toBe('posting');
  });

  it('is reentrant for the worker already holding it', async () => {
    const fixture = await createFixture();
    const acct = await account(fixture.ownerId);
    await accountLease.acquireAccountLease({ accountId: acct.id, workerId: 'w1', reason: 'a', ttlMs: 60_000 });
    expect(
      await accountLease.acquireAccountLease({ accountId: acct.id, workerId: 'w1', reason: 'b', ttlMs: 60_000 }),
    ).not.toBeNull();
  });

  it('frees the account when the holder releases it', async () => {
    const fixture = await createFixture();
    const acct = await account(fixture.ownerId);
    await accountLease.acquireAccountLease({ accountId: acct.id, workerId: 'w1', reason: 'x', ttlMs: 60_000 });
    await accountLease.releaseAccountLease(acct.id, 'w1');
    expect(await accountLease.currentAccountLease(acct.id)).toBeNull();
    expect(
      await accountLease.acquireAccountLease({ accountId: acct.id, workerId: 'w2', reason: 'y', ttlMs: 60_000 }),
    ).not.toBeNull();
  });

  it('expires rather than blocking the account forever when a worker dies', async () => {
    const fixture = await createFixture();
    const acct = await account(fixture.ownerId);
    // A lease that has already elapsed stands in for a worker that vanished.
    await accountLease.acquireAccountLease({ accountId: acct.id, workerId: 'dead', reason: 'gone', ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 30));
    expect(await accountLease.currentAccountLease(acct.id)).toBeNull();
    expect(
      await accountLease.acquireAccountLease({ accountId: acct.id, workerId: 'w2', reason: 'ok', ttlMs: 60_000 }),
    ).not.toBeNull();
  });

  it('runs the body only when the account was free, and releases afterwards', async () => {
    const fixture = await createFixture();
    const acct = await account(fixture.ownerId);
    let ran = 0;

    const held = await accountLease.withAccountLease(
      { accountId: acct.id, workerId: 'w1', reason: 'work', ttlMs: 60_000 },
      async () => { ran += 1; return 'done'; },
    );
    expect(held.held && held.value).toBe('done');
    expect(ran).toBe(1);
    expect(await accountLease.currentAccountLease(acct.id)).toBeNull();

    await accountLease.acquireAccountLease({ accountId: acct.id, workerId: 'other', reason: 'busy', ttlMs: 60_000 });
    const blocked = await accountLease.withAccountLease(
      { accountId: acct.id, workerId: 'w1', reason: 'work', ttlMs: 60_000 },
      async () => { ran += 1; return 'done'; },
    );
    expect(blocked.held).toBe(false);
    expect(ran).toBe(1);
  });
});
