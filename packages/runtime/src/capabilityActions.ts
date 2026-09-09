import type { ActionType } from '@xbam/shared/contracts';
import { PipelineError, createLogger, sha256Hex } from '@xbam/shared';
import { accounts as accountsRepo, actions as actionsRepo } from '@xbam/database';
import { getChannelAdapter, type ChannelContext } from '@xbam/channels';
import { buildChannelContext } from './channelContext';

const log = createLogger('capability-action');

/**
 * A remote action a model asked for, performed the way every other one is.
 *
 * The temptation with a write capability is to let it call the browser. That
 * would be a second execution path beside the one that took months to harden --
 * and the hardening is not in `stepExecute`, it is in the pieces this uses:
 * `claimAction`'s partial unique index on the idempotency key, the stale-retake
 * rule, `wasAlreadyDone` asking the remote before acting again, and
 * `executeAction` navigating to its own target and reading the result back.
 *
 * So this is not a new way to act. It is the same way, reached from somewhere
 * else, and the only thing it adds is the key: a capability write gets its own
 * idempotency key derived from the job's, so a retried job does not act twice
 * and two different capability calls in one job do not collide.
 */
export interface CapabilityActionRequest {
  agentId: string;
  jobId: string;
  accountId: string;
  capabilityId: string;
  type: ActionType;
  /** The immutable remote identity being acted on. Never a position. */
  targetRef: string;
  text: string;
  /** The job's own key, which this one is derived from. */
  jobIdempotencyKey: string;
  dryRun: boolean;
}

export interface CapabilityActionResult {
  performed: boolean;
  /** True when the remote already had it and nothing was sent again. */
  alreadyDone: boolean;
  remoteActionId: string | null;
  remoteActionUrl: string | null;
  detail: string;
}

/**
 * One key per capability, per target, per job.
 *
 * Derived from the job's rather than invented, so the whole family of actions a
 * job produces stays traceable to it. Two calls to the same capability against
 * the same target inside one job are the same action by construction -- which
 * is what stops a model that asks twice acting twice.
 */
export function capabilityIdempotencyKey(input: {
  jobIdempotencyKey: string;
  capabilityId: string;
  targetRef: string;
}): string {
  return `${input.jobIdempotencyKey}|cap:${input.capabilityId}|${input.targetRef}`;
}

export async function performCapabilityAction(
  request: CapabilityActionRequest,
): Promise<CapabilityActionResult> {
  const account = await accountsRepo.getAccount(request.accountId);
  if (!account) throw PipelineError.permanent('account_missing', 'The account for this action no longer exists.');
  const adapter = getChannelAdapter(account.channel);
  const idempotencyKey = capabilityIdempotencyKey(request);

  const claim = await actionsRepo.claimAction({
    jobId: request.jobId,
    agentId: request.agentId,
    accountId: request.accountId,
    channel: account.channel,
    type: request.type,
    dryRun: request.dryRun,
    idempotencyKey,
    payload: { text: request.text, targetRef: request.targetRef, capabilityId: request.capabilityId },
    targetRef: request.targetRef,
  });

  // Somebody already did this. Not an error and not a reason to do it again.
  if (claim.outcome === 'ALREADY_EXECUTED') {
    return {
      performed: false,
      alreadyDone: true,
      remoteActionId: claim.action.remoteActionId,
      remoteActionUrl: claim.action.remoteActionUrl,
      detail: 'This was already done.',
    };
  }
  if (claim.outcome === 'IN_PROGRESS') {
    return {
      performed: false,
      alreadyDone: false,
      remoteActionId: null,
      remoteActionUrl: null,
      detail: 'Something else is already doing this.',
    };
  }

  const action = claim.action;
  const context = await buildChannelContext(account, request.jobId);

  /**
   * A worker died with this EXECUTING, so the remote is asked before the
   * action is taken again.
   *
   * A worker can die before X saw it or after, and local state cannot tell the
   * two apart. Without this the recovery path is a duplicate-post machine --
   * which is the reason the reply path has had this check since the day an
   * action was first retaken.
   */
  if (claim.retakenFromStale && !request.dryRun && adapter.wasAlreadyDone) {
    const already = await adapter
      .wasAlreadyDone(context, {
        type: request.type,
        targetRef: request.targetRef,
        text: request.text,
        idempotencyKey,
        dryRun: false,
      })
      .catch(() => null);

    if (already?.done) {
      await actionsRepo.completeAction(action.id, {
        status: 'EXECUTED',
        remoteActionId: already.remoteActionId,
        remoteActionUrl: already.remoteActionUrl,
        contentSignature: signatureFor(request),
      });
      log.warn('a capability action was already done on the remote', {
        capabilityId: request.capabilityId,
        remoteActionId: already.remoteActionId,
      });
      return {
        performed: false,
        alreadyDone: true,
        remoteActionId: already.remoteActionId,
        remoteActionUrl: already.remoteActionUrl,
        detail: already.detail,
      };
    }
  }

  return runAction(adapter, context, action.id, request, idempotencyKey);
}

async function runAction(
  adapter: ReturnType<typeof getChannelAdapter>,
  context: ChannelContext,
  actionId: string,
  request: CapabilityActionRequest,
  idempotencyKey: string,
): Promise<CapabilityActionResult> {
  const outgoing = {
    type: request.type,
    targetRef: request.targetRef,
    text: request.text,
    idempotencyKey,
    dryRun: request.dryRun,
  };

  // Verification and execution are separate calls, and `executeAction`
  // navigates to its own target: anything can have used the action tab in
  // between, and acting on whatever happens to be loaded is how an automation
  // replies to the wrong post.
  const verification = await adapter.verifyAction(context, outgoing);
  if (!verification.verified) {
    await actionsRepo.completeAction(actionId, {
      status: 'FAILED',
      errorClass: 'PERMANENT',
      lastError: verification.detail,
      verification: verification as unknown as Record<string, unknown>,
    });
    throw PipelineError.permanent('target_verification_failed', verification.detail);
  }

  if (request.dryRun) {
    await actionsRepo.completeAction(actionId, {
      status: 'DRY_RUN',
      verification: verification as unknown as Record<string, unknown>,
    });
    return {
      performed: false,
      alreadyDone: false,
      remoteActionId: null,
      remoteActionUrl: null,
      detail: 'Verified the target and stopped, because this was a dry run.',
    };
  }

  try {
    const result = await adapter.executeAction(context, outgoing);
    await actionsRepo.completeAction(actionId, {
      status: 'EXECUTED',
      remoteActionId: result.remoteActionId,
      remoteActionUrl: result.remoteActionUrl,
      contentSignature: signatureFor(request),
      verification: result.verification as unknown as Record<string, unknown>,
    });
    return {
      performed: true,
      alreadyDone: false,
      remoteActionId: result.remoteActionId,
      remoteActionUrl: result.remoteActionUrl,
      // The adapter's own words about what it confirmed, which is what the
      // model should be told rather than a cheerful summary of it.
      detail: result.verification.detail || 'Done.',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await actionsRepo.completeAction(actionId, {
      status: 'FAILED',
      errorClass: error instanceof PipelineError ? error.errorClass : 'RETRYABLE',
      lastError: message,
    });
    throw error;
  }
}

/**
 * What was said, for the duplicate-text check.
 *
 * An action with no text of its own -- a like, a repost -- signs its target
 * instead, so "already did this to this post" is still answerable.
 */
function signatureFor(request: CapabilityActionRequest): string {
  return sha256Hex(`${request.type}|${request.text || request.targetRef}`);
}
