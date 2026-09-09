

import type { RelationshipContext } from '@xbam/shared/contracts';
import {
  PipelineError,
} from '@xbam/shared';
import {
  actions as actionsRepo,
  jobs as jobsRepo,
  observability,
  stances as stancesRepo,
} from '@xbam/database';

import { loadRelationshipContext } from '../relationship';
import {
  checkStanceConsistency,
  loadStanceContext,
} from '../stance';
import {
  decideEngagement,
  recentRepliesTo,
} from '../engagement';

import { loadThreadContext } from '../arcs';

import type { JobBundle } from '../loadJob';

/**
 * Who this is, what the agent has said before, and whether to answer at all.
 *
 * Silence is a branch here rather than a failure: `stepEngagement` has three
 * wired outcomes and a decision not to reply ends the job with its reasons
 * recorded. The rest is memory of people and of positions -- both learned only
 * from what was actually published.
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

  // Found by watching rather than sent to the agent. KEYWORD_MATCH is what the
  // radar reconciler assigns to a post discovered through a watched account or
  // keyword, and speaking under one of those is speaking first to a stranger --
  // a different act from answering, held to its own bar.
  //
  // A thread the agent is already in is not this: it is a conversation it is
  // part of, whatever the event type says, so an outbound message anywhere in
  // the thread settles it.
  const alreadyInThread = (context?.thread ?? []).some((m) => m.role === 'OUTBOUND');
  const unprompted = bundle.event.type === 'KEYWORD_MATCH' && !directlyAddressed && !alreadyInThread;

  // The two limits that are about rate rather than about worth, checked here
  // rather than in the heuristic because reaching one is a reason not to speak,
  // not a score. And recorded as a decision rather than a failure: a cap that
  // has been reached is not something to retry an hour later, because by then
  // the post is old and approaching it is stranger than not.
  const outreachLimit = unprompted && policy.outreach.enabled ? await outreachHeadroom(bundle, handle) : null;
  if (outreachLimit) {
    await observability.emitTrace({
      jobId: job.id,
      agentId: bundle.agent.id,
      type: 'ENGAGEMENT_DECIDED',
      level: 'info',
      message: `ignore: ${outreachLimit}`,
      data: { decision: 'IGNORE', unprompted: true, limit: true },
    });
    return 'ignore';
  }

  const verdict = decideEngagement({
    topics: bundle.persona.topics,
    text,
    directlyAddressed,
    unprompted,
    outreach: policy.outreach,
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
    data: {
      decision: verdict.decision,
      value: verdict.value,
      factors: verdict.factors,
      strategy: policy.engagement.strategy,
      // Which set of rules decided, because the two have different thresholds
      // and a verdict is unreadable without knowing which one it came from.
      unprompted,
    },
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
 * Whether an unprompted approach is allowed to happen at all right now.
 *
 * Returns the reason it is not, or null when there is room. Both limits are
 * counted from what was actually published: a dry run approached nobody, and a
 * draft that was never sent is not an approach.
 */
async function outreachHeadroom(bundle: JobBundle, handle: string | null): Promise<string | null> {
  const { outreach } = bundle.policy;

  if (outreach.maxPerDay === 0) return 'This agent is not set to approach anybody unprompted.';
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const today = await actionsRepo.approachesSince(bundle.agent.id, since);
  if (today >= outreach.maxPerDay) {
    return `Already approached ${today} ${today === 1 ? 'person' : 'people'} unprompted today, which is the limit.`;
  }

  if (handle && outreach.cooldownDaysPerAuthor > 0) {
    const last = await actionsRepo.lastApproachTo(bundle.agent.id, handle);
    if (last) {
      const days = (Date.now() - Date.parse(last)) / 86_400_000;
      if (Number.isFinite(days) && days < outreach.cooldownDaysPerAuthor) {
        const waitDays = Math.ceil(outreach.cooldownDaysPerAuthor - days);
        return `Already approached @${handle.replace(/^@+/, '')} unprompted in the last ${outreach.cooldownDaysPerAuthor} days. ${waitDays} to go.`;
      }
    }
  }

  return null;
}

/**
 * Picks what kind of reply this should be, before anything is generated.
 *
 * Answering a joke with an explanation, or a challenge with a definition, is
 * the sort of thing that makes an agent read as a machine. Choosing the social
 * act first is what prevents it.
 */
