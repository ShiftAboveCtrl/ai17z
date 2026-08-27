import type { JobRecord, NormalizedEvent, ResolvedContext } from '@xbam/shared/contracts';
import { PipelineError, contentSignature, truncate } from '@xbam/shared';
import {
  actions as actionsRepo,
  agents as agentsRepo,
  conversations as conversationsRepo,
  jobs as jobsRepo,
  legacyLedger,
  memories as memoriesRepo,
  observability,
  ops,
  prompts as promptsRepo,
  withTransaction,
} from '@xbam/database';
import { retrieveMemories, applyWritePolicy } from '@xbam/memory';
import { assemblePrompt } from '@xbam/prompts';
import { generate } from '@xbam/models';
import { getChannelAdapter } from '@xbam/channels';
import { describeTools } from '@xbam/tools';
import { buildChannelContext, syntheticAccount } from './channelContext';
import type { JobBundle } from './loadJob';
import { validateOutput } from './validator';
import { checkActionRate, checkAudience, checkBudget } from './policyGate';

/** Rebuilds the NormalizedEvent shape the adapter expects from the stored row. */
function eventToNormalized(bundle: JobBundle): NormalizedEvent {
  const e = bundle.event;
  return {
    channel: e.channel,
    type: e.type as NormalizedEvent['type'],
    remoteEventId: e.remoteEventId,
    remoteMessageId: e.remoteMessageId,
    remoteAuthorId: e.remoteAuthorId,
    remoteAuthorHandle: e.remoteAuthorHandle,
    remoteAuthorDisplayName: e.remoteAuthorDisplay,
    remoteConversationId: e.remoteConversationId,
    parentRemoteMessageId: e.parentRemoteMessageId,
    remoteUrl: e.remoteUrl,
    text: e.text,
    occurredAt: e.occurredAt,
    raw: e.payload,
  };
}

async function adapterContext(bundle: JobBundle) {
  const account =
    bundle.account ?? syntheticAccount({ id: `synthetic-${bundle.agent.id}`, ownerId: bundle.agent.ownerId });
  return buildChannelContext(account, bundle.job.id);
}

export async function stepResolveContext(bundle: JobBundle): Promise<void> {
  const adapter = getChannelAdapter(bundle.job.channel);
  const ctx = await adapterContext(bundle);
  const resolved = await adapter.resolveContext(ctx, eventToNormalized(bundle));

  // The adapter reports what it could see remotely. Anything it could not see,
  // but that we already recorded, is filled in from our own conversation history.
  if (resolved.thread.length === 0 && bundle.job.conversationId) {
    const prior = await conversationsRepo.recentMessages(bundle.job.conversationId, 12);
    resolved.thread = prior.filter((m) => m.remoteMessageId !== bundle.event.remoteMessageId);
  }

  await jobsRepo.updateJob(bundle.job.id, {
    status: 'CONTEXT_RESOLVED',
    resolvedContext: resolved,
    touch: ['contextResolvedAt'],
  });
  await observability.emitTrace({
    jobId: bundle.job.id,
    agentId: bundle.agent.id,
    type: 'CONTEXT_RESOLVED',
    message: resolved.targetRef ? `Target resolved: ${truncate(resolved.targetRef, 120)}` : 'Context resolved',
    data: {
      targetRef: resolved.targetRef,
      author: resolved.targetAuthorHandle,
      threadDepth: resolved.thread.length,
      hasParent: Boolean(resolved.parentText),
    },
  });
}

export async function stepRetrieveMemory(bundle: JobBundle): Promise<void> {
  const context = bundle.job.resolvedContext;
  if (!context) throw PipelineError.retryable('context_missing', 'Memory retrieval ran before context was resolved.');

  const outcome = await retrieveMemories({
    agentId: bundle.agent.id,
    policy: bundle.policy.memory,
    conversationId: bundle.job.conversationId,
    remoteHandle: context.targetAuthorHandle ?? bundle.event.remoteAuthorHandle,
    accountId: bundle.job.accountId,
    incomingText: context.incomingText,
  });

  await withTransaction(async (tx) => {
    await memoriesRepo.recordRetrievals(bundle.job.id, outcome.memories, tx);
    await jobsRepo.updateJob(bundle.job.id, { status: 'MEMORY_RESOLVED', touch: ['memoryResolvedAt'] }, tx);
  });

  await observability.emitTrace({
    jobId: bundle.job.id,
    agentId: bundle.agent.id,
    type: 'MEMORY_SELECTED',
    message: `${outcome.memories.length} memories selected`,
    data: {
      byScope: outcome.byScope,
      terms: outcome.terms,
      selected: outcome.memories.slice(0, 20).map((m) => ({
        scope: m.scope,
        reason: m.reason,
        preview: truncate(m.summary ?? m.content, 120),
      })),
    },
  });
}

