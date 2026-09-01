import type { Capability, JobRecord, NormalizedEvent, ResolvedContext } from '@xbam/shared/contracts';
import { MediaInventory, positionsConflict } from '@xbam/shared/contracts';
import type { QualityReport, RelationshipContext, StanceContext } from '@xbam/shared/contracts';
import { PipelineError, contentSignature, createLogger, errorMessage, truncate } from '@xbam/shared';
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
  voice as voiceRepo,
  withTransaction,
} from '@xbam/database';
import { retrieveMemories, applyWritePolicy } from '@xbam/memory';
import { assemblePrompt } from '@xbam/prompts';
import { generate } from '@xbam/models';
import { getChannelAdapter } from '@xbam/channels';
import { describeTools } from '@xbam/tools';
import { buildChannelContext, syntheticAccount } from './channelContext';
import { hasVisionModel, resolveMedia } from './mediaResolve';
import { loadRelationshipContext, recordExchange } from './relationship';
import {
  checkStanceConsistency,
  detectClaims,
  learnStancesFromOwnPost,
  loadStanceContext,
  readPosition,
} from './stance';
import { chooseIntent, decideEngagement, readTemperature, recentRepliesTo } from './engagement';
import { compileForJob } from './voice';
import { loadThreadContext, observeEntities, recordNarratives } from './arcs';
import { harvestIdeas } from './content';
import { research, whatToResearch } from './research';
import { planLookups } from './plan';
import type { JobBundle } from './loadJob';
import { validateOutput } from './validator';
import { checkActionRate, checkAudience, checkBudget } from './policyGate';

const log = createLogger('steps');

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

/**
 * The context for a post the agent decided to make.
 *
 * There is no remote target to resolve and no conversation to read: the event
 * carries a brief written from the idea backlog. Built here rather than in the
 * adapter because it is the same on every channel, and because sending a
 * browser to a status page that does not exist would be a strange way to find
 * out there is nothing to look at.
 */
function selfOriginatedContext(bundle: JobBundle): ResolvedContext {
  return {
    targetRef: null,
    targetUrl: null,
    targetAuthorHandle: null,
    conversationRef: bundle.event.remoteEventId,
    incomingText: bundle.event.text,
    parentText: null,
    thread: [],
    conversation: null,
    meta: {
      origin: 'self',
      ideaId: (bundle.event.payload as { ideaId?: string })?.ideaId ?? null,
      resolvedAt: new Date().toISOString(),
    },
  };
}

/**
 * Files this exchange under the thread it belongs to.
 *
 * Ingest keys the conversation on the post, because that is all it has: a
 * mention read off a search result carries its own status id and no ancestry.
 * The thread root only becomes known here, once the status page has been opened
 * and its ancestors walked -- which is also the moment the agent finds out this
 * is the fourth message in a conversation rather than the first message from a
 * stranger.
 *
 * Skipping this step is what made "have we spoken before" unanswerable: every
 * message opened a conversation of its own, so 345 of them held exactly two
 * messages and the relationship history was empty every single time.
 *
 * Best-effort on purpose. Bookkeeping that fails must not stop a reply going
 * out; the worst case is the pre-existing behaviour.
 */
async function bindToThread(bundle: JobBundle, resolved: ResolvedContext): Promise<void> {
  const root = resolved.conversationRef;
  const current = bundle.job.conversationId;
  if (!root || !current) return;

  try {
    const existing = await conversationsRepo.getConversation(current);
    if (!existing || existing.remoteConversationId === root) return;

    await withTransaction(async (tx) => {
      const thread = await conversationsRepo.upsertConversation(tx, {
        agentId: bundle.agent.id,
        accountId: bundle.job.accountId,
        channel: bundle.job.channel,
        remoteConversationId: root,
        remoteUserId: bundle.event.remoteAuthorId,
        remoteHandle: resolved.targetAuthorHandle ?? bundle.event.remoteAuthorHandle,
      });
      if (thread.id === current) return;
      await conversationsRepo.mergeConversation(tx, current, thread.id);
      await jobsRepo.updateJob(bundle.job.id, { conversationId: thread.id }, tx);
      bundle.job.conversationId = thread.id;
    });
  } catch (error) {
    log.warn('could not file this message under its thread', {
      jobId: bundle.job.id,
      message: errorMessage(error),
    });
  }
}

