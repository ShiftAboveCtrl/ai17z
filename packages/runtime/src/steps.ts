import type { Capability, JobRecord, NormalizedEvent, ResolvedContext } from '@xbam/shared/contracts';
import { MediaInventory, positionsConflict } from '@xbam/shared/contracts';
import type { RelationshipContext, StanceContext } from '@xbam/shared/contracts';
import { PipelineError, contentSignature, truncate } from '@xbam/shared';
import {
  actions as actionsRepo,
  agents as agentsRepo,
  capabilities as capabilitiesRepo,
  conversations as conversationsRepo,
  jobs as jobsRepo,
  legacyLedger,
  memories as memoriesRepo,
  observability,
  ops,
  prompts as promptsRepo,
  radar as radarRepo,
  relationships as relationshipsRepo,
  stances as stancesRepo,
  withTransaction,
} from '@xbam/database';
import { retrieveMemories, applyWritePolicy } from '@xbam/memory';
import { assemblePrompt } from '@xbam/prompts';
import { generate } from '@xbam/models';
import { getChannelAdapter } from '@xbam/channels';
import { describeTools } from '@xbam/tools';
import { buildChannelContext, syntheticAccount } from './channelContext';
import { resolveMedia } from './mediaResolve';
import { loadRelationshipContext, recordExchange } from './relationship';
import {
  checkStanceConsistency,
  detectClaims,
  learnStancesFromOwnPost,
  loadStanceContext,
  readPosition,
} from './stance';
import { chooseIntent, decideEngagement, readTemperature, recentRepliesTo } from './engagement';
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
    // The final say on whether this action is permitted. Ingest checked the same
    // grant, but a permission revoked in between must stop the job here, and a
    // revoked permission is not something a retry can fix.
    if (job.accountId) {
      const granted = await capabilitiesRepo.grantsFor(bundle.agent.id, job.accountId);
      if (!granted.has(job.actionType as Capability)) {
        throw PipelineError.permanent(
          'capability_not_granted',
          `This agent is not permitted to ${job.actionType} through @${bundle.account?.handle ?? 'this account'}. Grant it on the account, then run the job again.`,
        );
      }
    }

    const rate = await checkActionRate(bundle.agent.id, policy, bundle.job.accountId);
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

    // The exchange is recorded here, after the reply actually went out. An
    // inbound message nobody answered is not a conversation, and counting it as
    // one is how somebody who repeatedly mentions an agent becomes a 'regular'.
    if (result.status !== 'DRY_RUN') {
      await recordExchange({
        agentId: bundle.agent.id,
        channel: job.channel,
        handle: context?.targetAuthorHandle ?? bundle.event.remoteAuthorHandle,
        remoteUserId: bundle.event.remoteAuthorId,
        displayName: bundle.event.remoteAuthorDisplay,
      }).catch(() => undefined);

      // A callback that was offered and used is marked, so it rests before it
      // can be offered again.
      const callbackId = (context?.meta as { callbackId?: string } | undefined)?.callbackId;
      if (callbackId) await relationshipsRepo.markCallbackUsed(callbackId).catch(() => undefined);
    }

    // Positions, predictions and promises are recorded from what actually went
    // out. A draft is not something the agent has said, and a dry run is
    // explicitly not a public position.
    if (result.status !== 'DRY_RUN' && policy.stance.enabled) {
      await learnStancesFromOwnPost({
        agentId: bundle.agent.id,
        text: output,
        policy: policy.stance,
        jobId: job.id,
        remoteUrl: result.remoteActionUrl,
      }).catch(() => undefined);

      const claims = detectClaims(output);
      if (claims.prediction && policy.stance.trackPredictions) {
        await stancesRepo
          .recordPrediction({
            agentId: bundle.agent.id,
            claim: claims.prediction.claim,
            confidence: claims.prediction.confidence,
            // Far enough out to be worth asking about, near enough to matter.
            reviewAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
            jobId: job.id,
            remoteUrl: result.remoteActionUrl,
          })
          .catch(() => undefined);
      }
      if (claims.commitment && policy.stance.trackCommitments) {
        await stancesRepo
          .recordCommitment({
            agentId: bundle.agent.id,
            promise: claims.commitment.promise,
            confidence: claims.commitment.confidence,
            recipientHandle: context?.targetAuthorHandle ?? bundle.event.remoteAuthorHandle,
            jobId: job.id,
            remoteUrl: result.remoteActionUrl,
          })
          .catch(() => undefined);
      }
    }

    // Remember what we posted, so replies underneath it can be found by reading
    // the thread rather than by hoping a notification arrives. A dry run posts
    // nothing, so there is nothing to come back to.
    if (result.status !== 'DRY_RUN' && result.remoteActionId && job.accountId) {
      await radarRepo
        .recordOwnPost({
          accountId: job.accountId,
          agentId: bundle.agent.id,
          remoteId: result.remoteActionId,
          remoteUrl: result.remoteActionUrl,
          text: output,
          postedAt: new Date().toISOString(),
        })
        .catch(() => undefined);
    }
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

