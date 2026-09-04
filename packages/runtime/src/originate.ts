import type { ActionType } from '@xbam/shared/contracts';
import { createLogger, sha256Hex } from '@xbam/shared';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  events as eventsRepo,
  jobs as jobsRepo,
  observability,
  posting as postingRepo,
  prompts as promptsRepo,
  withTransaction,
} from '@xbam/database';
import { getChannelAdapter } from '@xbam/channels';
import { nextPost, releaseIdea } from './content';

const log = createLogger('originate');

/**
 * Saying something nobody asked for.
 *
 * Everything else in the runtime starts with an inbound event. A post of the
 * agent's own starts with a decision, so this manufactures the event that
 * decision corresponds to — type SCHEDULED_TRIGGER, carrying the brief — and
 * lets the rest of the pipeline work exactly as it does for a reply. Memory,
 * persona, voice, anti-repetition, and the quality gate all apply, because the
 * post goes through the same ten steps.
 *
 * The important restraint: nothing is invented to fill a slot. If the backlog
 * has no idea worth using, the schedule records that it looked and found
 * nothing. An agent with nothing to say saying nothing is correct behaviour,
 * and it is the difference between a character and a content generator.
 */

export interface OriginateResult {
  posted: boolean;
  reason: string;
  jobId: string | null;
}

export async function originatePost(input: {
  /** Overrides the policy default, the way ingest does for a reply. */
  dryRun?: boolean;
  agentId: string;
  accountId: string | null;
}): Promise<OriginateResult> {
  const agent = await agentsRepo.getAgent(input.agentId);
  if (!agent) return { posted: false, reason: 'The agent no longer exists.', jobId: null };
  if (agent.state !== 'ACTIVE') {
    return { posted: false, reason: `The agent is ${agent.state.toLowerCase()}, so it is not posting.`, jobId: null };
  }

  const policy = await agentsRepo.getActivePolicy(agent.id);
  if (!policy) return { posted: false, reason: 'The agent has no policy version.', jobId: null };
  const mode = policy.config.automation.mode;
  if (mode === 'OFF' || mode === 'MONITOR_ONLY') {
    return { posted: false, reason: `Automation is ${mode.toLowerCase().replace(/_/g, ' ')}.`, jobId: null };
  }

  if (!input.accountId) {
    return { posted: false, reason: 'No account is connected for this agent to post through.', jobId: null };
  }

  // The backlog decides whether there is a post, not the clock.
  const brief = await nextPost(agent.id);
  if (!brief) {
    return { posted: false, reason: 'Nothing in the idea backlog was worth posting.', jobId: null };
  }

  const template = await promptsRepo.getActiveTemplate('reply.default');
  if (!template) {
    await releaseIdea(agent.id, brief.idea.id);
    return { posted: false, reason: 'The prompt template is missing.', jobId: null };
  }

  const account = await accountsRepo.getAccount(input.accountId);
  if (!account) return { posted: false, reason: 'The account no longer exists.', jobId: null };
  const channel = account.channel;
  const actionType: ActionType = 'POST';
  const dryRun = input.dryRun ?? policy.config.automation.dryRunDefault;
  // One *real* job per idea, forever. If the worker dies between creating the
  // job and recording the attempt, the retry finds the same key and does not
  // post twice.
  //
  // A rehearsal gets its own id. The real key is anchored to the idea, so
  // without this a dry run took it and the real post that followed was refused
  // as a duplicate of something that never went out -- permanently, and
  // silently, which is the worst way for a guarantee to fail. It is the same
  // reasoning as the partial unique index on `actions`: a rehearsal must not
  // spend anything the real action needs.
  const remoteEventId = dryRun ? `post:${brief.idea.id}:rehearsal` : `post:${brief.idea.id}`;
  const idempotencyKey = sha256Hex(`${channel}:${input.accountId}:${remoteEventId}:${actionType}:${agent.id}`);

  const outcome = await withTransaction(async (tx) => {
    const { event } = await eventsRepo.ingestEvent(tx, input.accountId, {
      channel,
      type: 'SCHEDULED_TRIGGER',
      remoteEventId,
      remoteMessageId: null,
      remoteAuthorId: null,
      remoteAuthorHandle: null,
      remoteAuthorDisplayName: null,
      remoteConversationId: null,
      parentRemoteMessageId: null,
      remoteUrl: null,
      // The brief is what generation reads in place of an incoming message.
      text: brief.brief,
      occurredAt: new Date().toISOString(),
      raw: { origin: 'self', ideaId: brief.idea.id, ideaSummary: brief.idea.summary },
    });

    return jobsRepo.createJob(tx, {
      eventId: event.id,
      agentId: agent.id,
      accountId: input.accountId!,
      channel,
      actionType,
      idempotencyKey,
      // The same rule as every other action: the policy decides.
      //
      // This used to be a hardcoded `false`, on the reasoning that "a post is a
      // real action or it is nothing; there is no target to dry-run against".
      // Both halves are wrong. A dry run produces the text without publishing
      // it, which is exactly what somebody wants before letting an agent post
      // unattended -- more so than for a reply, because nobody prompted it. And
      // an agent set to rehearse everything would have published anyway, which
      // makes the dry-run guarantee conditional on which path the work took.
      dryRun,
      maxAttempts: policy.config.safety.maxAttempts,
      personaVersionId: agent.personaVersionId,
      policyVersionId: agent.policyVersionId,
      pipelineVersionId: agent.pipelineVersionId,
      promptTemplateVersionId: template.id,
      conversationId: null,
      requiresBrowser: getChannelAdapter(channel).requiresBrowser,
    });
  });

  if (!outcome.created) {
    await releaseIdea(agent.id, brief.idea.id);
    return { posted: false, reason: 'A job for this idea already exists.', jobId: outcome.job.id };
  }

  await observability.emitTrace({
    jobId: outcome.job.id,
    agentId: agent.id,
    type: 'JOB_CREATED',
    message: `Decided to post: ${brief.idea.summary.slice(0, 120)}`,
    data: { origin: 'self', ideaId: brief.idea.id, actionType, idempotencyKey },
  });

  // A rehearsal does not spend the idea.
  //
  // Same reasoning as stances and relationships being learned only from what
  // was published: a dry run said nothing, so the thing it might have said is
  // still unsaid. Consuming it means the first real post after a rehearsal
  // finds an empty backlog and stays quiet for a reason that is not true --
  // and it makes the rehearsal itself unrepeatable, which is most of what a
  // rehearsal is for.
  if (dryRun) await releaseIdea(agent.id, brief.idea.id);

  log.info('post originated', { agentId: agent.id, ideaId: brief.idea.id, jobId: outcome.job.id, dryRun });
  return { posted: true, reason: `Posting: ${brief.idea.summary.slice(0, 200)}`, jobId: outcome.job.id };
}

/** One pass over the schedules that have come due. */
export async function runDuePosts(limit: number): Promise<OriginateResult[]> {
  const due = await postingRepo.claimDue(limit);
  const results: OriginateResult[] = [];
  for (const row of due) {
    const result = await originatePost({ agentId: row.agentId, accountId: row.accountId });
    await postingRepo.recordAttempt(row.agentId, result.reason, result.jobId);
    results.push(result);
  }
  return results;
}
