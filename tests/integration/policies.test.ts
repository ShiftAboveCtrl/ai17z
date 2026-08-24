import { describe, expect, it } from 'vitest';
import { actions, jobs as jobsRepo, query } from '@xbam/database';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { drainJobs } from '../support/runner';

installHarness();

describe('policy gates', () => {
  it('refuses to act on a blocked handle, permanently', async () => {
    const fixture = await createFixture({ policy: { content: { blockedRemoteHandles: ['alice'] } } as never });
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('Hello from a blocked account'),
    });
    await drainJobs();

    const job = await jobsRepo.requireJob(outcome.jobs[0]!.job.id);
    expect(job.status).toBe('PERMANENT_FAILURE');
    expect(job.lastError).toContain('blocked list');
    expect(await actions.listJobActions(job.id)).toHaveLength(0);
  });

  it('refuses to reply to itself', async () => {
    const fixture = await createFixture({ policy: { content: { selfHandles: ['alice'] } } as never });
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('This is my own post'),
    });
    await drainJobs();

    const job = await jobsRepo.requireJob(outcome.jobs[0]!.job.id);
    expect(job.status).toBe('PERMANENT_FAILURE');
    expect(job.lastError).toMatch(/self-conversation/i);
  });

  it('acts only for allowlisted handles when an allowlist is configured', async () => {
    const fixture = await createFixture({ policy: { content: { allowedRemoteHandles: ['carol'] } } as never });
    const blocked = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('From alice'),
    });
    const allowed = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('From carol', { remoteAuthorHandle: 'carol' }),
    });
    await drainJobs();

    expect((await jobsRepo.requireJob(blocked.jobs[0]!.job.id)).status).toBe('PERMANENT_FAILURE');
    expect((await jobsRepo.requireJob(allowed.jobs[0]!.job.id)).status).toBe('EXECUTED');
  });

  it('holds a job when the hourly action limit is already spent', async () => {
    const fixture = await createFixture({
      policy: { rate: { maxActionsPerHour: 1, maxActionsPerDay: 0, minSecondsBetweenActions: 0 } } as never,
    });

    const first = await ingestNormalizedEvent({ accountId: null, onlyAgentId: fixture.agentId, event: mockEvent('one') });
    await drainJobs();
    expect((await jobsRepo.requireJob(first.jobs[0]!.job.id)).status).toBe('EXECUTED');

    const second = await ingestNormalizedEvent({ accountId: null, onlyAgentId: fixture.agentId, event: mockEvent('two') });
    await drainJobs();

    const job = await jobsRepo.requireJob(second.jobs[0]!.job.id);
    // Rate limits delay, they never discard.
    expect(job.status).toBe('VALIDATED');
    expect(job.errorClass).toBe('RETRYABLE');
    expect(job.lastError).toMatch(/hourly action limit/i);
    expect(new Date(job.runAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('creates no job at all for a paused agent', async () => {
    const fixture = await createFixture();
    await query(`UPDATE agents SET state = 'PAUSED' WHERE id = $1`, [fixture.agentId]);

    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('Nobody is listening'),
    });
    // The event is still recorded; only the work is withheld.
    expect(outcome.eventCreated).toBe(true);
    expect(outcome.jobs).toHaveLength(0);
    expect(outcome.skipped[0]?.reason).toBe('agent is PAUSED');
  });

  it('pins the policy version a job started under', async () => {
    const fixture = await createFixture();
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('Pinned configuration'),
    });
    const job = await jobsRepo.requireJob(outcome.jobs[0]!.job.id);
    expect(job.policyVersionId).toBeTruthy();
    expect(job.personaVersionId).toBeTruthy();
    expect(job.promptTemplateVersionId).toBeTruthy();
  });
});
