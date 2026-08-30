import type { JobStatus, PipelineNode } from '@xbam/shared/contracts';
import { PipelineError, truncate } from '@xbam/shared';
import { actions as actionsRepo, jobs as jobsRepo, observability } from '@xbam/database';
import type { JobBundle } from './loadJob';
import {
  persistTurnAndMemory,
  stepExecute,
  stepGenerate,
  stepResolveContext,
  stepResolveMedia,
  stepResearch,
  stepRelationship,
  stepStance,
  stepStanceCheck,
  stepEngagement,
  stepIntent,
  stepVoice,
  stepQualityGate,
  stepRetrieveMemory,
  stepValidate,
} from './steps';

export interface NodeOutcome {
  /** Which outgoing branch to follow. */
  branch: string;
  /** Stop the run here. The job is waiting on something outside the runtime. */
  halt?: boolean;
  /** Settled status to record before continuing. */
  status?: JobStatus;
}

export type NodeHandler = (bundle: JobBundle, node: PipelineNode) => Promise<NodeOutcome>;

const num = (value: unknown, fallback: number): number => (typeof value === 'number' ? value : fallback);
const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);

/**
 * Drops events not worth spending a model call on.
 *
 * This runs before generation on purpose: filtering afterwards costs money and
 * produces a reply nobody wanted.
 */
const filterNode: NodeHandler = async (bundle, node) => {
  const text = (bundle.job.resolvedContext?.incomingText ?? bundle.event.text ?? '').trim();
  const reasons: string[] = [];

  if (node.config.requireText !== false && text.length === 0) reasons.push('the message has no text');
  const minLength = num(node.config.minLength, 0);
  if (text.length < minLength) reasons.push(`shorter than ${minLength} characters`);

  const haystack = text.toLowerCase();
  for (const phrase of list(node.config.blockedPhrases)) {
    if (phrase && haystack.includes(phrase.toLowerCase())) reasons.push(`contains "${phrase}"`);
  }
  for (const phrase of list(node.config.requirePhrases)) {
    if (phrase && !haystack.includes(phrase.toLowerCase())) reasons.push(`does not mention "${phrase}"`);
  }

  const passed = reasons.length === 0;
  await observability.emitTrace({
    jobId: bundle.job.id,
    agentId: bundle.agent.id,
    type: passed ? 'VALIDATION_PASSED' : 'VALIDATION_FAILED',
    level: passed ? 'debug' : 'info',
    message: passed ? 'Passed the filter.' : `Filtered out: ${reasons.join('; ')}.`,
    data: { node: node.key, reasons },
  });
  return { branch: passed ? 'true' : 'false' };
};

/**
 * Routes on a fact about the job. A small fixed vocabulary rather than an
 * expression language: a pipeline node must not be able to run code.
 */
const conditionNode: NodeHandler = async (bundle, node) => {
  const subject = typeof node.config.subject === 'string' ? node.config.subject : 'outputLength';
  const output = bundle.job.validatedOutput ?? bundle.job.generatedOutput ?? '';
  const context = bundle.job.resolvedContext;

  let value: number | boolean;
  switch (subject) {
    case 'dryRun':
      value = bundle.job.dryRun;
      break;
    case 'hasParent':
      value = Boolean(context?.parentText);
      break;
    case 'threadDepth':
      value = context?.thread.length ?? 0;
      break;
    case 'attemptCount':
      value = bundle.job.attemptCount;
      break;
    case 'incomingLength':
      value = (context?.incomingText ?? bundle.event.text ?? '').length;
      break;
    case 'outputLength':
    default:
      value = output.length;
      break;
  }

  let passed: boolean;
  if (typeof value === 'boolean') {
    passed = node.config.equals === undefined ? value : value === Boolean(node.config.equals);
  } else {
    const min = num(node.config.min, Number.NEGATIVE_INFINITY);
    const max = num(node.config.max, Number.POSITIVE_INFINITY);
    passed = value >= min && value <= max;
  }

  await observability.emitTrace({
    jobId: bundle.job.id,
    agentId: bundle.agent.id,
    type: 'VALIDATION_PASSED',
    level: 'debug',
    message: `Condition "${subject}" = ${String(value)} took the ${passed ? 'true' : 'false'} branch.`,
    data: { node: node.key, subject, value, passed },
  });
  return { branch: passed ? 'true' : 'false' };
};

/**
 * The action boundary gate. A dry run never needs approval because nothing
 * leaves the machine; an autonomous agent proceeds; anything else waits.
 */
const approvalNode: NodeHandler = async (bundle) => {
  const { job, policy } = bundle;
  const output = job.validatedOutput;
  if (!output) throw PipelineError.retryable('output_missing', 'The approval gate ran before anything was generated.');

  if (job.dryRun || job.approvedAt) return { branch: 'approved' };

  const decision = await actionsRepo.getApproval(job.id);
  if (decision?.status === 'REJECTED') return { branch: 'rejected' };
  if (decision?.status === 'APPROVED') return { branch: 'approved' };
  if (policy.automation.mode === 'AUTONOMOUS') return { branch: 'approved' };

  await actionsRepo.createApproval(job.id, output);
  await observability.emitTrace({
    jobId: job.id,
    agentId: bundle.agent.id,
    type: 'APPROVAL_REQUESTED',
    message: 'Waiting for a human decision before acting.',
    data: { preview: truncate(output, 200) },
  });
  return { branch: 'approved', halt: true, status: 'WAITING_FOR_APPROVAL' };
};

