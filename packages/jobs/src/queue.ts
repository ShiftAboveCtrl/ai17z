import type { JobRecord } from '@xbam/shared/contracts';
import { backoffMs, createLogger } from '@xbam/shared';
import { actions as actionsRepo, jobs as jobsRepo, observability } from '@xbam/database';

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

/**
 * Waits for work that is still going, without spending an attempt on it.
 *
 * `claimAction` refuses a job whose action is already EXECUTING, which is
 * correct -- retrying past it is how a reply goes out twice. But the refusal was
 * being counted as a failed attempt, and the backoff spends all five in about
 * thirty seconds while an action stays un-retakeable for ten minutes. So any
 * browser action that outlived its job lease was guaranteed to reach review
 * having never actually been retried.
 *
 * Nothing was attempted here, so nothing is charged. The delay is a flat minute
 * rather than a backoff, because the thing being waited for is another worker
 * finishing, not a fault that might clear.
 */
export async function waitForInFlight(job: JobRecord, resumeStatus: JobRecord['status'], reason: string): Promise<void> {
  const runAt = new Date(Date.now() + 60_000).toISOString();
  await jobsRepo.updateJob(job.id, {
    status: resumeStatus,
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
    message: 'Waiting for the action already in flight to finish; this does not count as an attempt.',
    data: { reason, runAt, attempt: job.attemptCount },
  });
}

/**
 * Waits out a limit that has not been reached yet, without spending an attempt.
 *
 * A rate ceiling, a cooldown, quiet hours: none of these are failures. Nothing
 * was attempted and nothing went wrong -- the agent is simply not allowed to
 * act yet, and it knows exactly how long for, because the gate returns the
 * number.
 *
 * Treating them as failures was catastrophic in the small. A reply blocked by a
 * thirty-second cooldown was retried on the ordinary backoff -- 1s, 2s, 7s, 8s
 * -- so all five attempts were spent in eighteen seconds, every one of them
 * inside the same cooldown window, and the job went to review saying "Cooling
 * down between actions (1s remaining). (gave up after 5 attempts)". One second
 * of patience would have sent it. The reply was written, validated and scored,
 * and then quietly never went out.
 *
 * A minute of slack on top, because the ceiling is computed from a clock that
 * has already moved by the time the job is claimed again.
 */
export async function waitForLimit(
  job: JobRecord,
  resumeStatus: JobRecord['status'],
  reason: string,
  retryAfterMs: number,
): Promise<void> {
  const delay = Math.max(1_000, Math.min(retryAfterMs + 1_000, 6 * 60 * 60_000));
  const runAt = new Date(Date.now() + delay).toISOString();
  await jobsRepo.updateJob(job.id, {
    status: resumeStatus,
    runAt,
    errorClass: 'RETRYABLE',
    lastError: reason,
    releaseLock: true,
  });
  await observability.emitTrace({
    jobId: job.id,
    agentId: job.agentId,
    type: 'JOB_RETRY_SCHEDULED',
    level: 'info',
    message: `Waiting ${describeWait(delay)} for a limit to clear; this does not count as an attempt.`,
    data: { reason, runAt, attempt: job.attemptCount, retryAfterMs },
  });
}

function describeWait(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
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
  // Nothing is executing once the job has stopped, and a row that says
  // otherwise blocks the next claim on that key and misleads whoever reads it.
  await actionsRepo.failInFlightForJob(job.id, message);
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
  await actionsRepo.failInFlightForJob(job.id, message);
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
