import type { JobRecord } from '@xbam/shared/contracts';
import { jobs as jobsRepo } from '@xbam/database';
import { runJob } from '@xbam/runtime';

const WORKER = 'test-worker';

/**
 * Drives one agent's jobs, the way a worker does, but synchronously.
 *
 * Scoped by agent because `claimJobs` is global, as production wants it. A test
 * that drains the whole queue also drains every other test's work, and then
 * fails somewhere unrelated when that work refers to rows it never created.
 * Claiming is still contended -- several of these racing is the point -- but
 * each one only takes work it owns.
 */
export async function drainAgentJobs(agentId: string, maxRounds = 12): Promise<number> {
  let processed = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const claimed = (await jobsRepo.claimJobs(WORKER, 5, 60_000)).filter((j) => j.agentId === agentId);
    if (claimed.length === 0) break;
    for (const job of claimed) {
      await runJob(job, WORKER);
      processed += 1;
    }
  }
  return processed;
}

/**
 * Drives jobs the way the worker does, but synchronously, so a test can assert
 * on the settled state without racing a background loop.
 */
export async function drainJobs(maxRounds = 12): Promise<number> {
  let processed = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const claimed = await jobsRepo.claimJobs(WORKER, 5, 60_000);
    if (claimed.length === 0) break;
    for (const job of claimed) {
      await runJob(job, WORKER);
      processed += 1;
    }
  }
  return processed;
}

/** Runs one specific job to its next settled state. */
export async function runOne(jobId: string): Promise<JobRecord> {
  const job = await jobsRepo.requireJob(jobId);
  await runJob(job, WORKER);
  return jobsRepo.requireJob(jobId);
}

/** Makes a scheduled retry due immediately so backoff does not slow the suite. */
export async function makeDue(jobId: string): Promise<void> {
  await jobsRepo.updateJob(jobId, { runAt: new Date(Date.now() - 1000).toISOString() });
}
