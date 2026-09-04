/**
 * Keeping a promise the agent made.
 *
 * An agent that says "I'll check this later" and never does is worse than one
 * that says nothing: the sentence is a small lie that the system then forgets
 * it told. Commitments were already detected and recorded -- and then nothing
 * ever looked at them, because no due date was set and nothing read the table.
 *
 * The follow-up is an ordinary job. A commitment coming due manufactures a
 * SCHEDULED_TRIGGER event carrying its brief, exactly as an original post does,
 * so it runs the same ten pipeline steps and inherits every guarantee they
 * already have. That is the whole reason not to build a second scheduler: the
 * one that exists already knows about leases, idempotency, dry runs, capability
 * checks and cadence, and a parallel one would have to learn all of it again
 * and would get one of them wrong.
 */
import type { ActionType } from '@xbam/shared/contracts';
import { createLogger, sha256Hex } from '@xbam/shared';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  capabilities as capabilitiesRepo,
  events as eventsRepo,
  jobs as jobsRepo,
  observability,
  prompts as promptsRepo,
  stances as stancesRepo,
  withTransaction,
  type CommitmentRow,
} from '@xbam/database';
import { getChannelAdapter } from '@xbam/channels';

const log = createLogger('follow-up');

/**
 * How long after a promise before it is revisited.
 *
 * "Later" is the word people actually use, and it means hours rather than
 * minutes or weeks. Long enough that following up is not startling, short
 * enough that the conversation is still recognisable.
 */
export const DEFAULT_FOLLOW_UP_MS = 6 * 60 * 60_000;

/**
 * How many times a follow-up may be attempted before it is given up on.
 *
 * The guard against the failure mode every reminder system has: a promise that
 * cannot be kept retrying quietly for ever. Three attempts, then FAILED with
 * the reason, where an owner can see it.
 */
export const MAX_FOLLOW_UP_ATTEMPTS = 3;

export interface FollowUpResult {
  commitmentId: string;
  acted: boolean;
  reason: string;
  jobId: string | null;
}

/**
 * Whether this agent could actually keep a promise, right now.
 *
 * The brief's rule, and it is the right one: an agent that cannot revisit
 * something should not have promised it would. Checked when the promise is
 * made rather than only when it comes due, so an untrackable promise is never
 * recorded as tracked -- a row that looks like a commitment and is not is worse
 * than no row.
 */
export async function canFollowUp(agentId: string): Promise<{ able: boolean; why: string }> {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent) return { able: false, why: 'The agent no longer exists.' };

  const links = await accountsRepo.listAgentAccounts(agentId);
  const link = links[0];
  if (!link) return { able: false, why: 'No account is connected, so there is nothing to follow up on.' };

  const grants = await capabilitiesRepo.grantsFor(agentId, link.accountId).catch(() => new Set<string>());
  if (grants.size > 0 && !grants.has('REPLY')) {
    return { able: false, why: 'This agent is not permitted to reply through that account.' };
  }
  return { able: true, why: 'It can reply, so it can follow up.' };
}

/** The brief handed to generation in place of an incoming message. */
function briefFor(commitment: CommitmentRow): string {
  const lines = [
    'You said you would come back to something, and this is you doing that.',
    '',
    'WHAT YOU SAID',
    commitment.promise,
  ];
  if (commitment.recipientHandle) {
    lines.push('', `You said it to @${commitment.recipientHandle.replace(/^@/, '')}.`);
  }
  lines.push(
    '',
    'Follow up on it now. If you have nothing to add yet, say that plainly rather than repeating the promise: ' +
      'saying "I will look into it" a second time is how an agent becomes something people stop believing.',
  );
  return lines.join('\n');
}

/**
 * Turns one due commitment into a job.
 *
 * Every ending settles the commitment, because a promise left in DUE is a
 * promise nothing will ever pick up again -- the claim moved it out of OPEN and
 * only this can move it back.
 */
