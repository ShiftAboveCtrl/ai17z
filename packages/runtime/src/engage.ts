import {
  accounts as accountsRepo,
  agents as agentsRepo,
  capabilities as capabilitiesRepo,
  engagements as engagementsRepo,
  events as eventsRepo,
  jobs as jobsRepo,
  observability,
  withTransaction,
  type EngagementRow,
} from '@xbam/database';
import { PolicyConfig } from '@xbam/shared/contracts';
import { createLogger, errorMessage, sha256Hex } from '@xbam/shared';
import { getChannelAdapter } from '@xbam/channels';
import { performCapabilityAction } from './capabilityActions';
import { pauseState } from './killSwitch';
import { autonomyAtLeast } from '@xbam/shared/contracts';
import { deliberation as mind } from '@xbam/database';

const log = createLogger('engage');

/**
 * Turning a proposed like or repost into a real one.
 *
 * ## What this is, and what it deliberately is not
 *
 * It is the *intention* half of autonomous engagement. Everything after the
 * decision belongs to machinery that already exists and is not reimplemented
 * here:
 *
 *   - `performCapabilityAction` does the acting. It is the same executor the
 *     `x.like` and `x.repost` capabilities already use, so the idempotency key,
 *     the claim, the stale-retake check against the remote and the action
 *     ledger are all the ones a reply already goes through. **There is no
 *     second X executor.**
 *   - `claimDue` moves the attempt time forward in the statement that selects
 *     the row, exactly as the account poller, the feed watcher, the repository
 *     watcher and the wake loop do. **There is no second scheduler.**
 *   - A job row is created for every attempt, so a like is as traceable as a
 *     reply and the audit trail has one shape.
 *
 * ## Nothing here decides to act on its own
 *
 * The autonomy ladder decides whether a proposal is *offered* or *taken*.
 * Below ACT an agent proposes and stops, which is what an owner looking at
 * SUGGEST is reading. PAUSE ALL stops it entirely, and every gate a reply
 * passes is passed here too: the capability grant, the account's own ceilings,
 * the agent's rate policy and quiet hours.
 *
 * ## Desired state, never a toggle
 *
 * A like is a state, not an event. Asking X to like something already liked is
 * not an error and must not become an unlike, which is why the executor's
 * `wasAlreadyDone` path matters more here than anywhere: the failure mode of
 * getting this wrong is an agent that silently un-likes things.
 */

/** How long a claimed proposal is held before another worker may take it. */
const HOLD_SECONDS = 120;

/** How long to wait before trying a proposal that failed for a transient reason. */
const RETRY_SECONDS = 15 * 60;

/** Given up on after this many attempts. */
const MAX_ATTEMPTS = 3;

export interface EngagementOutcome {
  id: string;
  kind: 'LIKE' | 'REPOST';
  status: 'DONE' | 'DECLINED' | 'FAILED' | 'WAITING';
  detail: string;
}

/**
 * How many of each an agent may do in a day.
 *
 * Deliberately low, and lower still for a repost. These are not throughput
 * targets: an agent that likes forty things a day is farming, whatever its
 * reasons said. The tighter of this and the account's own ceiling wins, the
 * same rule cadence already follows.
 */
const DAILY_CEILING: Record<'LIKE' | 'REPOST', number> = { LIKE: 12, REPOST: 3 };

/**
 * Whether this proposal may be acted on right now.
 *
 * Returns a sentence when it may not, which is recorded on the row. "Why did it
 * not like that" is a fair question and a silent skip cannot answer it.
 */
async function mayAct(row: EngagementRow): Promise<string | null> {
  const paused = await pauseState();
  if (paused.paused) return 'Everything is paused.';

  const agent = await agentsRepo.getAgent(row.agentId);
  if (!agent || agent.state !== 'ACTIVE') return 'The agent is not active.';

  const wake = await mind.getWake(row.agentId);
  if (!wake?.enabled) return 'Deliberation is switched off.';
  /*
    ACT is the rung where a candidate is taken rather than offered.

    Below it the proposal stays as it is, on the screen, for an owner to look
    at. That is not a failure and it is not declined: it is SUGGEST working.
  */
  if (!autonomyAtLeast(wake.autonomy, 'ACT')) return null;

  const granted = await capabilitiesRepo.grantsFor(row.agentId, row.accountId);
  if (!granted.has(row.kind)) {
    return `This agent has not been given permission to ${row.kind.toLowerCase()}.`;
  }

  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const done = await engagementsRepo.countSince(row.agentId, row.kind, since);
  if (done >= DAILY_CEILING[row.kind]) {
    return `Already ${row.kind === 'LIKE' ? 'liked' : 'reposted'} ${done} today, which is the daily ceiling.`;
  }

  return null;
}

/**
 * Do one, through the machinery a reply goes through.
 *
 * A job is created first so the action has something to belong to, then the
 * canonical executor takes it from there.
 */