export async function stepGenerate(bundle: JobBundle): Promise<void> {
  const context = bundle.job.resolvedContext;
  if (!context) throw PipelineError.retryable('context_missing', 'Generation ran before context was resolved.');

  const audience = checkAudience(bundle.policy, context);
  if (!audience.allow) {
    throw audience.kind === 'PERMANENT'
      ? PipelineError.permanent(audience.reason, audience.message)
      : PipelineError.retryable(audience.reason, audience.message);
  }

  const budget = await checkBudget(bundle.agent.id, bundle.policy);
  if (!budget.allow) throw PipelineError.retryable(budget.reason, budget.message);

  const template = bundle.job.promptTemplateVersionId
    ? await promptsRepo.getTemplateVersion(bundle.job.promptTemplateVersionId)
    : await promptsRepo.getActiveTemplate('reply.default');
  if (!template) throw PipelineError.permanent('template_missing', 'The prompt template for this job is missing.');

  const memories = await memoriesRepo.listRetrievals(bundle.job.id);
  const enabledTools = await ops.listAgentTools(bundle.agent.id);
  const toolKeys = enabledTools
    .filter((t) => t.enabled && bundle.policy.tools.allowed.includes(t.key))
    .map((t) => t.key);

  const prompt = assemblePrompt({
    layers: template.layers,
    templateKey: template.templateKey,
    templateVersion: template.version,
    persona: bundle.persona,
    policy: bundle.policy,
    context,
    memories,
    channelName: getChannelAdapter(bundle.job.channel).displayName,
    toolDescriptions: describeTools(toolKeys),
    memoryCharBudget: bundle.policy.memory.retrieval.totalCharBudget,
  });

  await observability.emitTrace({
    jobId: bundle.job.id,
    agentId: bundle.agent.id,
    type: 'PROMPT_ASSEMBLED',
    message: `${prompt.layers.length} layers, ${prompt.promptText.length} characters`,
    data: {
      template: `${template.templateKey} v${template.version}`,
      personaVersion: bundle.persona.version,
      layers: prompt.layers.map((l) => ({ key: l.key, source: l.source, chars: l.content.length })),
    },
  });

  const result = await generate({
    agentId: bundle.agent.id,
    jobId: bundle.job.id,
    purpose: 'GENERATE',
    messages: prompt.messages,
    promptLayers: prompt.layers,
    promptText: prompt.promptText,
    maxCalls: bundle.policy.budget.maxModelCallsPerJob,
  });

  await jobsRepo.updateJob(bundle.job.id, {
    status: 'GENERATED',
    generatedOutput: result.text,
    touch: ['generatedAt'],
  });
}

export async function stepValidate(bundle: JobBundle): Promise<void> {
  const raw = bundle.job.generatedOutput;
  if (raw === null) throw PipelineError.retryable('output_missing', 'Validation ran before anything was generated.');

  const result = validateOutput(raw, bundle.policy);
  const blocking = result.violations.filter((v) => v.severity !== 'REPAIRED');

  if (!result.ok) {
    const summary = blocking.map((v) => v.message).join(' ');
    await observability.emitTrace({
      jobId: bundle.job.id,
      agentId: bundle.agent.id,
      type: 'VALIDATION_FAILED',
      level: 'warn',
      message: summary,
      data: { violations: result.violations },
    });
    const rejected = blocking.some((v) => v.severity === 'REJECT');
    // A rejected output is a content problem, not a transient one. Retrying the
    // same prompt would produce the same class of answer, so a human decides.
    if (rejected || bundle.policy.safety.reviewOnValidationFailure) {
      throw PipelineError.review('validation_failed', summary);
    }
    throw PipelineError.retryable('validation_failed', summary);
  }

  await jobsRepo.updateJob(bundle.job.id, {
    status: 'VALIDATED',
    validatedOutput: result.output,
    touch: ['validatedAt'],
  });
  await observability.emitTrace({
    jobId: bundle.job.id,
    agentId: bundle.agent.id,
    type: 'VALIDATION_PASSED',
    message: result.violations.length > 0 ? `Passed with ${result.violations.length} repair(s)` : 'Passed',
    data: { repairs: result.violations, chars: result.output.length },
  });
}

