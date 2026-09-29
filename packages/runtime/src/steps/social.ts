

import { KNOWN_AUTOMATED_HANDLES, type PolicyConfig, type RelationshipContext } from '@xbam/shared/contracts';
import {
  PipelineError,
} from '@xbam/shared';
import {
  accounts as accountsRepo,
  actions as actionsRepo,
  autonomy as autonomyRepo,
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
  audienceOf,
  decideEngagement,
  exchangeLimit,
  recentRepliesTo,
} from '../engagement';
import { asksToBeLeftAlone } from '../doNotContact';

import { loadThreadContext } from '../arcs';
import { mindForMessage } from '../deliberate';

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

  /*
    Somebody asking to be left alone, recorded the moment they say it.

    Deterministic, because "did they ask us to stop" is exactly the judgement
    an owner most needs to be able to inspect and correct, and one a model
    would answer differently on different days for a call nobody can audit.

    Recorded here rather than at the end because it has to hold even if this
    job then fails: the request was made whether or not the reply worked. It
    stops the agent approaching them; whether it answers *this* message is
    still the engagement heuristic's decision and the owner's policy, which is
    why nothing is thrown.
  */
  const askedToStop = asksToBeLeftAlone(context?.incomingText ?? bundle.event.text);
  if (askedToStop && loaded.context.handle) {
    await autonomyRepo
      .addDoNotContact({
        agentId: bundle.agent.id,
        channel: job.channel,
        handle: loaded.context.handle,
        remoteUserId: bundle.event.remoteAuthorId,
        source: 'THEY_ASKED',
        evidence: askedToStop.evidence,
        reason: askedToStop.reason,
      })
      .catch(() => undefined);
    await observability.emitTrace({
      jobId: job.id,
      agentId: bundle.agent.id,
      type: 'RELATIONSHIP_LOADED',
      level: 'warn',
      message: `@${loaded.context.handle} asked this agent to stop contacting them. It will not approach them again.`,
      data: { doNotContact: true, evidence: askedToStop.evidence },
    });
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

  /*
    What has been on the agent's mind, where it bears on this.

    Relevance-driven, and that is the whole of the rule. An agent may be uneasy
    about something all week without every reply mentioning it; internal state
    that leaks into unrelated conversations is worse than internal state
    nobody has, because it reads as an agent that cannot tell what it is
    talking about.

    A post is the exception and gets the strongest items whatever they are
    about: there is no incoming message for them to be relevant to, and "what
    has this agent been thinking about" is precisely the question an original
    post answers.
  */
  const mind = await mindForMessage(bundle.agent.id, text, bundle.job.actionType === 'POST');

  await observability.emitTrace({
    jobId: job.id,
    agentId: bundle.agent.id,
    type: 'STANCE_SELECTED',
    message:
      stanceContext.relevant.length > 0
        ? `Holds a position on ${stanceContext.relevant.map((s) => s.subject).join(', ')}.`
        : 'No existing position touches this.',
    data: {
      relevant: stanceContext.relevant,
      revised: stanceContext.revised,
      openCommitments: open.length,
      // Named rather than counted: "it brought two things it had been thinking
      // about" is only useful if a trace says which two.
      onItsMind: mind.map((item) => `${item.kind}: ${item.summary}`),
    },
  });

  if (context) {
    await jobsRepo.updateJob(job.id, {
      resolvedContext: {
        ...context,
        meta: { ...context.meta, stance: stanceContext, openCommitments: open, mind },
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
      // The same rule as the quality gate: an owner who has already approved
      // this has made the judgement, and a second opinion arriving after the
      // decision is not a reason to hand it back to them unchanged. The
      // conflict is on the record above either way.
      if (job.approvedAt) return;
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
/**
 * Whether a watched account's post is a fragment that only means something
 * inside the conversation it belongs to.
 *
 * A watch reads everything the account posts, including its replies to other
 * people: "yes", "+", "worst ever", "Dogs and Cats". Measured on the live
 * watch, about a third of what it recorded was that. Answering one under the
 * owner's instruction to reply to the watched account is the agent turning up
 * in somebody else's exchange with nothing to say about a word it cannot see
 * the context of. A short question in their own post is still a post, and so
 * is anything with a thought in it.
 */
export function watchedFragment(text: string, isReply: boolean): string | null {
  const words = text
    .replace(/@[A-Za-z0-9_]+/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  // A reply to somebody else leans on what it answers, so a little more of it
  // is still a fragment; a post of their own has to stand alone.
  if (words.length > (isReply ? 4 : 3)) return null;
  const asks = /\?\s*$/.test(text.trim());
  if (!isReply && asks) return null;
  return `"${text.trim().slice(0, 40)}" is ${isReply ? 'a short reply to somebody else' : 'a fragment'} that only means something inside its own conversation. The watch stands; there is nothing here to add to.`;
}

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
  // radar reconciler assigns to a post discovered through a watched keyword,
  // and speaking under one of those is speaking first to a stranger -- a
  // different act from answering, held to its own bar.
  //
  // A thread the agent is already in is not this: it is a conversation it is
  // part of, whatever the event type says, so an outbound message anywhere in
  // the thread settles it.
  //
  // TARGET_ACCOUNT_ACTIVITY is deliberately absent. An account the owner named
  // is not a stranger, and the whole of this branch -- the higher value floor,
  // the topic-match requirement, the days-long per-author cooldown -- exists to
  // stop an agent pestering people it came across by accident. Applying it to a
  // followed account is what silenced one for four days.
  /*
    How far into this exchange the agent is, counted two ways and the larger
    believed: the agent's own turns among the posts X rendered above this one,
    and the unbroken chain of its published replies that leads here. The
    rendered count alone was the whole of it once, and X collapses a long
    chain, so eight replies deep with @grok it read as one, then two, then one.
  */
  const renderedTurns = (context?.thread ?? []).filter((m) => m.role === 'OUTBOUND').length;
  const parentRemoteId = context?.conversation?.parent?.remoteId ?? bundle.event.parentRemoteMessageId ?? null;
  const chainTurns = await actionsRepo.publishedReplyChain(bundle.agent.id, parentRemoteId).catch(() => 0);
  const ourTurns = Math.max(renderedTurns, chainTurns);
  // A back-and-forth of n turns is at least 2n messages, whatever was rendered.
  const threadDepth = Math.max(context?.thread.length ?? 0, 2 * ourTurns);
  const counterpartAutomated = await isAutomatedCounterpart(job.channel, handle, policy, bundle.account?.handle);
  const recentToPerson = await recentRepliesTo(bundle.agent.id, handle);

  const alreadyInThread = ourTurns > 0;
  const unprompted = bundle.event.type === 'KEYWORD_MATCH' && !directlyAddressed && !alreadyInThread;

  // The two limits that are about rate rather than about worth, checked here
  // rather than in the heuristic because reaching one is a reason not to speak,
  // not a score. And recorded as a decision rather than a failure: a cap that
  // has been reached is not something to retry an hour later, because by then
  // the post is old and approaching it is stranger than not.
  const outreachLimit =
    unprompted && policy.outreach.enabled ? await outreachHeadroom(bundle.agent.id, policy.outreach, handle) : null;
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

  /*
    A tracked account is an explicit instruction to respond, not a discovery
    hint to feed back through the ordinary "is this worth answering?" score.

    Before this branch, the watch reliably created a job but a plain update
    such as "shipping today" could still score below the general reply floor
    and disappear as IGNORE. That made the owner's most specific instruction
    weaker than the generic heuristic. The watch now settles that judgement.

    Do-not-contact remains supreme. A public watch is not authority to resume
    approaching somebody who asked the agent to stop, and relationship blocks,
    account health, action-rate, idempotency and platform failures continue to
    be enforced by their existing hard gates.
  */
  const ownerTarget = bundle.event.type === 'TARGET_ACCOUNT_ACTIVITY';
  const targetDoNotContact =
    ownerTarget && handle
      ? await autonomyRepo.findDoNotContact(bundle.agent.id, job.channel, handle).catch(() => null)
      : null;
  if (targetDoNotContact) {
    const reason = `@${handle!.replace(/^@+/, '')} asked this agent to stop contacting them, so the tracked-account instruction cannot reply.`;
    await observability.emitTrace({
      jobId: job.id,
      agentId: bundle.agent.id,
      type: 'ENGAGEMENT_DECIDED',
      level: 'warn',
      message: `ignore: ${reason}`,
      data: { decision: 'IGNORE', ownerTarget: true, doNotContact: true },
    });
    return 'ignore';
  }

  /*
    Chosen by the owner is not the same as without limit.

    The watch settles whether a post is worth answering, and nothing about
    topic, value or the stranger cooldown can override it. What still applies
    is fatigue, because it is about how the agent looks rather than about the
    post: answering every post somebody makes within the hour reads as an
    account shadowing them, and a fourth turn in one thread is an agent that
    will not let it end. Either one leaves this post alone with a sentence
    saying so, and the next post an hour later is answered as usual.
  */
  const targetFatigue = ownerTarget
    ? await (async () => {
        const fragment = watchedFragment(text, Boolean(context?.parentText?.trim()) || Boolean(bundle.event.parentRemoteMessageId));
        if (fragment) return fragment;
        // The same limits every other reply is held to, as stops.
        const limit = exchangeLimit({
          recentRepliesToPerson: recentToPerson,
          ourRepliesInThread: ourTurns,
          threadDepth,
          counterpartAutomated,
          policy: policy.engagement,
        });
        return limit ? `${limit} The watch stands; this post is left alone.` : null;
      })()
    : null;

  const verdict = ownerTarget
    ? targetFatigue
      ? {
          decision: 'IGNORE' as const,
          value: 0,
          reason: targetFatigue,
          factors: [{ label: 'owner-designated tracked account, but fatigue applies', delta: 0 }],
        }
      : {
          decision: 'ENGAGE' as const,
          value: 100,
          reason: 'The owner explicitly chose this account to watch and reply to.',
          factors: [{ label: 'owner-designated tracked account', delta: 100 }],
        }
    : decideEngagement({
        // Read only on the unprompted path. Somebody who wrote to the agent is
        // answered whoever they are, however few people follow them.
        ...(unprompted ? audienceOf(bundle.event.payload) : {}),
        ...(unprompted && handle
          ? { approachHistory: await actionsRepo.approachHistory(bundle.agent.id, handle).catch(() => null) }
          : {}),
        topics: bundle.persona.topics,
        text,
        directlyAddressed,
        unprompted,
        outreach: policy.outreach,
        relationship,
        threadDepth,
        recentRepliesToPerson: recentToPerson,
        alreadyRepliedInThread: alreadyInThread,
        // Not whether the agent has spoken here, but how often. One follow-up is a
        // conversation; four is an agent that will not let a thread end.
        ourRepliesInThread: ourTurns,
        counterpartAutomated,
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
      ownerTarget,
    },
  });

  if (context) {
    await jobsRepo.updateJob(job.id, {
      resolvedContext: { ...context, meta: { ...context.meta, engagement: verdict } },
    });
  }

  if (verdict.decision === 'IGNORE') {
    // The reason goes on the job, so everything that reads a settled job,
    // the watched-account disposition included, says why rather than only
    // that it was left alone.
    await jobsRepo.updateJob(job.id, { lastError: verdict.reason.slice(0, 500) });
    return 'ignore';
  }
  if (verdict.decision === 'REVIEW') return 'review';
  return 'engage';
}

/**
 * Whether the account being answered is itself automated: one AI17Z knows is a
 * reply bot, one the owner listed, or another agent on this installation. Two
 * of those answer each other for ever unless one of them stops.
 */
async function isAutomatedCounterpart(
  channel: string,
  handle: string | null | undefined,
  policy: PolicyConfig,
  ownHandle: string | null | undefined,
): Promise<boolean> {
  const norm = (h: string | null | undefined) => (h ?? '').replace(/^@+/, '').trim().toLowerCase();
  const who = norm(handle);
  if (!who || who === norm(ownHandle)) return false;
  const listed = [...(KNOWN_AUTOMATED_HANDLES[channel] ?? []), ...policy.engagement.automatedHandles].map(norm);
  if (listed.includes(who)) return true;
  // Read only when the lists did not settle it, and a failed read is not a
  // reason to treat a person as a bot.
  const siblings = await accountsRepo.allAccounts().catch(() => []);
  return siblings.some((account) => account.channel === channel && norm(account.handle) === who);
}

/**
 * Whether an unprompted approach is allowed to happen at all right now.
 *
 * Returns the reason it is not, or null when there is room. Both limits are
 * counted from what was actually published: a dry run approached nobody, and a
 * draft that was never sent is not an approach.
 */
export async function outreachHeadroom(
  agentId: string,
  outreach: PolicyConfig['outreach'],
  handle: string | null,
  channel = 'x',
): Promise<string | null> {
  /*
    Somebody who asked to be left alone, first, before any budget arithmetic.

    Durable, so it survives a restart and an upgrade, and checked here because
    this is the one function every unprompted approach goes through. Answering
    them if they write in is a different decision and is not gated here: this
    stops the agent speaking to them first, which is exactly what they asked.
  */
  if (handle) {
    const listed = await autonomyRepo.findDoNotContact(agentId, channel, handle).catch(() => null);
    if (listed) {
      return `@${handle.replace(/^@+/, '')} asked this agent to stop contacting them${
        listed.createdAt ? ` on ${listed.createdAt.slice(0, 10)}` : ''
      }, so it will not approach them.`;
    }
  }

  const sinceHour = new Date(Date.now() - 60 * 60_000).toISOString();
  const thisHour = await actionsRepo.approachesSince(agentId, sinceHour);
  if (thisHour >= outreach.maxPerHour) {
    return `Already approached ${thisHour} ${thisHour === 1 ? 'person' : 'people'} unprompted in the last hour, which is the limit. It will resume as the rolling hour clears.`;
  }

  const sinceDay = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const today = outreach.maxPerDay > 0 ? await actionsRepo.approachesSince(agentId, sinceDay) : 0;
  if (outreach.maxPerDay > 0 && today >= outreach.maxPerDay) {
    return `Already approached ${today} ${today === 1 ? 'person' : 'people'} unprompted today, which is the limit.`;
  }

  /*
    A proposal the owner has not answered is an approach in waiting.

    The budget above counts what was published, which is the correct meaning of
    "approaches made today" and the wrong thing to ask before writing another
    one. An agent set to REVIEW publishes nothing, so that count is zero for
    ever and there is no back pressure at all: measured on a live installation,
    one hundred and five proposals waiting and rising by seventeen an hour, for
    an agent permitted five approaches a day.

    Stockpiling is not the same as approaching, so this is not a second budget
    with a second number to tune -- it is the same allowance, applied to what
    is outstanding. Propose a few, wait for a decision, propose a few more.
    Answering any of them makes room immediately.
  */
  const waiting = await actionsRepo.pendingApproaches(agentId);
  const waitingLimit = outreach.maxPerDay > 0 ? outreach.maxPerDay : outreach.maxPerHour;
  if (waiting >= waitingLimit) {
    return `${waiting} unprompted approaches are already waiting for you to decide on, which is the configured allowance. Answering some of those makes room for new ones.`;
  }

  if (handle && outreach.cooldownDaysPerAuthor > 0) {
    const last = await actionsRepo.lastApproachTo(agentId, handle);
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