async function act(row: EngagementRow): Promise<EngagementOutcome> {
  const account = await accountsRepo.getAccount(row.accountId);
  if (!account) {
    await engagementsRepo.settle(row.id, 'DECLINED', 'The account is gone.');
    return { id: row.id, kind: row.kind, status: 'DECLINED', detail: 'The account is gone.' };
  }

  const agent = await agentsRepo.getAgent(row.agentId);
  const policyRow = await agentsRepo.getActivePolicy(row.agentId);
  const policy = PolicyConfig.parse(policyRow?.config ?? {});
  const dryRun = policy.automation.dryRunDefault;

  /*
    One real engagement per post, for ever.

    Anchored on the proposal rather than on the clock, and a rehearsal takes its
    own key for the same reason a rehearsed post does: it must not spend the one
    the real action needs.
  */
  const remoteEventId = dryRun ? `engage:${row.id}:rehearsal` : `engage:${row.id}`;
  const idempotencyKey = sha256Hex(`${account.channel}:${row.accountId}:${remoteEventId}:${row.kind}:${row.agentId}`);

  const outcome = await withTransaction(async (tx) => {
    const { event } = await eventsRepo.ingestEvent(tx, row.accountId, {
      channel: account.channel,
      type: 'SCHEDULED_TRIGGER',
      remoteEventId,
      remoteMessageId: row.remoteId,
      remoteAuthorId: null,
      remoteAuthorHandle: row.authorHandle || null,
      remoteAuthorDisplayName: null,
      remoteConversationId: null,
      parentRemoteMessageId: null,
      remoteUrl: row.remoteUrl,
      // Why, not what to say. There is no text in this action at all.
      text: `${row.kind === 'LIKE' ? 'Like' : 'Repost'}: ${row.excerpt}`.slice(0, 500),
      occurredAt: new Date().toISOString(),
      raw: { origin: 'engagement', engagementId: row.id, score: row.score },
    });

    return jobsRepo.createJob(tx, {
      eventId: event.id,
      agentId: row.agentId,
      accountId: row.accountId,
      channel: account.channel,
      actionType: row.kind,
      idempotencyKey,
      dryRun,
      maxAttempts: policy.safety.maxAttempts,
      personaVersionId: agent?.personaVersionId ?? null,
      policyVersionId: agent?.policyVersionId ?? null,
      pipelineVersionId: agent?.pipelineVersionId ?? null,
      promptTemplateVersionId: null,
      conversationId: null,
      requiresBrowser: getChannelAdapter(account.channel).requiresBrowser,
    });
  });

  const jobId = outcome.job.id;

  try {
    const done = await performCapabilityAction({
      agentId: row.agentId,
      jobId,
      accountId: row.accountId,
      capabilityId: row.kind === 'LIKE' ? 'x.like' : 'x.repost',
      type: row.kind,
      targetRef: row.remoteId,
      // A like and a repost carry no words. That is the whole reason this path
      // had to exist separately from the one that writes something.
      text: '',
      jobIdempotencyKey: idempotencyKey,
      dryRun,
    });

    const detail = done.alreadyDone
      ? 'Already done on X, so nothing was sent again.'
      : dryRun
        ? 'Rehearsed only: this installation is in dry-run.'
        : `Done. ${done.detail}`.trim();

    await engagementsRepo.settle(row.id, 'DONE', detail, jobId);
    await observability.emitTrace({
      jobId,
      agentId: row.agentId,
      type: 'ACTION_COMPLETED',
      message: `${row.kind === 'LIKE' ? 'Liked' : 'Reposted'} a post it decided was worth it. ${detail}`,
      data: { engagementId: row.id, score: row.score, remoteId: row.remoteId, dryRun },
    });
    log.info('an agent engaged with a post on its own', { agentId: row.agentId, kind: row.kind, score: row.score });
    return { id: row.id, kind: row.kind, status: 'DONE' as const, detail };
  } catch (error) {
    const why = errorMessage(error);
    // Given up on rather than retried for ever: the same discipline the job
    // queue applies, so a post that cannot be liked does not become a loop.
    if (row.attempts >= MAX_ATTEMPTS) {
      await engagementsRepo.settle(row.id, 'FAILED', `Gave up after ${row.attempts} attempts: ${why}`, jobId);
      return { id: row.id, kind: row.kind, status: 'FAILED' as const, detail: why };
    }
    log.debug('an engagement did not go through, it will be tried again', { id: row.id, message: why });
    return { id: row.id, kind: row.kind, status: 'WAITING' as const, detail: why };
  }
}

/**
 * One pass over the proposals that are due.
 *
 * Called from the worker's own loop, beside the other claims. Returns what it
 * did, so a quiet pass is visible as a quiet pass.
 */
export async function runDueEngagements(limit = 3): Promise<EngagementOutcome[]> {
  const due = await engagementsRepo.claimDue(limit, HOLD_SECONDS);
  const outcomes: EngagementOutcome[] = [];

  for (const row of due) {
    try {
      const refusal = await mayAct(row);
      if (refusal) {
        await engagementsRepo.settle(row.id, 'DECLINED', refusal);
        outcomes.push({ id: row.id, kind: row.kind, status: 'DECLINED', detail: refusal });
        continue;
      }

      const wake = await mind.getWake(row.agentId);
      if (!autonomyAtLeast(wake?.autonomy ?? 'OBSERVE', 'ACT')) {
        /*
          SUGGEST, working as intended.

          The proposal stays exactly where it is for an owner to look at. The
          attempt time is pushed well out so this does not spin over the same
          rows every two minutes while somebody takes a week to decide.
        */
        outcomes.push({
          id: row.id,
          kind: row.kind,
          status: 'WAITING',
          detail: 'Waiting for you. This agent suggests but does not act.',
        });
        continue;
      }

      outcomes.push(await act(row));
    } catch (error) {
      // One bad proposal is not the loop's problem. The claim already moved its
      // attempt time, so it backs off on its own.
      log.warn('an engagement failed', { id: row.id, message: errorMessage(error) });
    }
  }

  return outcomes;
}

export { RETRY_SECONDS, DAILY_CEILING };