/** Records a browser/adapter failure with a screenshot when one is available. */
async function captureFailureDiagnostics(bundle: JobBundle, actionId: string | null, reason: string): Promise<void> {
  const adapter = getChannelAdapter(bundle.job.channel);
  try {
    const ctx = await adapterContext(bundle);
    const capture = await adapter.captureDiagnostics(ctx, reason);
    if (!capture) return;
    let artifactId: string | null = null;
    if (capture.screenshotRelPath) {
      const artifact = await ops.createArtifact({
        kind: 'SCREENSHOT',
        jobId: bundle.job.id,
        actionId,
        accountId: bundle.job.accountId,
        agentId: bundle.agent.id,
        mimeType: 'image/png',
        relPath: capture.screenshotRelPath,
        bytes: Number(capture.meta.bytes ?? 0),
      });
      artifactId = artifact.id;
    }
    const diagnostic = await ops.createDiagnostic({
      jobId: bundle.job.id,
      actionId,
      accountId: bundle.job.accountId,
      channel: bundle.job.channel,
      kind: capture.kind,
      url: capture.url,
      targetRef: bundle.job.resolvedContext?.targetRef ?? null,
      errorClass: 'RETRYABLE',
      message: capture.message,
      artifactId,
      meta: capture.meta,
    });
    await observability.emitTrace({
      jobId: bundle.job.id,
      agentId: bundle.agent.id,
      type: 'DIAGNOSTIC_CAPTURED',
      level: 'warn',
      message: capture.message,
      data: { diagnosticId: diagnostic.id, hasScreenshot: Boolean(artifactId) },
    });
  } catch (error) {
    // Diagnostics are best-effort; never let them replace the original failure.
    await observability.emitTrace({
      jobId: bundle.job.id,
      agentId: bundle.agent.id,
      type: 'DIAGNOSTIC_CAPTURED',
      level: 'warn',
      message: `Diagnostic capture failed: ${(error as Error).message}`,
      data: {},
    });
  }
}

export async function persistTurnAndMemory(bundle: JobBundle, outgoing: string, remoteMessageId: string | null): Promise<void> {
  if (bundle.job.conversationId) {
    await withTransaction(async (tx) => {
      await conversationsRepo.recordMessage(tx, {
        conversationId: bundle.job.conversationId!,
        direction: 'OUTBOUND',
        remoteMessageId,
        parentRemoteMessageId: bundle.event.remoteMessageId,
        authorHandle: bundle.account?.handle ?? bundle.persona.displayName,
        body: outgoing,
      });
    });
  }
  await applyWritePolicy(
    {
      agentId: bundle.agent.id,
      jobId: bundle.job.id,
      eventId: bundle.event.id,
      accountId: bundle.job.accountId,
      conversationId: bundle.job.conversationId,
      remoteHandle: bundle.job.resolvedContext?.targetAuthorHandle ?? bundle.event.remoteAuthorHandle,
      remoteUserId: bundle.event.remoteAuthorId,
      policy: bundle.policy.memory,
    },
    { incomingText: bundle.job.resolvedContext?.incomingText ?? bundle.event.text, outgoingText: outgoing },
  );
}

/**
 * The approval gate and the action boundary.
 *
 * Everything before this point is reversible. This is the only place in XBAM
 * that touches the outside world, and it does so behind three guards: the
 * automation mode, the rate policy, and an idempotency claim.
 */
