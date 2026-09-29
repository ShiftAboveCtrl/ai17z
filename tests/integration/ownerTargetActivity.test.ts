import { describe, expect, it } from 'vitest';
import { EngagementPolicy, ResolvedContext, type RadarCandidate } from '@xbam/shared/contracts';
import { accounts, autonomy, query, radar, targets } from '@xbam/database';
import { cancelJob, loadJobBundle, reconcileCandidates, stepEngagement } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

async function watched(mayTrigger = true, overrides: Parameters<typeof createFixture>[0] = {}) {
  const fixture = await createFixture(overrides);
  const account = await accounts.createAccount({
    ownerId: fixture.ownerId,
    channel: 'x',
    handle: `target_account_${uniqueSuffix()}`,
  });
  await accounts.updateAccount(account.id, { status: 'CONNECTED', enabled: true });
  await accounts.linkAgentAccount({
    agentId: fixture.agentId,
    accountId: account.id,
    triggerEventTypes: ['MENTION', 'REPLY'],
    actionType: 'REPLY',
  });
  const source = await radar.upsertSource({
    accountId: account.id,
    kind: 'tracked_account',
    target: 'owner_chosen_account',
    config: { mayTrigger, priority: 90 },
  });
  return { ...fixture, account, source };
}

function post(id = `target-${uniqueSuffix()}`): RadarCandidate {
  return {
    remoteId: id,
    remoteUrl: `https://x.com/owner_chosen_account/status/${id}`,
    authorHandle: 'owner_chosen_account',
    authorId: '99112233',
    authorDisplayName: 'Owner Chosen Account',
    // Deliberately not a topic match and not valuable stranger outreach. The
    // watch, not a keyword score, is why this must reach deliberation.
    text: 'A small ordinary update with no keywords in common.',
    parentRemoteId: null,
    conversationRemoteId: id,
    occurredAt: new Date().toISOString(),
    eventType: 'POST',
    raw: {},
  };
}