/**
 * Understands what is attached to the post.
 *
 * Runs after context resolution, because the adapter records the media
 * inventory while the page is open and this is where it is turned into
 * something the model can be told.
 */
export async function stepResolveMedia(bundle: JobBundle): Promise<void> {
  const { job, policy } = bundle;
  const context = job.resolvedContext;
  const inventory = MediaInventory.safeParse((context?.meta as { inventory?: unknown })?.inventory);

  if (!inventory.success || (inventory.data.media.length === 0 && !inventory.data.quoted && inventory.data.links.length === 0)) {
    await observability.emitTrace({
      jobId: job.id,
      agentId: bundle.agent.id,
      type: 'MEDIA_RESOLVED',
      message: 'Nothing attached to this post.',
      data: { items: 0 },
    });
    return;
  }

  const resolved = await resolveMedia({
    eventId: job.eventId,
    agentId: bundle.agent.id,
    jobId: job.id,
    text: context?.incomingText ?? '',
    inventory: inventory.data,
    policy: policy.media,
    maxCalls: policy.budget.maxModelCallsPerJob,
  });

  await observability.emitTrace({
    jobId: job.id,
    agentId: bundle.agent.id,
    type: 'MEDIA_RESOLVED',
    level: resolved.hasUnderstandingGap ? 'warn' : 'info',
    message: resolved.hasUnderstandingGap
      ? `Something that mattered was not read: ${resolved.gapDetail}`
      : `Understood ${resolved.items.filter((i) => i.status === 'analyzed').length} of ${resolved.items.length} attached items.`,
    data: {
      items: resolved.items.map((i) => ({ kind: i.kind, status: i.status, description: i.description })),
      quoted: resolved.quoted ? { authorHandle: resolved.quoted.authorHandle } : null,
      links: resolved.links.map((l) => ({ url: l.url, resolution: l.resolution })),
      hasUnderstandingGap: resolved.hasUnderstandingGap,
    },
  });

  // A gap in something the post depended on is a decision point, not a detail.
  // Answering "what do you think?" without having seen the chart is the exact
  // failure this stage exists to prevent.
  if (resolved.hasUnderstandingGap) {
    switch (policy.media.onVisionFailure) {
      case 'RETRY':
        throw PipelineError.retryable('media_unreadable', resolved.gapDetail ?? 'Attached media could not be read.');
      case 'REVIEW':
        throw PipelineError.review('media_unreadable', resolved.gapDetail ?? 'Attached media could not be read.');
      case 'IGNORE':
        throw PipelineError.permanent(
          'media_unreadable',
          `${resolved.gapDetail} This agent is set to skip posts it cannot fully read.`,
        );
      case 'RESPOND_TEXT_ONLY_IF_SAFE':
      default:
        // Carries on, and the prompt is told plainly that something is missing
        // so the response can acknowledge it rather than bluff.
        break;
    }
  }

  // Only rewrite the context when there is one; a job with none has nothing to
  // attach the media understanding to.
  if (context) {
    await jobsRepo.updateJob(job.id, {
      resolvedContext: { ...context, meta: { ...context.meta, mediaContext: resolved } },
    });
  }
}

