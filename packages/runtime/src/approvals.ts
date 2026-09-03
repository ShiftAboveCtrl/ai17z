import { ConflictError, NotFoundError } from '@xbam/shared';
import { actions as actionsRepo, agents as agentsRepo, jobs as jobsRepo, observability } from '@xbam/database';
import { PolicyConfig } from '@xbam/shared/contracts';
import { validateOutput } from './validator';

export interface ApprovalDecisionInput {
  jobId: string;
  decidedBy: string | null;
  editedOutput?: string;
  note?: string;
}

/**
 * Approves a job and puts it back in the queue.
 *
 * An edited message is still checked against the policy, but only hard rejections
 * block it: a person who edits and approves has made a judgement the platform
 * should respect, short of letting through something the policy forbids outright.
 */
export async function approveJob(input: ApprovalDecisionInput): Promise<void> {
  const job = await jobsRepo.requireJob(input.jobId);
  if (job.status !== 'WAITING_FOR_APPROVAL' && job.status !== 'REVIEW_REQUIRED') {
    throw new ConflictError(`Job is ${job.status}, so there is nothing to approve.`);
  }

  const policyRow = job.policyVersionId
    ? await agentsRepo.getPolicyVersion(job.policyVersionId)
    : await agentsRepo.getActivePolicy(job.agentId);
  const policy = PolicyConfig.parse(policyRow?.config ?? {});

  const proposed = (input.editedOutput ?? job.validatedOutput ?? job.generatedOutput ?? '').trim();
  if (!proposed) throw new ConflictError('There is no message text to approve.');

  // The same persona the job was generated against, for the same reason the
  // pipeline passes it: an address the operator wrote into the agent is one the
  // agent was given, and a person approving a reply that quotes it should not
  // be told the agent may not say its own address.
  const persona = job.personaVersionId ? await agentsRepo.getPersonaVersion(job.personaVersionId) : null;
  const operatorText = [persona?.biography, persona?.customInstructions].filter(Boolean).join('\n');

  const validation = validateOutput(proposed, policy, null, operatorText);
  const hardFailure = validation.violations.find((v) => v.severity === 'REJECT');
  if (hardFailure) {
    throw new ConflictError(`This message cannot be approved: ${hardFailure.message}`, {
      violations: validation.violations,
    });
  }

  try {
    await actionsRepo.decideApproval({
      jobId: job.id,
      status: 'APPROVED',
      editedOutput: input.editedOutput ?? null,
      note: input.note ?? null,
      decidedBy: input.decidedBy,
    });
  } catch (error) {
    // REVIEW_REQUIRED jobs have no approval row yet; create one so the decision
    // is still on the record rather than being lost.
    if (!(error instanceof NotFoundError)) throw error;
    await actionsRepo.createApproval(job.id, job.generatedOutput ?? proposed);
    await actionsRepo.decideApproval({
      jobId: job.id,
      status: 'APPROVED',
      editedOutput: input.editedOutput ?? null,
      note: input.note ?? null,
      decidedBy: input.decidedBy,
    });
  }

  await jobsRepo.updateJob(job.id, {
    status: 'VALIDATED',
    validatedOutput: validation.output,
    errorClass: null,
    lastError: null,
    // An approved job is due now by the clock the claim actually uses.
    runNow: true,
    releaseLock: true,
    touch: ['approvedAt', 'validatedAt'],
  });

  await observability.emitTrace({
    jobId: job.id,
    agentId: job.agentId,
    type: 'APPROVAL_DECIDED',
    message: input.editedOutput ? 'Approved with edits.' : 'Approved.',
    data: { edited: Boolean(input.editedOutput), note: input.note ?? null },
  });
}

export async function rejectJob(input: ApprovalDecisionInput): Promise<void> {
  const job = await jobsRepo.requireJob(input.jobId);
  if (job.status !== 'WAITING_FOR_APPROVAL' && job.status !== 'REVIEW_REQUIRED') {
    throw new ConflictError(`Job is ${job.status}, so there is nothing to reject.`);
  }
  await actionsRepo
    .decideApproval({
      jobId: job.id,
      status: 'REJECTED',
      note: input.note ?? null,
      decidedBy: input.decidedBy,
      editedOutput: null,
    })
    .catch(() => undefined);
  await jobsRepo.updateJob(job.id, {
    status: 'CANCELLED',
    lastError: input.note ?? 'Rejected by the operator.',
    releaseLock: true,
  });
  await observability.emitTrace({
    jobId: job.id,
    agentId: job.agentId,
    type: 'JOB_CANCELLED',
    level: 'warn',
    message: 'Rejected by the operator.',
    data: { note: input.note ?? null },
  });
}

/** Puts a failed or review-required job back in the queue from its last good step. */
export async function retryJob(jobId: string): Promise<void> {
  const job = await jobsRepo.requireJob(jobId);
  const retryable = ['REVIEW_REQUIRED', 'PERMANENT_FAILURE', 'RETRYABLE_FAILURE', 'CANCELLED'];
  if (!retryable.includes(job.status)) {
    throw new ConflictError(`Job is ${job.status} and is not in a retryable state.`);
  }
  await jobsRepo.updateJob(jobId, {
    status: 'RETRYABLE_FAILURE',
    attemptCount: 0,
    errorClass: null,
    lastError: null,
    runNow: true,
    releaseLock: true,
  });
  await observability.emitTrace({
    jobId,
    agentId: job.agentId,
    type: 'JOB_RETRY_SCHEDULED',
    message: 'Requeued by the operator.',
    data: { from: job.status },
  });
}

export async function cancelJob(jobId: string): Promise<void> {
  const job = await jobsRepo.requireJob(jobId);
  const terminal = ['EXECUTED', 'DRY_RUN_COMPLETED', 'CANCELLED'];
  if (terminal.includes(job.status)) throw new ConflictError(`Job is already ${job.status}.`);
  await jobsRepo.updateJob(jobId, { status: 'CANCELLED', releaseLock: true, lastError: 'Cancelled by the operator.' });
  await observability.emitTrace({
    jobId,
    agentId: job.agentId,
    type: 'JOB_CANCELLED',
    level: 'warn',
    message: 'Cancelled by the operator.',
    data: { from: job.status },
  });
}
