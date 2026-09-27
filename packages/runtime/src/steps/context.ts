import type {
  NormalizedEvent,
  ResolvedContext,
} from '@xbam/shared/contracts';
import { MediaInventory } from '@xbam/shared/contracts';

import {
  PipelineError,
  createLogger,
  errorMessage,
  truncate,
} from '@xbam/shared';
import {
  conversations as conversationsRepo,
  jobs as jobsRepo,
  memories as memoriesRepo,
  observability,
  withTransaction,
} from '@xbam/database';
import { retrieveMemories } from '@xbam/memory';

import { getChannelAdapter } from '@xbam/channels';

import { resolveMedia } from '../mediaResolve';

import type { JobBundle } from '../loadJob';

import { adapterContext } from '../channelContext';
import { capacityClassForEvent, checkReadCapacity, noteXFailure, noteXRead } from '../capacity';

/**
 * Working out what arrived, and what the agent already knows about it.
 *
 * The three steps that run before anything is written: resolving the post and
 * its thread, reading whatever picture or quoted post came with it, and
 * retrieving the memories that bear on it. Nothing here calls a model to
 * produce an answer.
 */

const log = createLogger('steps');

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
  const readsX = bundle.job.actionType !== 'POST' && bundle.job.channel === 'x' && Boolean(bundle.job.accountId);
  const klass = capacityClassForEvent(bundle.event.type);

  /*
    Reading the thread is a read of X like any other, from the same budget.

    A reply to somebody who wrote in may use all of it, and waits only while
    the account needs a person. Broad work waits whenever the budget says so,
    and waiting is not failing: the gate's time goes to `waitForLimit`, which
    charges no attempt, so a keyword match held through a cooldown is still
    there, unspent, when the cooldown ends.
  */
  if (readsX) {
    const capacity = await checkReadCapacity(bundle.job.accountId!, klass, new Date(), {
      forReply: klass === 'DIRECT',
    }).catch(() => null);
    if (capacity && !capacity.allowed) {
      throw PipelineError.retryable('account_capacity', capacity.message, {
        retryAfterMs: capacity.retryAfterMs ?? 10 * 60_000,
      });
    }
  }

  let resolved: ResolvedContext;
  try {
    resolved =
      bundle.job.actionType === 'POST'
        ? selfOriginatedContext(bundle)
        : await adapter.resolveContext(ctx, eventToNormalized(bundle));
  } catch (error) {
    if (readsX) {
      await noteXRead(bundle.job.accountId!, klass);
      await noteXFailure(bundle.job.accountId!, klass, errorMessage(error));
    }
    throw error;
  }
  if (readsX) await noteXRead(bundle.job.accountId!, klass);

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
      // Stage timings from the adapter, when it measured them. Kept on the
      // trace so a slow read can be attributed without a log.
      timingsMs: (resolved.meta as { timingsMs?: unknown } | undefined)?.timingsMs ?? null,
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
/**
 * Notes what is attached, and describes it only for a post that will be answered.
 *
 * Measured on a live installation over three days: 426 vision calls, 364 of
 * them describing pictures under posts the agent then declined to answer,
 * against 118 replies actually written. The decision whether to answer does
 * not read the media at all (it reads the text, the thread, who is asking and
 * what the agent has said before), so describing first bought nothing for
 * every post that was going to be declined, which is most posts an agent
 * comes across.
 *
 * The graph still runs this node where it always did; stored pipelines are per
 * agent and moving the node would only have helped agents created afterwards.
 * What moved is the work: here the inventory is noted, and `ensureMediaResolved`
 * describes it at the first step after the decision to answer. A graph where
 * the decision already came earlier gets the description here, as before.
 */