/** Spaces work out without holding a worker slot: the job becomes due later. */
const delayNode: NodeHandler = async (bundle, node) => {
  const min = num(node.config.minSeconds, num(node.config.seconds, 30));
  const max = Math.max(min, num(node.config.maxSeconds, min));
  const seconds = min + Math.random() * (max - min);
  const runAt = new Date(Date.now() + seconds * 1000).toISOString();

  await jobsRepo.updateJob(bundle.job.id, { runAt });
  await observability.emitTrace({
    jobId: bundle.job.id,
    agentId: bundle.agent.id,
    type: 'JOB_RETRY_SCHEDULED',
    level: 'debug',
    message: `Waiting ${Math.round(seconds)}s before continuing.`,
    data: { node: node.key, runAt },
  });
  // Advance past the delay before halting, so resuming does not wait again.
  return { branch: 'next', halt: true };
};

const memoryWriteNode: NodeHandler = async (bundle) => {
  const output = bundle.job.validatedOutput ?? bundle.job.generatedOutput;
  if (!output) return { branch: 'next' };
  const action = (await actionsRepo.listJobActions(bundle.job.id)).at(-1);
  await persistTurnAndMemory(bundle, output, action?.remoteActionId ?? null);
  return { branch: 'next' };
};

export const NODE_HANDLERS: Record<string, NodeHandler> = {
  TRIGGER: async () => ({ branch: 'next' }),
  FILTER: filterNode,
  RESOLVE_CONTEXT: async (bundle) => {
    await stepResolveContext(bundle);
    return { branch: 'next' };
  },
  MEDIA_RESOLVE: async (bundle) => {
    await stepResolveMedia(bundle);
    return { branch: 'next' };
  },
  RESEARCH: async (bundle) => {
    await stepResearch(bundle);
    return { branch: 'next' };
  },
  RELATIONSHIP: async (bundle) => {
    await stepRelationship(bundle);
    return { branch: 'next' };
  },
  STANCE: async (bundle) => {
    await stepStance(bundle);
    return { branch: 'next' };
  },
  VOICE: async (bundle) => {
    await stepVoice(bundle);
    return { branch: 'next' };
  },
  QUALITY_GATE: async (bundle) => {
    await stepQualityGate(bundle);
    return { branch: 'next' };
  },
  STANCE_CHECK: async (bundle) => {
    await stepStanceCheck(bundle);
    return { branch: 'next' };
  },
  ENGAGEMENT_DECISION: async (bundle) => {
    const branch = await stepEngagement(bundle);
    // Ignoring is a settled outcome, not a failure: the job ends having
    // decided something, and the trace says what and why.
    return branch === 'ignore'
      ? { branch, halt: true, status: 'CANCELLED' }
      : branch === 'review'
        ? { branch, halt: true, status: 'REVIEW_REQUIRED' }
        : { branch };
  },
  INTENT: async (bundle) => {
    await stepIntent(bundle);
    return { branch: 'next' };
  },
  RETRIEVE_MEMORY: async (bundle) => {
    await stepRetrieveMemory(bundle);
    return { branch: 'next' };
  },
  ASSEMBLE_PERSONA: async (bundle) => {
    // The persona is pinned at ingest; this records which one the run used.
    await observability.emitTrace({
      jobId: bundle.job.id,
      agentId: bundle.agent.id,
      type: 'PROMPT_ASSEMBLED',
      level: 'debug',
      message: `Persona v${bundle.persona.version} (${bundle.persona.displayName}).`,
      data: { personaVersion: bundle.persona.version, identityKind: bundle.persona.identityKind },
    });
    return { branch: 'next' };
  },
  GENERATE: async (bundle) => {
    await stepGenerate(bundle);
    return { branch: 'next' };
  },
  VALIDATE: async (bundle) => {
    await stepValidate(bundle);
    return { branch: 'next' };
  },
  CONDITION: conditionNode,
  APPROVAL_GATE: approvalNode,
  DELAY: delayNode,
  EXECUTE_ACTION: async (bundle) => {
    await stepExecute(bundle);
    return { branch: 'next' };
  },
  MEMORY_WRITE: memoryWriteNode,
  PERSIST: memoryWriteNode,
  END: async (bundle, node) => {
    const reason = typeof node.config.reason === 'string' ? node.config.reason : null;
    // Ending without acting is cancelled, not failed: nothing went wrong.
    const acted = ['EXECUTED', 'DRY_RUN_COMPLETED'].includes(bundle.job.status);
    const status: JobStatus = acted ? bundle.job.status : 'CANCELLED';
    if (!acted && reason) await jobsRepo.updateJob(bundle.job.id, { lastError: reason });
    return { branch: 'next', halt: true, status };
  },
};