export async function followUpOnCommitment(commitment: CommitmentRow): Promise<FollowUpResult> {
  const settle = async (
    status: 'OPEN' | 'COMPLETED' | 'CANCELLED' | 'FAILED',
    outcome: string,
    jobId: string | null = null,
  ): Promise<FollowUpResult> => {
    await stancesRepo.settleCommitment({
      id: commitment.id,
      status,
      outcome,
      followupJobId: jobId,
      // Put back for one interval, never immediately: a promise that cannot be
      // kept this minute is rarely keepable the next, and retrying at once is
      // how a queue becomes a loop.
      dueAt: status === 'OPEN' ? new Date(Date.now() + DEFAULT_FOLLOW_UP_MS).toISOString() : null,
    });
    return { commitmentId: commitment.id, acted: status === 'COMPLETED', reason: outcome, jobId };
  };

  if (commitment.attempts > MAX_FOLLOW_UP_ATTEMPTS) {
    return settle('FAILED', `Tried ${commitment.attempts - 1} times and could not follow up. Giving up rather than retrying for ever.`);
  }

  const agent = await agentsRepo.getAgent(commitment.agentId);
  if (!agent) return settle('CANCELLED', 'The agent no longer exists.');
  if (agent.state !== 'ACTIVE') return settle('OPEN', `The agent is ${agent.state.toLowerCase()}, so this waits.`);

  const policy = await agentsRepo.getActivePolicy(agent.id);
  if (!policy) return settle('OPEN', 'The agent has no policy version, so nothing can be decided.');
  const mode = policy.config.automation.mode;
  if (mode === 'OFF' || mode === 'MONITOR_ONLY') {
    return settle('OPEN', `Automation is ${mode.toLowerCase().replace(/_/g, ' ')}, so this waits.`);
  }

  const able = await canFollowUp(agent.id);
  if (!able.able) return settle('CANCELLED', able.why);

  const links = await accountsRepo.listAgentAccounts(agent.id);
  const accountId = links[0]?.accountId ?? null;
  const account = accountId ? await accountsRepo.getAccount(accountId) : null;
  if (!account) return settle('CANCELLED', 'The account it was promised through is gone.');

  const template = await promptsRepo.getActiveTemplate('reply.default');
  if (!template) return settle('OPEN', 'The prompt template is missing.');

  const dryRun = policy.config.automation.dryRunDefault;
  const actionType: ActionType = 'REPLY';
  // One real follow-up per commitment, for ever. A rehearsal takes its own key,
  // for the same reason a rehearsed post does: it must not spend the one the
  // real follow-up needs.
  const remoteEventId = dryRun ? `followup:${commitment.id}:rehearsal` : `followup:${commitment.id}`;
  const idempotencyKey = sha256Hex(`${account.channel}:${accountId}:${remoteEventId}:${actionType}:${agent.id}`);

  const outcome = await withTransaction(async (tx) => {
    const { event } = await eventsRepo.ingestEvent(tx, accountId, {
      channel: account.channel,
      type: 'SCHEDULED_TRIGGER',
      remoteEventId,
      remoteMessageId: null,
      remoteAuthorId: null,
      remoteAuthorHandle: commitment.recipientHandle,
      remoteAuthorDisplayName: null,
      remoteConversationId: null,
      parentRemoteMessageId: null,
      remoteUrl: commitment.remoteUrl,
      text: briefFor(commitment),
      occurredAt: new Date().toISOString(),
      raw: { origin: 'follow-up', commitmentId: commitment.id, promise: commitment.promise },
    });

    return jobsRepo.createJob(tx, {
      eventId: event.id,
      agentId: agent.id,
      accountId,
      channel: account.channel,
      actionType,
      idempotencyKey,
      dryRun,
      maxAttempts: policy.config.safety.maxAttempts,
      personaVersionId: agent.personaVersionId,
      policyVersionId: agent.policyVersionId,
      pipelineVersionId: agent.pipelineVersionId,
      promptTemplateVersionId: template.id,
      conversationId: commitment.conversationId,
      requiresBrowser: getChannelAdapter(account.channel).requiresBrowser,
    });
  });

  if (!outcome.created) {
    return settle('COMPLETED', 'A follow-up for this promise already exists.', outcome.job.id);
  }

  await observability.emitTrace({
    jobId: outcome.job.id,
    agentId: agent.id,
    type: 'JOB_CREATED',
    message: `Following up on: ${commitment.promise.slice(0, 120)}`,
    data: { origin: 'follow-up', commitmentId: commitment.id, idempotencyKey },
  });

  log.info('following up on a commitment', { commitmentId: commitment.id, jobId: outcome.job.id, dryRun });
  return settle('COMPLETED', 'A follow-up was queued.', outcome.job.id);
}

/** One pass over the commitments that have come due. */
export async function runDueFollowUps(limit: number): Promise<FollowUpResult[]> {
  const due = await stancesRepo.claimDueCommitments(limit);
  const results: FollowUpResult[] = [];
  for (const commitment of due) results.push(await followUpOnCommitment(commitment));
  return results;
}
