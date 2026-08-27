import { describe, expect, it } from 'vitest';
import { jobs as jobsRepo, observability, query } from '@xbam/database';
import { runRecoverySweep } from '@xbam/jobs';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { drainJobs } from '../support/runner';

installHarness();

async function newJob(agentId: string, text = 'queue test') {
  const outcome = await ingestNormalizedEvent({ accountId: null, onlyAgentId: agentId, event: mockEvent(text) });
  return outcome.jobs[0]!.job.id;
}

/** Expires a lease without waiting for wall-clock time to pass. */
async function expireLease(jobId: string): Promise<void> {
  await query(`UPDATE jobs SET lock_expires_at = now() - interval '1 minute' WHERE id = $1`, [jobId]);
}

describe('the durable queue', () => {
  it('never hands the same job to two workers', async () => {
    const fixture = await createFixture();
    await newJob(fixture.agentId, 'one');
    await newJob(fixture.agentId, 'two');

    const [a, b] = await Promise.all([
      jobsRepo.claimJobs('worker-a', 5, 60_000),
      jobsRepo.claimJobs('worker-b', 5, 60_000),
    ]);
    const ids = [...a.map((j) => j.id), ...b.map((j) => j.id)];
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('does not claim a job whose retry is not due yet', async () => {
    const fixture = await createFixture();
    const jobId = await newJob(fixture.agentId);
    await jobsRepo.updateJob(jobId, { runAt: new Date(Date.now() + 60_000).toISOString() });

    expect(await jobsRepo.claimJobs('worker', 5, 60_000)).toHaveLength(0);

    await jobsRepo.updateJob(jobId, { runAt: new Date(Date.now() - 1000).toISOString() });
    expect(await jobsRepo.claimJobs('worker', 5, 60_000)).toHaveLength(1);
  });

  it('returns an abandoned in-flight job to the step before it, not to the start', async () => {
    const fixture = await createFixture();
    const jobId = await newJob(fixture.agentId);

    // Advance to a mid-pipeline state, then simulate the worker dying there.
    await jobsRepo.claimJobs('doomed-worker', 1, 60_000);
    await jobsRepo.updateJob(jobId, { status: 'GENERATING' });
    await expireLease(jobId);

    const recovered = await runRecoverySweep();
    expect(recovered).toBe(1);

    const job = await jobsRepo.requireJob(jobId);
    expect(job.status).toBe('MEMORY_RESOLVED');
    expect(job.lockedBy).toBeNull();

    const trace = (await observability.listTrace(jobId)).map((t) => t.type);
    expect(trace).toContain('JOB_RECOVERED');
  });

  it('leaves a healthy lease alone', async () => {
    const fixture = await createFixture();
    const jobId = await newJob(fixture.agentId);
    await jobsRepo.claimJobs('busy-worker', 1, 60_000);
    await jobsRepo.updateJob(jobId, { status: 'GENERATING' });

    expect(await runRecoverySweep()).toBe(0);
    expect((await jobsRepo.requireJob(jobId)).status).toBe('GENERATING');
  });

  it('finishes a recovered job correctly when a worker picks it up again', async () => {
    const fixture = await createFixture();
    const jobId = await newJob(fixture.agentId, 'recover me');

    await jobsRepo.claimJobs('doomed-worker', 1, 60_000);
    await jobsRepo.updateJob(jobId, { status: 'CONTEXT_RESOLVING' });
    await expireLease(jobId);
    await runRecoverySweep();

    await drainJobs();
    const job = await jobsRepo.requireJob(jobId);
    expect(job.status).toBe('EXECUTED');
    expect(job.validatedOutput).toBeTruthy();
  });

  it('records every step attempt so a failure history survives', async () => {
    const fixture = await createFixture();
    const jobId = await newJob(fixture.agentId);
    await drainJobs();

    // Steps are named after the graph node that ran, so the history reads as
    // the path the job actually took through the pipeline.
    const attempts = await jobsRepo.listJobAttempts(jobId);
    const path = attempts.map((a) => a.step.split(':')[0]);
    expect(path).toEqual([
      'trigger',
      'filter',
      'context',
      'media',
      'relationship',
      'memory',
      'persona',
      'generate',
      'validate',
      'approval',
      'execute',
      'remember',
      'done',
    ]);
    expect(attempts.every((a) => a.outcome === 'OK')).toBe(true);
  });
});
