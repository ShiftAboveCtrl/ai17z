import type { JobRecord, JobStatus } from '@xbam/shared/contracts';
import { PipelineError, createLogger, errorMessage } from '@xbam/shared';
import { jobs as jobsRepo, observability } from '@xbam/database';
import { failPermanently, scheduleRetry, sendToReview } from '@xbam/jobs';
import { loadJobBundle } from './loadJob';
import { stepGenerate, stepResolveContext, stepRetrieveMemory, stepValidate, stepExecute } from './steps';

const log = createLogger('pipeline');

interface StepSpec {
  name: string;
  inFlight: JobStatus;
  run: (bundle: Awaited<ReturnType<typeof loadJobBundle>>) => Promise<void>;
}

/** The default pipeline, expressed as the transition each settled state takes. */
const STEPS: Partial<Record<JobStatus, StepSpec>> = {
  RECEIVED: { name: 'resolve_context', inFlight: 'CONTEXT_RESOLVING', run: stepResolveContext },
  CONTEXT_RESOLVED: { name: 'retrieve_memory', inFlight: 'MEMORY_RETRIEVING', run: stepRetrieveMemory },
  MEMORY_RESOLVED: { name: 'generate', inFlight: 'GENERATING', run: stepGenerate },
  GENERATED: { name: 'validate', inFlight: 'VALIDATING', run: stepValidate },
  VALIDATED: { name: 'execute', inFlight: 'EXECUTING', run: stepExecute },
};

/**
 * A job that somehow settled on RETRYABLE_FAILURE is resumed from the furthest
 * point its own data proves it reached, rather than from the beginning.
 */
function deriveResumeStatus(job: JobRecord): JobStatus {
  if (job.validatedOutput) return 'VALIDATED';
  if (job.generatedOutput) return 'GENERATED';
  if (job.memoryResolvedAt) return 'MEMORY_RESOLVED';
  if (job.resolvedContext) return 'CONTEXT_RESOLVED';
  return 'RECEIVED';
}

function stepFor(job: JobRecord): { status: JobStatus; spec: StepSpec } | null {
  const status = job.status === 'RETRYABLE_FAILURE' ? deriveResumeStatus(job) : job.status;
  const spec = STEPS[status];
  return spec ? { status, spec } : null;
}

/** Steps beyond which no further work happens without an external decision. */
const HALTS: readonly JobStatus[] = [
  'WAITING_FOR_APPROVAL',
  'REVIEW_REQUIRED',
  'EXECUTED',
  'DRY_RUN_COMPLETED',
  'PERMANENT_FAILURE',
  'CANCELLED',
];

const MAX_STEPS_PER_CLAIM = 8;

/**
 * Advances a claimed job as far as it will go.
 *
 * Every step commits its own settled state before the next one starts, so a
 * crash anywhere resumes from the last completed step rather than restarting the
 * job or losing it. This is the property the AI4CZ JSON queues could not offer.
 */
export async function runJob(job: JobRecord, workerId: string): Promise<void> {
  let current = job;
  await observability.emitTrace({
    jobId: current.id,
    agentId: current.agentId,
    type: 'JOB_CLAIMED',
    level: 'debug',
    message: `Claimed at ${current.status}`,
    data: { workerId, attempt: current.attemptCount },
  });

  for (let iteration = 0; iteration < MAX_STEPS_PER_CLAIM; iteration += 1) {
    if (HALTS.includes(current.status)) return;
    const next = stepFor(current);
    if (!next) {
      log.warn('job has no step for its status', { jobId: current.id, status: current.status });
      await jobsRepo.releaseLease(current.id);
      return;
    }

    const attempt = current.attemptCount + 1;
    let bundle: Awaited<ReturnType<typeof loadJobBundle>>;
    try {
      bundle = await loadJobBundle(current);
    } catch (error) {
      await handleFailure(current, next.spec.name, attempt, error, next.status);
      return;
    }

    await jobsRepo.updateJob(current.id, { status: next.spec.inFlight });

    try {
      await next.spec.run({ ...bundle, job: { ...current, status: next.spec.inFlight } });
      await jobsRepo.recordAttempt({
        jobId: current.id,
        attempt,
        step: next.spec.name,
        workerId,
        outcome: 'OK',
      });
    } catch (error) {
      await handleFailure(current, next.spec.name, attempt, error, next.status);
      return;
    }

    const refreshed = await jobsRepo.getJob(current.id);
    if (!refreshed) return;
    if (refreshed.status === next.spec.inFlight) {
      // The step returned without settling the job, which would spin the loop.
      log.error('step did not settle the job status', { jobId: current.id, step: next.spec.name });
      await jobsRepo.updateJob(current.id, {
        status: 'REVIEW_REQUIRED',
        errorClass: 'REVIEW_REQUIRED',
        lastError: `Internal: step ${next.spec.name} finished without changing job status.`,
        releaseLock: true,
      });
      return;
    }
    current = refreshed;
  }

  // Ran out of iterations. Release the lease so the next poll continues cleanly.
  await jobsRepo.releaseLease(current.id);
}

async function handleFailure(
  job: JobRecord,
  step: string,
  attempt: number,
  error: unknown,
  resumeStatus: JobStatus,
): Promise<void> {
  const pipelineError =
    error instanceof PipelineError
      ? error
      : PipelineError.retryable('unclassified', errorMessage(error), {}, error);

  await jobsRepo.recordAttempt({
    jobId: job.id,
    attempt,
    step,
    workerId: job.lockedBy,
    outcome: pipelineError.errorClass === 'RETRYABLE' ? 'RETRYABLE' : pipelineError.errorClass,
    errorClass: pipelineError.reason,
    error: pipelineError.message,
  });

  if (pipelineError.errorClass === 'PERMANENT') {
    await failPermanently(job, pipelineError.reason, pipelineError.message);
    return;
  }
  if (pipelineError.errorClass === 'REVIEW_REQUIRED') {
    await sendToReview(job, pipelineError.reason, pipelineError.message);
    return;
  }
  if (attempt >= job.maxAttempts) {
    // Retries are exhausted. A person decides, rather than the job vanishing.
    await sendToReview(
      { ...job, attemptCount: attempt },
      pipelineError.reason,
      `${pipelineError.message} (gave up after ${attempt} attempts)`,
    );
    return;
  }
  await scheduleRetry({ ...job, attemptCount: attempt - 1 }, resumeStatus, pipelineError.message);
}
