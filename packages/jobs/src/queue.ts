import type { JobRecord } from '@xbam/shared/contracts';
import { backoffMs, createLogger } from '@xbam/shared';
import { jobs as jobsRepo, observability } from '@xbam/database';

const log = createLogger('queue');

/**
 * What a worker is able to do.
 *
 * `jobs` runs the pipeline for channels that need no browser and is safe in a
 * container. `browser` runs browser-backed channels and browser tasks, and must
 * run where a browser actually exists. `all` is the single-process default.
 */
export type WorkerRole = 'jobs' | 'browser' | 'all';

export interface QueueOptions {
  workerId: string;
  concurrency: number;
  pollIntervalMs: number;
  leaseMs: number;
  role: WorkerRole;
}

export function capabilitiesFor(role: WorkerRole): { browserCapable: boolean; jobsCapable: boolean } {
  return {
    browserCapable: role === 'browser' || role === 'all',
    jobsCapable: role === 'jobs' || role === 'all',
  };
}

/** Schedules a retry with jittered exponential backoff and records why. */
export async function scheduleRetry(job: JobRecord, resumeStatus: JobRecord['status'], reason: string): Promise<void> {
  const attempt = job.attemptCount + 1;
  const delay = backoffMs(attempt);
  const runAt = new Date(Date.now() + delay).toISOString();
  await jobsRepo.updateJob(job.id, {
    status: resumeStatus,
    attemptCount: attempt,
    runAt,
    errorClass: 'RETRYABLE',
    lastError: reason,
    releaseLock: true,
  });
  await observability.emitTrace({
    jobId: job.id,
    agentId: job.agentId,
    type: 'JOB_RETRY_SCHEDULED',
    level: 'warn',
    message: `Retry ${attempt}/${job.maxAttempts} in ${Math.round(delay / 1000)}s`,
    data: { reason, runAt, attempt },
  });
}

export async function failPermanently(job: JobRecord, reason: string, message: string): Promise<void> {
  await jobsRepo.updateJob(job.id, {
    status: 'PERMANENT_FAILURE',
    errorClass: 'PERMANENT',
    lastError: message,
    releaseLock: true,
  });
  await observability.emitTrace({
    jobId: job.id,
    agentId: job.agentId,
    type: 'JOB_FAILED_PERMANENT',
    level: 'error',
    message,
    data: { reason },
  });
}

export async function sendToReview(job: JobRecord, reason: string, message: string): Promise<void> {
  await jobsRepo.updateJob(job.id, {
    status: 'REVIEW_REQUIRED',
    errorClass: 'REVIEW_REQUIRED',
    lastError: message,
    releaseLock: true,
  });
  await observability.emitTrace({
    jobId: job.id,
    agentId: job.agentId,
    type: 'VALIDATION_FAILED',
    level: 'warn',
    message,
    data: { reason },
  });
}

/**
 * Returns any job whose worker died mid-step to the state before that step, then
 * reports what it recovered. Run at worker startup and periodically afterwards.
 */
export async function runRecoverySweep(): Promise<number> {
  const recovered = await jobsRepo.recoverExpiredLeases();
  for (const job of recovered) {
    await observability.emitTrace({
      jobId: job.id,
      agentId: job.agentId,
      type: 'JOB_RECOVERED',
      level: 'warn',
      message: `Lease expired; resumed at ${job.status}`,
      data: { status: job.status },
    });
  }
  if (recovered.length > 0) log.warn('recovered jobs from expired leases', { count: recovered.length });
  return recovered.length;
}