/**
 * Loads what the agent knows about the person it is replying to.
 *
 * Runs before memory retrieval, because who somebody is changes what is worth
 * remembering about them.
 */
export async function stepRelationship(bundle: JobBundle): Promise<void> {
  const { job, policy } = bundle;
  const context = job.resolvedContext;

  const loaded = await loadRelationshipContext({
    agentId: bundle.agent.id,
    channel: job.channel,
    handle: context?.targetAuthorHandle ?? bundle.event.remoteAuthorHandle,
    remoteUserId: bundle.event.remoteAuthorId,
    voice: policy.relationships,
  });

  // A person the owner has blocked is not somebody to reply to, whatever the
  // rest of the pipeline would have decided.
  if (loaded.context.disposition === 'BLOCKED') {
    throw PipelineError.permanent(
      'relationship_blocked',
      `@${loaded.context.handle} is blocked for this agent.`,
    );
  }

  await observability.emitTrace({
    jobId: job.id,
    agentId: bundle.agent.id,
    type: 'RELATIONSHIP_LOADED',
    message: loaded.context.known
      ? `@${loaded.context.handle} is ${loaded.context.familiarity.toLowerCase()}. ${loaded.context.historyLine}`
      : `@${loaded.context.handle} is new.`,
    data: {
      familiarity: loaded.context.familiarity,
      topics: loaded.context.topics,
      callback: loaded.context.callback?.label ?? null,
      disposition: loaded.context.disposition,
    },
  });

  if (context) {
    await jobsRepo.updateJob(job.id, {
      resolvedContext: {
        ...context,
        meta: { ...context.meta, relationship: loaded.context, callbackId: loaded.callbackId },
      },
    });
  }
}

/**
 * Loads the positions the agent already holds on whatever is being discussed.
 *
 * Runs before generation so the model is told what it has said before, rather
 * than being corrected afterwards by a gate it cannot see.
 */
export async function stepStance(bundle: JobBundle): Promise<void> {
  const { job, policy } = bundle;
  if (!policy.stance.enabled) return;

  const context = job.resolvedContext;
  const text = [context?.incomingText, context?.parentText].filter(Boolean).join('\n');
  const stanceContext = await loadStanceContext(bundle.agent.id, text);

  // Promises made to this person and not yet closed. Forgetting one is worse
  // than never having made it.
  const handle = context?.targetAuthorHandle ?? bundle.event.remoteAuthorHandle;
  const open = handle ? await stancesRepo.openCommitmentsTo(bundle.agent.id, handle, 2) : [];

  await observability.emitTrace({
    jobId: job.id,
    agentId: bundle.agent.id,
    type: 'STANCE_SELECTED',
    message:
      stanceContext.relevant.length > 0
        ? `Holds a position on ${stanceContext.relevant.map((s) => s.subject).join(', ')}.`
        : 'No existing position touches this.',
    data: { relevant: stanceContext.relevant, revised: stanceContext.revised, openCommitments: open.length },
  });

  if (context) {
    await jobsRepo.updateJob(job.id, {
      resolvedContext: {
        ...context,
        meta: { ...context.meta, stance: stanceContext, openCommitments: open },
      },
    });
  }
}

/**
 * Checks a validated draft against what the agent has already said publicly.
 *
 * Runs after validation and before the approval gate, so a contradiction is
 * caught while there is still somewhere sensible to send it.
 */
export async function stepStanceCheck(bundle: JobBundle): Promise<void> {
  const { job, policy } = bundle;
  const output = job.validatedOutput ?? job.generatedOutput;
  if (!policy.stance.enabled || !output) return;

  const check = await checkStanceConsistency({ agentId: bundle.agent.id, text: output, policy: policy.stance });
  if (check.ok) return;

  await observability.emitTrace({
    jobId: job.id,
    agentId: bundle.agent.id,
    type: 'STANCE_CONFLICT',
    level: 'warn',
    message: check.message ?? 'This contradicts a position the agent already holds.',
    data: {
      subject: check.conflictsWith?.subject,
      heldPosition: check.conflictsWith?.position,
      candidatePosition: check.candidatePosition,
      confidence: check.conflictsWith?.confidence,
    },
  });

  switch (policy.stance.onConflict) {
    case 'REVIEW':
      throw PipelineError.review('stance_conflict', check.message ?? 'This contradicts an existing position.');
    case 'REWRITE':
      // Retryable so the generation stage runs again, now with the conflict in
      // front of it rather than only in the trace.
      throw PipelineError.retryable(
        'stance_conflict',
        `${check.message} Say it in a way that does not simply reverse that, or acknowledge the change.`,
      );
    case 'ALLOW_AND_REVISE':
    case 'IGNORE':
    default:
      // Allowed through. The revision itself is recorded after the post goes
      // out, where there is a public statement to attach it to.
      break;
  }
}

