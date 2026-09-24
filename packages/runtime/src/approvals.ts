import { ConflictError, NotFoundError } from '@xbam/shared';
import {
  actions as actionsRepo,
  agents as agentsRepo,
  autonomy as autonomyRepo,
  events as eventsRepo,
  jobs as jobsRepo,
  observability,
} from '@xbam/database';
import { decisionFingerprint } from './ownerLearning';
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

  // Swallowed on purpose: an approval that has already happened must not be
  // undone because a preference row failed to write.
  await learnFromDecision(job.id, true, input.note).catch(() => undefined);

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
  /*
    Recorded, not swallowed.

    This used to be `.catch(() => undefined)`, which quietly lost the decision
    on exactly the jobs a person is most likely to decline: a REVIEW_REQUIRED
    job has no approval row yet, so the update matched nothing and there was
    never any record of who declined it or why. The approve path already
    created the row for that case and said so in a comment; only this half was
    missing, and "why was this never sent" is the question the row exists to
    answer.
  */
  try {
    await actionsRepo.decideApproval({
      jobId: job.id,
      status: 'REJECTED',
      note: input.note ?? null,
      decidedBy: input.decidedBy,
      editedOutput: null,
    });
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    await actionsRepo.createApproval(job.id, job.validatedOutput ?? job.generatedOutput ?? '');
    await actionsRepo.decideApproval({
      jobId: job.id,
      status: 'REJECTED',
      note: input.note ?? null,
      decidedBy: input.decidedBy,
      editedOutput: null,
    });
  }
  await jobsRepo.updateJob(job.id, {
    status: 'CANCELLED',
    lastError: input.note ?? 'Rejected by the operator.',
    releaseLock: true,
  });

  /*
    The half that matters most.

    A rejection is the owner saying "not this kind of thing", and the fault
    this fixes is an agent that asks again an hour later. Swallowed for the
    same reason as the approve path: the decision has already been taken and
    recorded, and a preference row is not allowed to interfere with it.
  */
  await learnFromDecision(job.id, false, input.note).catch(() => undefined);
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

/**
 * Remembers what the owner just decided, so the same question is asked better
 * next time.
 *
 * Called from both decision paths and deliberately not part of either: an
 * approval that succeeded must not be undone because a preference row failed
 * to write, which is why every call site swallows what this throws. The
 * decision itself is already recorded in `actions` and `jobs`; this is only
 * about what to put in front of somebody first.
 *
 * It can move an ordering and nothing else. There is no path from here to a
 * capability grant, an approval gate, or a Plugin's authority, and adding one
 * would turn a preference into a permission.
 */
export async function learnFromDecision(jobId: string, accepted: boolean, reason?: string | null): Promise<void> {
  const job = await jobsRepo.getJob(jobId);
  if (!job) return;
  const event = await eventsRepo.getEvent(job.eventId);
  const { fingerprint, family } = decisionFingerprint({
    kind: event?.type ?? 'UNKNOWN',
    actionType: job.actionType,
    handle: event?.remoteAuthorHandle ?? null,
  });
  await autonomyRepo.recordOwnerDecision({
    agentId: job.agentId,
    fingerprint,
    family,
    accepted,
    reason: reason ?? null,
  });
}
