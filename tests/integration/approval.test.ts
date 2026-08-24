import { describe, expect, it } from 'vitest';
import { actions, jobs as jobsRepo, observability } from '@xbam/database';
import { approveJob, ingestNormalizedEvent, rejectJob } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { drainJobs } from '../support/runner';

installHarness();

const reviewPolicy = { automation: { mode: 'REVIEW_BEFORE_ACTION' as const, dryRunDefault: false } };

describe('human approval', () => {
  it('holds a job before acting and executes the edited text once approved', async () => {
    const fixture = await createFixture({ policy: reviewPolicy });
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('Needs a person to look at this'),
    });
    const jobId = outcome.jobs[0]!.job.id;

    await drainJobs();
    let job = await jobsRepo.requireJob(jobId);
    expect(job.status).toBe('WAITING_FOR_APPROVAL');
    expect(job.validatedOutput).toBeTruthy();
    // Nothing has been sent.
    expect(await actions.listJobActions(jobId)).toHaveLength(0);

    const approval = await actions.getApproval(jobId);
    expect(approval?.status).toBe('PENDING');

    await approveJob({ jobId, decidedBy: null, editedOutput: 'A human wrote this instead.' });
    job = await jobsRepo.requireJob(jobId);
    expect(job.status).toBe('VALIDATED');
    expect(job.validatedOutput).toBe('A human wrote this instead.');
    expect(job.approvedAt).toBeTruthy();

    await drainJobs();
    job = await jobsRepo.requireJob(jobId);
    expect(job.status).toBe('EXECUTED');

    const performed = await actions.listJobActions(jobId);
    expect(performed).toHaveLength(1);
    expect((performed[0]?.payload as { text?: string }).text).toBe('A human wrote this instead.');

    const trace = (await observability.listTrace(jobId)).map((t) => t.type);
    expect(trace).toContain('APPROVAL_REQUESTED');
    expect(trace).toContain('APPROVAL_DECIDED');
  });

  it('cancels the job when a person rejects it, and sends nothing', async () => {
    const fixture = await createFixture({ policy: reviewPolicy });
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('This one should not go out'),
    });
    const jobId = outcome.jobs[0]!.job.id;
    await drainJobs();

    await rejectJob({ jobId, decidedBy: null, note: 'Off tone.' });
    const job = await jobsRepo.requireJob(jobId);
    expect(job.status).toBe('CANCELLED');
    expect(await actions.listJobActions(jobId)).toHaveLength(0);

    // A cancelled job is never picked back up by a worker.
    await drainJobs();
    expect((await jobsRepo.requireJob(jobId)).status).toBe('CANCELLED');
  });

  it('refuses to approve text that the policy rejects outright', async () => {
    const fixture = await createFixture({
      policy: { ...reviewPolicy, output: { bannedPhrases: ['financial advice'] } } as never,
    });
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('Give me a view'),
    });
    const jobId = outcome.jobs[0]!.job.id;
    await drainJobs();

    await expect(
      approveJob({ jobId, decidedBy: null, editedOutput: 'This is financial advice.' }),
    ).rejects.toThrow(/cannot be approved/i);

    expect((await jobsRepo.requireJob(jobId)).status).toBe('WAITING_FOR_APPROVAL');
  });

  it('skips the approval gate entirely for a dry run, since nothing is sent', async () => {
    const fixture = await createFixture({ policy: reviewPolicy });
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      dryRun: true,
      event: mockEvent('Dry running through review mode'),
    });
    await drainJobs();

    const job = await jobsRepo.requireJob(outcome.jobs[0]!.job.id);
    expect(job.status).toBe('DRY_RUN_COMPLETED');
  });
});

describe('dry run', () => {
  it('verifies the target and stops before performing the action', async () => {
    const fixture = await createFixture({ policy: { automation: { mode: 'AUTONOMOUS', dryRunDefault: true } } as never });
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('What would you say to this?'),
    });
    const jobId = outcome.jobs[0]!.job.id;
    await drainJobs();

    const job = await jobsRepo.requireJob(jobId);
    expect(job.status).toBe('DRY_RUN_COMPLETED');
    expect(job.validatedOutput).toBeTruthy();

    const performed = await actions.listJobActions(jobId);
    expect(performed).toHaveLength(1);
    expect(performed[0]?.status).toBe('DRY_RUN');
    expect(performed[0]?.remoteActionId).toBeNull();
    // The target was still verified, which is the point of a dry run.
    expect((performed[0]?.verification as { verified?: boolean })?.verified).toBe(true);

    const trace = (await observability.listTrace(jobId)).map((t) => t.type);
    expect(trace).toContain('TARGET_VERIFIED');
    expect(trace).toContain('DRY_RUN_STOPPED');
    expect(trace).not.toContain('ACTION_COMPLETED');
  });
});