export async function stepExecute(bundle: JobBundle): Promise<void> {
  const { job, policy } = bundle;
  const output = job.validatedOutput;
  if (!output) throw PipelineError.retryable('output_missing', 'Execution ran before validation produced output.');

  const context = job.resolvedContext;
  const targetRef = context?.targetRef ?? null;

  if (!job.dryRun) {
    const rate = await checkActionRate(bundle.agent.id, policy);
    if (!rate.allow) {
      throw PipelineError.retryable(rate.reason, rate.message, { retryAfterMs: rate.retryAfterMs });
    }
  }

  const signature = targetRef ? contentSignature(targetRef, output) : null;

  // A previous system may already have sent this exact text to this target.
  if (!job.dryRun && targetRef) {
    const legacy = legacyLedger.legacySignature(targetRef, output);
    if (await legacyLedger.legacyActionExists(bundle.agent.id, legacy)) {
      await jobsRepo.updateJob(job.id, { status: 'EXECUTED', touch: ['executedAt'], releaseLock: true });
      await observability.emitTrace({
        jobId: job.id,
        agentId: bundle.agent.id,
        type: 'ACTION_SKIPPED_DUPLICATE',
        level: 'warn',
        message: 'A previous system already sent this exact text to this target. Nothing was posted.',
        data: { legacySignature: legacy },
      });
      return;
    }
  }

  if (!job.dryRun && signature && (await actionsRepo.contentAlreadySent(bundle.agent.id, signature))) {
    await jobsRepo.updateJob(job.id, {
      status: 'EXECUTED',
      touch: ['executedAt'],
      releaseLock: true,
      lastError: null,
      errorClass: null,
    });
    await observability.emitTrace({
      jobId: job.id,
      agentId: bundle.agent.id,
      type: 'ACTION_SKIPPED_DUPLICATE',
      level: 'warn',
      message: 'This exact text was already sent to this target. Nothing was posted.',
      data: { signature },
    });
    return;
  }

  const claim = await actionsRepo.claimAction({
    jobId: job.id,
    agentId: bundle.agent.id,
    accountId: job.accountId,
    channel: job.channel,
    type: job.actionType,
    dryRun: job.dryRun,
    idempotencyKey: job.idempotencyKey,
    payload: { text: output, targetRef },
    targetRef,
  });

  if (claim.outcome === 'ALREADY_EXECUTED') {
    await jobsRepo.updateJob(job.id, { status: 'EXECUTED', touch: ['executedAt'], releaseLock: true });
    await observability.emitTrace({
      jobId: job.id,
      agentId: bundle.agent.id,
      type: 'ACTION_SKIPPED_DUPLICATE',
      level: 'warn',
      message: `This event was already acted on remotely (${claim.action.remoteActionId ?? 'no id recorded'}).`,
      data: { actionId: claim.action.id, remoteActionId: claim.action.remoteActionId },
    });
    return;
  }
  if (claim.outcome === 'IN_PROGRESS') {
    throw PipelineError.retryable('action_in_progress', 'Another worker is already executing this action.');
  }

  const action = claim.action;
  await observability.emitTrace({
    jobId: job.id,
    agentId: bundle.agent.id,
    type: 'ACTION_STARTED',
    message: job.dryRun ? `Dry run: ${job.actionType}` : `Executing ${job.actionType}`,
    data: { actionId: action.id, targetRef, dryRun: job.dryRun },
  });

  const adapter = getChannelAdapter(job.channel);
  const ctx = await adapterContext(bundle);

  try {
    const result = await adapter.executeAction(ctx, {
      type: job.actionType,
      targetRef,
      text: output,
      idempotencyKey: job.idempotencyKey,
      dryRun: job.dryRun,
    });

    await observability.emitTrace({
      jobId: job.id,
      agentId: bundle.agent.id,
      type: 'TARGET_VERIFIED',
      message: result.verification.detail,
      data: result.verification.evidence,
    });

    await actionsRepo.completeAction(action.id, {
      status: result.status === 'DRY_RUN' ? 'DRY_RUN' : 'EXECUTED',
      remoteActionId: result.remoteActionId,
      remoteActionUrl: result.remoteActionUrl,
      verification: result.verification as unknown as Record<string, unknown>,
      contentSignature: result.status === 'DRY_RUN' ? null : signature,
    });
    await actionsRepo.recordActionAttempt({
      actionId: action.id,
      attempt: job.attemptCount + 1,
      outcome: result.status,
    });

    if (result.status === 'DRY_RUN') {
      await jobsRepo.updateJob(job.id, { status: 'DRY_RUN_COMPLETED', touch: ['executedAt'], releaseLock: true });
      await observability.emitTrace({
        jobId: job.id,
        agentId: bundle.agent.id,
        type: 'DRY_RUN_STOPPED',
        message: 'Target verified. Stopped before performing the remote action.',
        data: { preview: truncate(output, 280) },
      });
      return;
    }

    await jobsRepo.updateJob(job.id, {
      status: 'EXECUTED',
      touch: ['executedAt'],
      releaseLock: true,
      lastError: null,
      errorClass: null,
    });
    if (bundle.account) {
      await agentsRepo
        .updateAgent(bundle.agent.id, { lastError: null })
        .catch(() => undefined);
    }
    await observability.emitTrace({
      jobId: job.id,
      agentId: bundle.agent.id,
      type: 'ACTION_COMPLETED',
      message: result.remoteActionUrl ? `Sent: ${result.remoteActionUrl}` : 'Sent.',
      data: { actionId: action.id, remoteActionId: result.remoteActionId },
    });
  } catch (error) {
    const pipelineError =
      error instanceof PipelineError
        ? error
        : PipelineError.retryable('action_exception', (error as Error).message, {}, error);
    await actionsRepo.completeAction(action.id, {
      status: 'FAILED',
      errorClass: pipelineError.errorClass,
      lastError: pipelineError.message,
    });
    await actionsRepo.recordActionAttempt({
      actionId: action.id,
      attempt: job.attemptCount + 1,
      outcome: 'FAILED',
      errorClass: pipelineError.errorClass,
      error: pipelineError.message,
    });
    await observability.emitTrace({
      jobId: job.id,
      agentId: bundle.agent.id,
      type: pipelineError.reason === 'target_unverified' ? 'TARGET_VERIFICATION_FAILED' : 'ACTION_FAILED',
      level: 'error',
      message: pipelineError.message,
      data: { actionId: action.id, reason: pipelineError.reason, errorClass: pipelineError.errorClass },
    });
    if (adapter.requiresBrowser) await captureFailureDiagnostics(bundle, action.id, pipelineError.message);
    throw pipelineError;
  }
}