export async function stepResolveMedia(bundle: JobBundle): Promise<void> {
  const context = bundle.job.resolvedContext;
  const decided = Boolean((context?.meta as { engagement?: unknown } | undefined)?.engagement);
  if (!decided && context && hasMediaToResolve(context)) {
    await jobsRepo.updateJob(bundle.job.id, {
      resolvedContext: { ...context, meta: { ...context.meta, mediaDeferred: true } },
    });
    await observability.emitTrace({
      jobId: bundle.job.id,
      agentId: bundle.agent.id,
      type: 'MEDIA_RESOLVED',
      message: 'Attachments noted; they are described only if this post is going to be answered.',
      data: { deferred: true },
    });
    return;
  }
  await resolveMediaNow(bundle);
}

/** Whether the post, or the post it leans on, carries anything to understand. */
function hasMediaToResolve(context: NonNullable<JobBundle['job']['resolvedContext']>): boolean {
  const meta = context.meta as { inventory?: unknown; parentInventory?: unknown } | undefined;
  const has = (value: unknown) => {
    const parsed = MediaInventory.safeParse(value);
    return parsed.success && (parsed.data.media.length > 0 || Boolean(parsed.data.quoted) || parsed.data.links.length > 0);
  };
  return has(meta?.inventory) || has(meta?.parentInventory);
}

/**
 * Describes deferred attachments, once, now that the post is being answered.
 *
 * Called at the start of every step that may read the description, so the
 * first of them to run does the work and the rest find it done. A job resumed
 * after a restart takes the same path.
 */
export async function ensureMediaResolved(bundle: JobBundle): Promise<void> {
  const meta = bundle.job.resolvedContext?.meta as { mediaDeferred?: boolean; mediaContext?: unknown } | undefined;
  if (!meta?.mediaDeferred || meta.mediaContext) return;
  await resolveMediaNow(bundle);
  const fresh = await jobsRepo.getJob(bundle.job.id);
  if (fresh?.resolvedContext) {
    const done = { ...fresh.resolvedContext, meta: { ...fresh.resolvedContext.meta, mediaDeferred: false } };
    await jobsRepo.updateJob(bundle.job.id, { resolvedContext: done });
    bundle.job.resolvedContext = done;
  }
}

async function resolveMediaNow(bundle: JobBundle): Promise<void> {
  const { job, policy } = bundle;
  const context = job.resolvedContext;
  const own = MediaInventory.safeParse((context?.meta as { inventory?: unknown })?.inventory);
  const parent = MediaInventory.safeParse((context?.meta as { parentInventory?: unknown })?.parentInventory);

  const empty = (i: typeof own) =>
    !i.success || (i.data.media.length === 0 && !i.data.quoted && i.data.links.length === 0);

  /*
    When the question is about the picture above.

    The adapter already reads the parent's attachments -- that is what
    `leansOnParent` is for -- and until now the only thing done with them was a
    line in the prompt saying "that post also carries 1 image. You have not seen
    the attachments, so do not describe them." Which is honest, and useless.

    Somebody asked "what did he roundtrip on?" under somebody else's screenshot.
    The image was found, its URL was recorded, and nothing ever looked at it,
    because this step only ever considered the mention's own attachments and a
    mention almost never has any. The answer was always in the post above.

    Only when the mention carries nothing itself, so the ordinary case is
    untouched and no reply pays for two rounds of vision.
  */
  const usingParent = empty(own) && !empty(parent);
  const inventory = usingParent ? parent : own;

  if (empty(inventory)) {
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
    // The text the media has to make sense of. For the parent's attachments
    // that is the mention, because the mention is what asked about them.
    text: context?.incomingText ?? '',
    inventory: inventory.data!,
    onParentPost: usingParent,
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
      : `Understood ${resolved.items.filter((i) => i.status === 'analyzed').length} of ${resolved.items.length} attached items${usingParent ? ' on the post above' : ''}.`,
    data: {
      items: resolved.items.map((i) => ({ kind: i.kind, status: i.status, description: i.description })),
      quoted: resolved.quoted ? { authorHandle: resolved.quoted.authorHandle } : null,
      links: resolved.links.map((l) => ({ url: l.url, resolution: l.resolution })),
      hasUnderstandingGap: resolved.hasUnderstandingGap,
      onParentPost: usingParent,
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