/**
 * Decides whether this is worth answering.
 *
 * Returns a branch rather than throwing, because staying silent is a normal
 * outcome and not a failure. The reasons are recorded either way, so "why did
 * it ignore this?" has an answer.
 */
export async function stepEngagement(bundle: JobBundle): Promise<'engage' | 'ignore' | 'review'> {
  const { job, policy } = bundle;
  const context = job.resolvedContext;
  const text = context?.incomingText ?? bundle.event.text;
  const relationship = (context?.meta as { relationship?: RelationshipContext } | undefined)?.relationship ?? null;

  const handle = context?.targetAuthorHandle ?? bundle.event.remoteAuthorHandle;
  const selfHandles = policy.content.selfHandles.map((h) => h.replace(/^@+/, '').toLowerCase());
  const directlyAddressed = selfHandles.some((self) => text.toLowerCase().includes(`@${self}`));

  const verdict = decideEngagement({
    text,
    directlyAddressed,
    relationship,
    threadDepth: context?.thread.length ?? 0,
    recentRepliesToPerson: await recentRepliesTo(bundle.agent.id, handle),
    alreadyRepliedInThread: (context?.thread ?? []).some((m) => m.role === 'OUTBOUND'),
    policy: policy.engagement,
  });

  await observability.emitTrace({
    jobId: job.id,
    agentId: bundle.agent.id,
    type: 'ENGAGEMENT_DECIDED',
    level: verdict.decision === 'IGNORE' ? 'warn' : 'info',
    message: `${verdict.decision.toLowerCase()} (${verdict.value}/100): ${verdict.reason}`,
    data: { decision: verdict.decision, value: verdict.value, factors: verdict.factors, strategy: policy.engagement.strategy },
  });

  if (context) {
    await jobsRepo.updateJob(job.id, {
      resolvedContext: { ...context, meta: { ...context.meta, engagement: verdict } },
    });
  }

  if (verdict.decision === 'IGNORE') return 'ignore';
  if (verdict.decision === 'REVIEW') return 'review';
  return 'engage';
}

/**
 * Picks what kind of reply this should be, before anything is generated.
 *
 * Answering a joke with an explanation, or a challenge with a definition, is
 * the sort of thing that makes an agent read as a machine. Choosing the social
 * act first is what prevents it.
 */
export async function stepIntent(bundle: JobBundle): Promise<void> {
  const { job } = bundle;
  const context = job.resolvedContext;
  const text = context?.incomingText ?? bundle.event.text;
  const meta = (context?.meta ?? {}) as {
    relationship?: RelationshipContext;
    stance?: StanceContext;
  };

  const temperature = readTemperature(text);
  const contradicts = (meta.stance?.relevant ?? []).some((s) => {
    const read = readPosition(text);
    return positionsConflict(s.position, read.position);
  });

  const decision = chooseIntent({
    text,
    temperature,
    relationship: meta.relationship ?? null,
    contradictsStance: contradicts,
    hasCallback: Boolean(meta.relationship?.callback),
  });

  await observability.emitTrace({
    jobId: job.id,
    agentId: bundle.agent.id,
    type: 'INTENT_SELECTED',
    message: `${decision.intent}: ${decision.reason}`,
    data: { intent: decision.intent, temperature: decision.temperature, reason: decision.reason },
  });

  if (context) {
    await jobsRepo.updateJob(job.id, {
      resolvedContext: { ...context, meta: { ...context.meta, intent: decision } },
    });
  }
}