export async function stepResolveContext(bundle: JobBundle): Promise<void> {
  const adapter = getChannelAdapter(bundle.job.channel);
  const ctx = await adapterContext(bundle);
  const resolved =
    bundle.job.actionType === 'POST'
      ? selfOriginatedContext(bundle)
      : await adapter.resolveContext(ctx, eventToNormalized(bundle));

  // Now that the thread is known, put this exchange with the rest of it.
  await bindToThread(bundle, resolved);

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

  // Every gate that knows how long it will be blocked says so, and every throw
  // carries that through: a limit is waited out rather than retried, and a wait
  // does not spend an attempt. A daily budget cap answered with an exponential
  // backoff burns all five attempts in under a minute of a twenty-four hour
  // wait, which is how a job dies of a ceiling that would have cleared.
  const audience = checkAudience(bundle.policy, context);
  if (!audience.allow) {
    throw audience.kind === 'PERMANENT'
      ? PipelineError.permanent(audience.reason, audience.message)
      : PipelineError.retryable(audience.reason, audience.message, { retryAfterMs: audience.retryAfterMs });
  }

  const budget = await checkBudget(bundle.agent.id, bundle.policy);
  if (!budget.allow) {
    throw PipelineError.retryable(budget.reason, budget.message, { retryAfterMs: budget.retryAfterMs });
  }

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
    actionType: bundle.job.actionType,
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

  // A post has no target, so its signature is taken against the account itself.
  // Without this the "have we already sent this exact text" check simply does
  // not apply to posts, and an agent could publish the same thought twice.
  const signatureRef = targetRef ?? (job.actionType === 'POST' ? `self:post:${job.accountId ?? 'none'}` : null);
  const signature = signatureRef ? contentSignature(signatureRef, output) : null;

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
  const adapter = getChannelAdapter(job.channel);

  // An action recovered from a worker that died mid-flight. It may have died
  // before X saw the reply or after, and only X knows which — so ask, rather
  // than assume. Assuming it did not happen is how recovery becomes a
  // duplicate-post machine; assuming it did is how a reply silently vanishes.
  if (claim.retakenFromStale && !job.dryRun && adapter.wasAlreadyDone) {
    const already = await adapter
      .wasAlreadyDone(await adapterContext(bundle), {
        type: job.actionType,
        targetRef,
        text: output,
        idempotencyKey: job.idempotencyKey,
        dryRun: false,
      })
      .catch(() => null);

    if (already?.done) {
      await actionsRepo.completeAction(action.id, {
        status: 'EXECUTED',
        remoteActionId: already.remoteActionId,
        remoteActionUrl: already.remoteActionUrl,
        contentSignature: signature,
      });
      await jobsRepo.updateJob(job.id, { status: 'EXECUTED', touch: ['executedAt'], releaseLock: true });
      await observability.emitTrace({
        jobId: job.id,
        agentId: bundle.agent.id,
        type: 'ACTION_SKIPPED_DUPLICATE',
        level: 'warn',
        message: already.detail,
        data: { actionId: action.id, remoteActionId: already.remoteActionId, recovered: true },
      });
      return;
    }
  }
  await observability.emitTrace({
    jobId: job.id,
    agentId: bundle.agent.id,
    type: 'ACTION_STARTED',
    message: job.dryRun ? `Dry run: ${job.actionType}` : `Executing ${job.actionType}`,
    data: { actionId: action.id, targetRef, dryRun: job.dryRun },
  });
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

    // Whether this exchange left something worth saying on its own later.
    // Conservative: most conversations produce no idea at all, and a backlog
    // padded with everything the agent has discussed is as useless as an empty
    // one.
    if (result.status !== 'DRY_RUN') {
      await harvestIdeas({
        agentId: bundle.agent.id,
        jobId: job.id,
        incoming: context?.incomingText ?? bundle.event.text,
        outgoing: output,
        handle: context?.targetAuthorHandle ?? bundle.event.remoteAuthorHandle,
      }).catch(() => undefined);
    }

    // What the agent keeps arguing, and what keeps coming up. Both are recorded
    // from published text only: a draft is not an argument the agent has made.
    if (result.status !== 'DRY_RUN') {
      await recordNarratives(bundle.agent.id, output).catch(() => undefined);
      await observeEntities(bundle.agent.id, output).catch(() => undefined);
    }

    // Everything published goes into the recent-output ledger, which is what the
    // repetition check reads. Only real posts: a dry run said nothing.
    if (result.status !== 'DRY_RUN') {
      await voiceRepo
        .recordOutput({
          agentId: bundle.agent.id,
          actionId: action.id,
          text: output,
          recipientHandle: context?.targetAuthorHandle ?? bundle.event.remoteAuthorHandle,
        })
        .catch(() => undefined);
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

  // Where this conversation has got to, which is a different question from who
  // the person is. Loaded here so both arrive together.
  const thread = await loadThreadContext({
    agentId: bundle.agent.id,
    remoteConversationId: context?.conversationRef ?? bundle.event.remoteConversationId,
    conversationId: job.conversationId,
    participant: context?.targetAuthorHandle ?? bundle.event.remoteAuthorHandle,
    thread: context?.thread ?? [],
    policy,
    jobId: job.id,
    allowModelCall: !job.dryRun,
  }).catch(() => null);

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
        meta: { ...context.meta, relationship: loaded.context, callbackId: loaded.callbackId, thread },
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

  // The account's own handle is the authoritative one, and it was missing here.
  // `policy.content.selfHandles` is an aliases list nobody fills in, so for
  // every agent set up through Easy Mode this test was against an empty array:
  // "addressed to this account" never scored, on any mention, ever. The policy
  // list still contributes, for a second handle or a former name.
  const selfHandles = [bundle.account?.handle, ...policy.content.selfHandles]
    .filter((h): h is string => Boolean(h))
    .map((h) => h.replace(/^@+/, '').toLowerCase());
  const directlyAddressed = selfHandles.some((self) => text.toLowerCase().includes(`@${self}`));

  const verdict = decideEngagement({
    topics: bundle.persona.topics,
    text,
    directlyAddressed,
    relationship,
    threadDepth: context?.thread.length ?? 0,
    recentRepliesToPerson: await recentRepliesTo(bundle.agent.id, handle),
    alreadyRepliedInThread: (context?.thread ?? []).some((m) => m.role === 'OUTBOUND'),
    // Not whether the agent has spoken here, but how often. One follow-up is a
    // conversation; four is an agent that will not let a thread end.
    ourRepliesInThread: (context?.thread ?? []).filter((m) => m.role === 'OUTBOUND').length,
    hasParent: Boolean(context?.parentText?.trim()) || (context?.thread.length ?? 0) > 0,
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

/**
 * Makes the draft sound like this agent, and judges whether it does.
 *
 * Runs after validation, so the text has already been through the output policy
 * and this is only changing how it reads. The result replaces the validated
 * output: what gets published is what came out of here.
 */
export async function stepVoice(bundle: JobBundle): Promise<void> {
  const { job, policy } = bundle;
  const draft = job.validatedOutput ?? job.generatedOutput;
  if (!policy.voice.enabled || !draft) return;

  const context = job.resolvedContext;
  const compiled = await compileForJob({
    agentId: bundle.agent.id,
    jobId: job.id,
    draft,
    policy,
    recipientHandle: context?.targetAuthorHandle ?? bundle.event.remoteAuthorHandle,
    // A dry run is for seeing what would be said, so it is worth showing the
    // real thing; but a rewrite costs money and a dry run is not going out.
    allowModelCall: !job.dryRun,
    maxCalls: policy.budget.maxModelCallsPerJob,
  });

  await observability.emitTrace({
    jobId: job.id,
    agentId: bundle.agent.id,
    type: 'VOICE_COMPILED',
    message:
      compiled.applied.length > 0
        ? `Voice ${compiled.report.voice.score}/100 after ${compiled.applied.join(', ')}.`
        : `Voice ${compiled.report.voice.score}/100, left as written.`,
    data: {
      applied: compiled.applied,
      voice: compiled.report.voice,
      modelCallUsed: compiled.modelCallUsed,
      before: draft === compiled.text ? null : draft,
    },
  });

  if (compiled.text !== draft) {
    await jobsRepo.updateJob(job.id, { validatedOutput: compiled.text });
  }

  await jobsRepo.updateJob(job.id, {
    resolvedContext: context
      ? { ...context, meta: { ...context.meta, quality: compiled.report } }
      : undefined,
  });
}

/**
 * The social quality gate.
 *
 * Everything it weighs has already been measured; this decides what to do about
 * it. Sending a borderline reply to a person is better than publishing it and
 * better than silently discarding it, so REVIEW is the default outcome for
 * anything that fails.
 */
export async function stepQualityGate(bundle: JobBundle): Promise<void> {
  const { job, policy } = bundle;
  if (!policy.voice.enabled) return;

  const report = (job.resolvedContext?.meta as { quality?: QualityReport } | undefined)?.quality;
  if (!report) return;

  await observability.emitTrace({
    jobId: job.id,
    agentId: bundle.agent.id,
    type: 'QUALITY_SCORED',
    level: report.outcome === 'accept' ? 'info' : 'warn',
    message: report.reason,
    data: {
      voice: report.voice.score,
      generic: report.generic.score,
      repetition: report.repetition.score,
      outcome: report.outcome,
      genericReasons: report.generic.reasons,
      repetitionMatched: report.repetition.matched,
    },
  });

  if (report.repetition.score > policy.voice.repetitionRewriteAbove) {
    await observability.emitTrace({
      jobId: job.id,
      agentId: bundle.agent.id,
      type: 'REPETITION_DETECTED',
      level: 'warn',
      message: report.repetition.reason ?? 'Too close to something already said.',
      data: { matched: report.repetition.matched, matchedAt: report.repetition.matchedAt },
    });
  }

  if (report.outcome !== 'accept') {
    throw PipelineError.review('quality_gate', report.reason);
  }
}

/**
 * Looks up anything the answer depends on that the model cannot know.
 *
 * "What is this about?" under a post from an hour ago is unanswerable from a
 * training set, and a model asked it anyway will invent something. Before this
 * step the only options were silence or a guess.
 *
 * Runs after context resolution, because what to look up is decided from the
 * conversation and not from the mention alone: the question is usually "what is
 * this", and "this" is the parent post.
 *
 * Nothing is looked up for an ordinary reply. Searching the web before every
 * message is slow, expensive, and no help at all in answering "nice one".
 */
export async function stepResearch(bundle: JobBundle): Promise<void> {
  const { job } = bundle;
  const context = job.resolvedContext;
  if (!context) return;

  const inventory = MediaInventory.safeParse((context.meta as { inventory?: unknown })?.inventory);
  const links = inventory.success ? inventory.data.links : [];
  const hasMedia = inventory.success && (inventory.data.media.length > 0 || Boolean(inventory.data.quoted));

  const byRules = whatToResearch({
    incoming: context.incomingText,
    parent: context.parentText,
    links,
    hasUnreadMedia: hasMedia,
  });

  // The rules are right about both ends of the range and blind in the middle,
  // where the question is what a sentence means rather than what it matches.
  // A cheap model settles it when one is configured; when one is not, or it is
  // slow, or it answers badly, the rules stand.
  const plan = await planLookups(bundle.agent.id, job.id, {
    incoming: context.incomingText,
    parent: context.parentText,
    hasMedia,
    links,
    deterministic: byRules,
  });
  const lookups = plan.lookups;

  // The answer is in the picture and the agent cannot see pictures.
  //
  // This is the quietest way for a reply to be wrong: everything succeeds, the
  // model writes something plausible about a screenshot nobody looked at, and
  // the only trace of the problem is one skipped media row. Somebody asked
  // "what did he roundtrip on?" under a trade screenshot and got an answer
  // assembled out of three articles about waking up at 3am.
  if (plan.needsImage && !(await hasVisionModel(bundle.agent.id))) {
    await observability.emitTrace({
      jobId: job.id,
      agentId: bundle.agent.id,
      type: 'MEDIA_RESOLVED',
      level: 'warn',
      message:
        'Answering this depends on the attached image, and this agent has no vision model. ' +
        'The reply will say it could not see it. Set a vision model under Intelligence.',
      data: { needsImage: true, visionConfigured: false },
    });
  }

  if (lookups.length === 0) {
    await observability.emitTrace({
      jobId: job.id,
      agentId: bundle.agent.id,
      type: 'RESEARCH_DONE',
      message:
        plan.decidedBy === 'model'
          ? 'Nothing here needed looking up; the model was asked and said so.'
          : 'Nothing here needed looking up.',
      data: { lookups: 0, decidedBy: plan.decidedBy, fellBackBecause: plan.fellBackBecause ?? null },
    });
    return;
  }

  // Searching needs a browser, which the channel owns. A channel without one
  // simply cannot, and the result says so rather than pretending it tried.
  const adapter = getChannelAdapter(job.channel);
  const search = adapter.lookUp
    ? async (query: string) => {
        const ctx = await adapterContext(bundle);
        const kind = lookups.find((l) => l.query === query)?.kind === 'link' ? 'link' : 'search';
        const found = await adapter.lookUp!(ctx, { query, kind });
        return found.map((item) => ({
          kind: kind as 'search' | 'link',
          query,
          source: kind === 'link' ? 'The page they linked' : 'Web search',
          title: item.title,
          summary: item.snippet,
          url: item.url,
          retrievedAt: new Date().toISOString(),
        }));
      }
    : undefined;

  const result = await research(lookups, { search });

  await jobsRepo.updateJob(job.id, {
    resolvedContext: { ...context, meta: { ...context.meta, research: result } },
  });
  bundle.job.resolvedContext = { ...context, meta: { ...context.meta, research: result } };

  await observability.emitTrace({
    jobId: job.id,
    agentId: bundle.agent.id,
    type: 'RESEARCH_DONE',
    level: result.findings.length === 0 && result.failed.length > 0 ? 'warn' : 'info',
    message: result.note,
    data: {
      // The reasons, not only the count: "looked up 2 things" tells nobody
      // whether it looked up the right two.
      // Which decided, as well as what: a plan and a pattern match look
      // identical once they are both a list of queries.
      decidedBy: plan.decidedBy,
      fellBackBecause: plan.fellBackBecause ?? null,
      lookups: lookups.map((l) => ({ kind: l.kind, query: l.query.slice(0, 80), reason: l.reason })),
      findings: result.findings.map((f) => ({ source: f.source, title: f.title.slice(0, 100), url: f.url })),
      failed: result.failed,
    },
  });
}
