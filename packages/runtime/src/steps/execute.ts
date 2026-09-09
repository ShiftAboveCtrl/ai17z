import type { Capability } from '@xbam/shared/contracts';

import {
  PipelineError,
  contentSignature,
  truncate,
} from '@xbam/shared';
import {
  actions as actionsRepo,
  agents as agentsRepo,
  capabilities as capabilitiesRepo,
  conversations as conversationsRepo,
  jobs as jobsRepo,
  legacyLedger,
  observability,
  ops,
  radar as radarRepo,
  relationships as relationshipsRepo,
  stances as stancesRepo,
  voice as voiceRepo,
  withTransaction,
} from '@xbam/database';
import { applyWritePolicy } from '@xbam/memory';

import { getChannelAdapter } from '@xbam/channels';

import { recordExchange } from '../relationship';
import {
  detectClaims,
  learnStancesFromOwnPost,
} from '../stance';

import {
  observeEntities,
  recordNarratives,
} from '../arcs';
import {
  harvestIdeas,
  markIdeaUsed,
} from '../content';

import {
  DEFAULT_FOLLOW_UP_MS,
  canFollowUp,
} from '../followUp';
import { remoteActionsAllowed } from '../killSwitch';
import type { JobBundle } from '../loadJob';

import { checkActionRate } from '../policyGate';

import { adapterContext } from '../channelContext';

/**
 * Sending it, and recording what happened.
 *
 * The only step that touches a remote service, and the largest by some way,
 * because everything that can be got wrong once is guarded here: the
 * capability re-check that a queued job cannot outrun, duplicate suppression,
 * the kill switch, and the read-back that decides whether an action that
 * looked ambiguous actually went out.
 */

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

/**
 * Records the turn, and remembers what was said in it.
 *
 * A rehearsal records the half that happened. Somebody really did send the
 * message, so it is worth remembering; the agent did not send a reply, so its
 * draft is not something it said.
 *
 * This was not enforced here and it caused a wrong answer in front of me. The
 * same job was rehearsed four times while a media bug was being fixed, and each
 * rehearsal wrote its draft into thread memory as "me: I can't see the image".
 * By the fourth run the vision model was working, the picture was described
 * correctly in the prompt, and the agent read its own three unsent drafts above
 * it and wrote "Still can't see the image". It was being consistent with
 * something it had never said.
 *
 * The rule already existed for relationships and stances -- learned from what
 * was published, never from a dry run -- and the transcript and thread memory
 * were the two places it was not applied.
 */
export async function persistTurnAndMemory(bundle: JobBundle, outgoing: string, remoteMessageId: string | null): Promise<void> {
  const published = !bundle.job.dryRun;

  if (bundle.job.conversationId && published) {
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
    {
      incomingText: bundle.job.resolvedContext?.incomingText ?? bundle.event.text,
      // The draft of a reply that was never sent is not a thing the agent said.
      outgoingText: published ? outgoing : '',
    },
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

  // The global pause, checked here and not earlier.
  //
  // This is the last moment before anything leaves the machine, and the race
  // the switch exists for is precisely a job that was already validated when
  // somebody pressed stop. A check at the top of the pipeline would leave a
  // window of exactly the length of the pipeline, which is the window that
  // matters. A dry run is exempt because it reaches nobody.
  if (!job.dryRun) {
    const gate = await remoteActionsAllowed();
    if (!gate.allowed) {
      await observability
        .emitTrace({
          jobId: job.id,
          agentId: bundle.agent.id,
          type: 'ACTION_BLOCKED',
          level: 'warn',
          message: gate.reason,
          data: { actionId: action.id, reason: 'paused_globally' },
        })
        .catch(() => undefined);
      // Retryable, not permanent: releasing the pause should let this go out,
      // and a job stopped by a person is not a job that failed.
      throw PipelineError.retryable('paused_globally', gate.reason, { retryAfterMs: 60_000 });
    }
  }

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

    // A post that went out spends the idea it came from, immediately, so the
    // backlog and the history are right without waiting for a sweep. The
    // reconciler covers the case where this line never runs.
    if (result.status !== 'DRY_RUN') {
      const ideaId = (context?.meta as { ideaId?: string } | undefined)?.ideaId;
      if (ideaId) await markIdeaUsed(bundle.agent.id, ideaId, job.id).catch(() => undefined);
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
        // A promise is only tracked when it can actually be kept.
        //
        // An agent that cannot reply through any account will never follow up,
        // and recording a due date for it would produce a row that looks like
        // tracking and is not -- which is worse than no row, because somebody
        // reads it and believes it. So the commitment is still remembered, and
        // the date that makes something a scheduled follow-up is only set when
        // following up is possible.
        const able = await canFollowUp(bundle.agent.id).catch(() => ({ able: false, why: 'Could not be checked.' }));
        await stancesRepo
          .recordCommitment({
            agentId: bundle.agent.id,
            promise: claims.commitment.promise,
            confidence: claims.commitment.confidence,
            recipientHandle: context?.targetAuthorHandle ?? bundle.event.remoteAuthorHandle,
            jobId: job.id,
            remoteUrl: result.remoteActionUrl,
            conversationId: job.conversationId,
            sourceEventId: bundle.event.id,
            dueAt: able.able ? new Date(Date.now() + DEFAULT_FOLLOW_UP_MS).toISOString() : null,
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
