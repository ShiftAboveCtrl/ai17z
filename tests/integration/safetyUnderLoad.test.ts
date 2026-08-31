import { describe, expect, it } from 'vitest';
import { accounts as accountsRepo, actions as actionsRepo, jobs as jobsRepo, query } from '@xbam/database';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { drainAgentJobs } from '../support/runner';

installHarness();

/**
 * The promises that stop an agent doing damage, tested while it is busy.
 *
 * Each of these is cheap to hold when one job runs at a time and easy to lose
 * when several do. They are also the failures that cost the most: the same
 * reply twice, or a reply sent through an account whose permission was taken
 * away while the job sat in the queue.
 */

const times = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('saying the same thing twice', () => {
  it('refuses a second identical action to the same target', async () => {
    const fixture = await createFixture();
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('A message worth a considered answer about governance and incentives today'),
    });
    const job = outcome.jobs[0]!.job;

    const base = {
      jobId: job.id,
      agentId: fixture.agentId,
      accountId: job.accountId!,
      channel: 'mock' as const,
      type: 'REPLY' as const,
      dryRun: false,
      payload: { text: 'the exact same sentence', targetRef: 'somewhere' },
      targetRef: 'somewhere',
    };

    const first = await actionsRepo.claimAction({ ...base, idempotencyKey: `sig-a-${job.id}` });
    expect(first.outcome).toBe('CLAIMED');
    if (first.outcome !== 'CLAIMED') return;
    await actionsRepo.completeAction(first.action.id, {
      status: 'EXECUTED',
      remoteActionId: 'remote-a',
      contentSignature: 'identical-signature',
    });

    // A different event, so a different idempotency key: nothing above this
    // layer stops it. The content signature is what does.
    expect(await actionsRepo.contentAlreadySent(fixture.agentId, 'identical-signature')).toBe(true);
    expect(await actionsRepo.contentAlreadySent(fixture.agentId, 'a-different-signature')).toBe(false);
  });

  it('keeps one agent signature from suppressing another agent reply', async () => {
    // Two agents may legitimately say the same thing. The signature is scoped
    // to the agent, and a shared one would silence whichever spoke second.
    const one = await createFixture();
    const two = await createFixture();
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: one.agentId,
      event: mockEvent('Another message worth a considered answer about fees and incentives'),
    });
    const job = outcome.jobs[0]!.job;

    const claim = await actionsRepo.claimAction({
      jobId: job.id,
      agentId: one.agentId,
      accountId: job.accountId!,
      channel: 'mock',
      type: 'REPLY',
      dryRun: false,
      idempotencyKey: `sig-b-${job.id}`,
      payload: { text: 'a shared sentence', targetRef: 'somewhere' },
      targetRef: 'somewhere',
    });
    if (claim.outcome !== 'CLAIMED') throw new Error('expected to claim');
    await actionsRepo.completeAction(claim.action.id, {
      status: 'EXECUTED',
      remoteActionId: 'remote-b',
      contentSignature: 'shared-signature',
    });

    expect(await actionsRepo.contentAlreadySent(one.agentId, 'shared-signature')).toBe(true);
    expect(await actionsRepo.contentAlreadySent(two.agentId, 'shared-signature')).toBe(false);
  });

  it('does not let a dry run claim the signature a real reply needs', async () => {
    // A dry run said nothing publicly, so it must not make the real reply look
    // like a repeat and silence it.
    const fixture = await createFixture();
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('A third message, also worth a considered answer about governance'),
    });
    const job = outcome.jobs[0]!.job;

    const claim = await actionsRepo.claimAction({
      jobId: job.id,
      agentId: fixture.agentId,
      accountId: job.accountId!,
      channel: 'mock',
      type: 'REPLY',
      dryRun: true,
      idempotencyKey: `sig-c-${job.id}`,
      payload: { text: 'rehearsed only', targetRef: 'somewhere' },
      targetRef: 'somewhere',
    });
    if (claim.outcome !== 'CLAIMED') throw new Error('expected to claim');
    await actionsRepo.completeAction(claim.action.id, {
      status: 'DRY_RUN',
      contentSignature: 'rehearsal-signature',
    });

    expect(await actionsRepo.contentAlreadySent(fixture.agentId, 'rehearsal-signature')).toBe(false);
  });
});

describe('a permission taken away while the job was queued', () => {
  it('stops the job permanently rather than retrying into a refusal', async () => {
    const fixture = await createFixture();

    // A real account with a real link, so the capability check has something to
    // read. Granting happens inside linkAgentAccount.
    const [owner] = await query<{ owner_id: string }>('SELECT owner_id FROM agents WHERE id = $1', [
      fixture.agentId,
    ]);
    const account = await accountsRepo.createAccount({
      ownerId: owner!.owner_id,
      channel: 'mock',
      handle: `revoked_${Date.now().toString(36)}`,
      displayName: 'Revocation test',
    });
    await accountsRepo.linkAgentAccount({
      agentId: fixture.agentId,
      accountId: account.id,
      triggerEventTypes: ['MENTION'],
      actionType: 'REPLY',
      enabled: true,
    });

    const outcome = await ingestNormalizedEvent({
      accountId: account.id,
      event: mockEvent('Something worth a real answer about token distribution and fees'),
    });
    const created = outcome.jobs[0];
    expect(created).toBeTruthy();
    if (!created) return;

    // Revoked after queueing, before running. This is the case the second check
    // exists for: the first one already let the work in.
    await query('DELETE FROM agent_account_capabilities WHERE agent_id = $1 AND account_id = $2', [
      fixture.agentId,
      account.id,
    ]);

    await drainAgentJobs(fixture.agentId);
    const job = await jobsRepo.requireJob(created.job.id);

    // Permanent, not retryable: retrying cannot restore a permission somebody
    // deliberately removed, and a job that keeps trying looks like a bug.
    expect(['PERMANENT_FAILURE', 'CANCELLED']).toContain(job.status);
    if (job.status === 'PERMANENT_FAILURE') expect(job.errorClass).toBe('PERMANENT');

    const [acts] = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM actions WHERE agent_id = $1 AND dry_run = false AND status = $2',
      [fixture.agentId, 'EXECUTED'],
    );
    expect(acts!.n).toBe(0);
  });

  it('refuses every one of a burst once the permission is gone', async () => {
    const fixture = await createFixture();
    const [owner] = await query<{ owner_id: string }>('SELECT owner_id FROM agents WHERE id = $1', [
      fixture.agentId,
    ]);
    const account = await accountsRepo.createAccount({
      ownerId: owner!.owner_id,
      channel: 'mock',
      handle: `burst_${Date.now().toString(36)}`,
      displayName: 'Revocation burst',
    });
    await accountsRepo.linkAgentAccount({
      agentId: fixture.agentId,
      accountId: account.id,
      triggerEventTypes: ['MENTION'],
      actionType: 'REPLY',
      enabled: true,
    });

    for (const i of times(8)) {
      await ingestNormalizedEvent({
        accountId: account.id,
        event: mockEvent(`Queued message ${i}, worth a considered answer about governance and fees`),
      });
    }
    await query('DELETE FROM agent_account_capabilities WHERE agent_id = $1 AND account_id = $2', [
      fixture.agentId,
      account.id,
    ]);

    await Promise.allSettled(times(3).map(() => drainAgentJobs(fixture.agentId, 20)));

    const [acts] = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM actions WHERE agent_id = $1 AND dry_run = false AND status = $2',
      [fixture.agentId, 'EXECUTED'],
    );
    // Not one of the eight gets through, however many workers are pushing.
    expect(acts!.n).toBe(0);
  });
});