describe('owner-target activity is a first-class durable event', () => {
  it('preserves the semantic event and deliberately queues it without stranger triage', async () => {
    const fixture = await watched();
    const candidate = post();
    const result = await reconcileCandidates({
      accountId: fixture.account.id,
      sourceId: fixture.source.id,
      sourceKind: 'tracked_account',
      candidates: [candidate],
      mayTrigger: true,
    });

    expect(result.outcomes[0]!.jobs).toHaveLength(1);
    const [event] = await query<{ type: string }>('SELECT type FROM events WHERE remote_event_id=$1', [candidate.remoteId]);
    expect(event!.type).toBe('TARGET_ACCOUNT_ACTIVITY');

    const state = await targets.listAgentTargets(fixture.agentId);
    expect(state).toHaveLength(1);
    expect(state[0]!.remoteUserId).toBe('99112233');
    expect(state[0]!.lastSeenPostId).toBe(candidate.remoteId);
    expect(state[0]!.lastProcessedPostId).toBe(candidate.remoteId);
    expect(state[0]!.latestDisposition).toBe('CONSIDERING');
  });

  it('takes the reply path even when an ordinary post would fail the generic engagement score', async () => {
    const fixture = await watched(true, {
      policy: { engagement: EngagementPolicy.parse({ strategy: 'SELECTIVE', minimumReplyValue: 100 }) },
    });
    const result = await reconcileCandidates({
      accountId: fixture.account.id,
      sourceId: fixture.source.id,
      sourceKind: 'tracked_account',
      candidates: [post()],
      mayTrigger: true,
    });
    const bundle = await loadJobBundle(result.outcomes[0]!.jobs[0]!.job);
    bundle.job.resolvedContext = ResolvedContext.parse({
      targetRef: bundle.event.remoteMessageId,
      targetUrl: bundle.event.remoteUrl,
      targetAuthorHandle: bundle.event.remoteAuthorHandle,
      conversationRef: bundle.event.remoteConversationId,
      incomingText: bundle.event.text,
    });

    await expect(stepEngagement(bundle)).resolves.toBe('engage');
  });

  it('answers a watched account without shadowing it: fatigue still applies, with a sentence', async () => {
    // The limit this is about, stated rather than inherited from the fixture.
    const fixture = await watched(true, { policy: { engagement: EngagementPolicy.parse({ maxRepliesPerPersonPerHour: 3 }) } });
    const resolve = async () => {
      const result = await reconcileCandidates({
        accountId: fixture.account.id,
        sourceId: fixture.source.id,
        sourceKind: 'tracked_account',
        candidates: [post()],
        mayTrigger: true,
      });
      const bundle = await loadJobBundle(result.outcomes[0]!.jobs[0]!.job);
      bundle.job.resolvedContext = ResolvedContext.parse({
        targetRef: bundle.event.remoteMessageId,
        targetAuthorHandle: bundle.event.remoteAuthorHandle,
        incomingText: bundle.event.text,
      });
      return bundle;
    };

    // Three replies to this account already went out in the last hour.
    for (let i = 0; i < 3; i += 1) {
      const answered = await resolve();
      await query(
        `INSERT INTO actions (job_id, agent_id, account_id, channel, type, status, idempotency_key, executed_at)
         VALUES ($1, $2, $3, 'x', 'REPLY', 'EXECUTED', $4, now() - interval '5 minutes')`,
        [answered.job.id, fixture.agentId, fixture.account.id, `fatigue-${uniqueSuffix()}`],
      );
    }

    const fourth = await resolve();
    await expect(stepEngagement(fourth)).resolves.toBe('ignore');
    const [row] = await query<{ last_error: string | null }>('SELECT last_error FROM jobs WHERE id = $1', [fourth.job.id]);
    expect(row!.last_error).toMatch(/3 times in the last hour/);
    expect(row!.last_error).toMatch(/watch stands/);

    // An hour on, the next post is answered as usual.
    await query(`UPDATE actions SET executed_at = now() - interval '2 hours' WHERE agent_id = $1`, [fixture.agentId]);
    await expect(stepEngagement(await resolve())).resolves.toBe('engage');
  });

  it('still honors a durable do-not-contact instruction for a watched account', async () => {
    const fixture = await watched();
    await autonomy.addDoNotContact({
      agentId: fixture.agentId,
      channel: 'x',
      handle: 'owner_chosen_account',
      source: 'THEY_ASKED',
      evidence: 'please stop',
    });
    const result = await reconcileCandidates({
      accountId: fixture.account.id,
      sourceId: fixture.source.id,
      sourceKind: 'tracked_account',
      candidates: [post()],
      mayTrigger: true,
    });
    const bundle = await loadJobBundle(result.outcomes[0]!.jobs[0]!.job);
    bundle.job.resolvedContext = ResolvedContext.parse({
      targetRef: bundle.event.remoteMessageId,
      targetAuthorHandle: bundle.event.remoteAuthorHandle,
      incomingText: bundle.event.text,
    });

    await expect(stepEngagement(bundle)).resolves.toBe('ignore');
  });

  it('deduplicates the post without regressing its disposition or creating another job', async () => {
    const fixture = await watched();
    const candidate = post();
    const input = {
      accountId: fixture.account.id,
      sourceId: fixture.source.id,
      sourceKind: 'tracked_account' as const,
      candidates: [candidate],
      mayTrigger: true,
    };
    const first = await reconcileCandidates(input);
    await reconcileCandidates(input);

    const [jobs] = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM jobs j JOIN events e ON e.id=j.event_id WHERE e.remote_event_id=$1`,
      [candidate.remoteId],
    );
    expect(jobs!.n).toBe(1);
    expect((await targets.dispositionForJob(first.outcomes[0]!.jobs[0]!.job.id))!.disposition).toBe('CONSIDERING');
  });

  it('promotes a post first found generically when the owner-target watch corroborates it', async () => {
    const fixture = await watched();
    const candidate = post();
    await reconcileCandidates({
      accountId: fixture.account.id,
      sourceId: null,
      sourceKind: 'tracked_keyword',
      candidates: [candidate],
      mayTrigger: true,
    });
    await reconcileCandidates({
      accountId: fixture.account.id,
      sourceId: fixture.source.id,
      sourceKind: 'tracked_account',
      candidates: [candidate],
      mayTrigger: true,
    });

    const [event] = await query<{ type: string }>('SELECT type FROM events WHERE remote_event_id=$1', [candidate.remoteId]);
    expect(event!.type).toBe('TARGET_ACCOUNT_ACTIVITY');
    expect((await targets.listAgentTargets(fixture.agentId))[0]!.latestDisposition).not.toBeNull();
  });

  it('records a context-only watch instead of silently dropping it', async () => {
    const fixture = await watched(false);
    const candidate = post();
    await reconcileCandidates({
      accountId: fixture.account.id,
      sourceId: fixture.source.id,
      sourceKind: 'tracked_account',
      candidates: [candidate],
      mayTrigger: false,
    });

    const state = await targets.listAgentTargets(fixture.agentId);
    expect(state[0]!.mode).toBe('WATCH');
    expect(state[0]!.latestDisposition).toBe('WATCH_ONLY');
    expect(state[0]!.lastProcessedAt).toBeNull();
  });

  it('moves the disposition with the job lifecycle', async () => {
    const fixture = await watched();
    const result = await reconcileCandidates({
      accountId: fixture.account.id,
      sourceId: fixture.source.id,
      sourceKind: 'tracked_account',
      candidates: [post()],
      mayTrigger: true,
    });
    const jobId = result.outcomes[0]!.jobs[0]!.job.id;
    await cancelJob(jobId);
    expect((await targets.dispositionForJob(jobId))!.disposition).toBe('INTENTIONAL_NO_ACTION');
  });
});
