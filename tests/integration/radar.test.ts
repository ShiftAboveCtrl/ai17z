import { describe, expect, it } from 'vitest';
import type { RadarCandidate } from '@xbam/shared/contracts';
import { accounts as accountsRepo, jobs as jobsRepo, query, radar } from '@xbam/database';
import { reconcileCandidates } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

async function linkedAccount(ownerId: string, agentId: string) {
  const account = await accountsRepo.createAccount({
    ownerId,
    channel: 'x',
    handle: `radar_${uniqueSuffix()}`,
  });
  await accountsRepo.updateAccount(account.id, { status: 'CONNECTED', enabled: true });
  await accountsRepo.linkAgentAccount({
    agentId,
    accountId: account.id,
    triggerEventTypes: ['MENTION', 'REPLY'],
    actionType: 'REPLY',
  });
  return account;
}

function candidate(remoteId: string, over: Partial<RadarCandidate> = {}): RadarCandidate {
  return {
    remoteId,
    remoteUrl: `https://x.com/alice/status/${remoteId}`,
    authorHandle: 'alice',
    authorId: null,
    authorDisplayName: 'Alice',
    text: 'Still think that after today?',
    parentRemoteId: null,
    conversationRemoteId: remoteId,
    occurredAt: new Date().toISOString(),
    eventType: 'MENTION',
    raw: {},
    ...over,
  };
}

describe('the same post seen through several monitors is one event', () => {
  it('creates one event and one job however many sources found it', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);

    const seenBy = async (kind: 'notifications' | 'mention_search' | 'own_threads') =>
      reconcileCandidates({
        accountId: account.id,
        sourceId: null,
        sourceKind: kind,
        candidates: [candidate('1900000000000000001')],
        mayTrigger: true,
      });

    const first = await seenBy('notifications');
    const second = await seenBy('mention_search');
    const third = await seenBy('own_threads');

    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(second.corroborated).toBe(1);
    expect(third.corroborated).toBe(1);

    const jobs = await jobsRepo.listJobs({ agentId: fixture.agentId, limit: 20 });
    expect(jobs.items).toHaveLength(1);
  });

  it('records which sources found it, so a source earning nothing is visible', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);

    const outcome = await reconcileCandidates({
      accountId: account.id,
      sourceId: null,
      sourceKind: 'notifications',
      candidates: [candidate('1900000000000000002')],
      mayTrigger: true,
    });
    await reconcileCandidates({
      accountId: account.id,
      sourceId: null,
      sourceKind: 'reply_search',
      candidates: [candidate('1900000000000000002')],
      mayTrigger: true,
    });
    // Seen twice through the same source: corroboration, not a new discovery.
    await reconcileCandidates({
      accountId: account.id,
      sourceId: null,
      sourceKind: 'reply_search',
      candidates: [candidate('1900000000000000002')],
      mayTrigger: true,
    });

    const discoveries = await radar.listDiscoveries(outcome.outcomes[0]!.eventId);
    expect(discoveries.map((d) => d.sourceKind).sort()).toEqual(['notifications', 'reply_search']);
    expect(discoveries.find((d) => d.sourceKind === 'reply_search')?.seenCount).toBe(2);
  });

  it('collapses a post that appears twice within one poll', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);

    const outcome = await reconcileCandidates({
      accountId: account.id,
      sourceId: null,
      sourceKind: 'notifications',
      candidates: [candidate('1900000000000000003'), candidate('1900000000000000003')],
      mayTrigger: true,
    });
    expect(outcome.created).toBe(1);
  });

  it('keeps the sighting that knows more when two disagree', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);

    // A notification rarely knows the parent; a thread walk always does.
    const outcome = await reconcileCandidates({
      accountId: account.id,
      sourceId: null,
      sourceKind: 'own_threads',
      candidates: [
        candidate('1900000000000000004', { parentRemoteId: null }),
        candidate('1900000000000000004', { parentRemoteId: '1888888888888888888' }),
      ],
      mayTrigger: true,
    });
    expect(outcome.created).toBe(1);

    const rows = await query<{ parent_remote_message_id: string | null }>(
      'SELECT parent_remote_message_id FROM events WHERE remote_event_id = $1',
      ['1900000000000000004'],
    );
    expect(rows[0]?.parent_remote_message_id).toBe('1888888888888888888');
  });
});

describe('watching is not permission to reply', () => {
  it('records nothing as a job when the source may only inform context', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);

    const outcome = await reconcileCandidates({
      accountId: account.id,
      sourceId: null,
      sourceKind: 'tracked_account',
      candidates: [candidate('1900000000000000005')],
      mayTrigger: false,
    });

    expect(outcome.contextOnly).toBe(1);
    expect(outcome.created).toBe(0);
    const jobs = await jobsRepo.listJobs({ agentId: fixture.agentId, limit: 20 });
    expect(jobs.items).toHaveLength(0);
  });
});

describe('source health is per source, not per account', () => {
  it('starts unknown and becomes healthy on a successful poll', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);
    const source = await radar.upsertSource({ accountId: account.id, kind: 'notifications', label: 'Notifications' });
    expect(source.status).toBe('UNKNOWN');

    await radar.recordPoll({ sourceId: source.id, nextPollAt: new Date(), found: 3 });
    const [updated] = await radar.listSources(account.id);
    expect(updated!.status).toBe('HEALTHY');
    expect(updated!.lastResultAt).toBeTruthy();
  });

  it('treats a working but empty poll as healthy, not as a problem', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);
    const source = await radar.upsertSource({ accountId: account.id, kind: 'mention_search' });

    await radar.recordPoll({ sourceId: source.id, nextPollAt: new Date(), found: 0 });
    const [updated] = await radar.listSources(account.id);
    expect(updated!.status).toBe('HEALTHY');
    // A quiet source is not a broken one, and the two are recorded separately.
    expect(updated!.lastResultAt).toBeNull();
    expect(updated!.lastSuccessAt).toBeTruthy();
  });

  it('degrades once and only fails after repeated failure', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);
    const source = await radar.upsertSource({ accountId: account.id, kind: 'notifications' });

    await radar.recordPoll({ sourceId: source.id, nextPollAt: new Date(), found: 0, error: 'timeout' });
    expect((await radar.listSources(account.id))[0]!.status).toBe('DEGRADED');

    await radar.recordPoll({ sourceId: source.id, nextPollAt: new Date(), found: 0, error: 'timeout' });
    await radar.recordPoll({ sourceId: source.id, nextPollAt: new Date(), found: 0, error: 'timeout' });
    expect((await radar.listSources(account.id))[0]!.status).toBe('FAILING');

    // Recovery is immediate: one good poll clears the streak.
    await radar.recordPoll({ sourceId: source.id, nextPollAt: new Date(), found: 1 });
    const recovered = (await radar.listSources(account.id))[0]!;
    expect(recovered.status).toBe('HEALTHY');
    expect(recovered.consecutiveFailures).toBe(0);
  });

  it('one failing source does not stop the others being polled', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);
    const failing = await radar.upsertSource({ accountId: account.id, kind: 'notifications' });
    await radar.upsertSource({ accountId: account.id, kind: 'mention_search' });
    await radar.recordPoll({
      sourceId: failing.id,
      nextPollAt: new Date(Date.now() + 600_000),
      found: 0,
      error: 'down',
    });

    const due = await radar.claimDueSources(10, 60);
    expect(due.map((s) => s.kind)).toContain('mention_search');
    expect(due.map((s) => s.kind)).not.toContain('notifications');
  });
});

describe('polling schedule', () => {
  it('claims a source once, so two workers cannot both poll it', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);
    await radar.upsertSource({ accountId: account.id, kind: 'notifications' });

    const first = await radar.claimDueSources(10, 120);
    const second = await radar.claimDueSources(10, 120);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('keeps a cursor so the next poll resumes rather than restarting', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);
    const source = await radar.upsertSource({ accountId: account.id, kind: 'mention_search' });

    await radar.recordPoll({ sourceId: source.id, nextPollAt: new Date(), found: 5, cursor: '190001' });
    expect((await radar.getSource(source.id))?.cursor).toBe('190001');

    // A poll that finds nothing must not erase where we had got to.
    await radar.recordPoll({ sourceId: source.id, nextPollAt: new Date(), found: 0 });
    expect((await radar.getSource(source.id))?.cursor).toBe('190001');
  });

  it('leaves sources on a disconnected account alone', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);
    await radar.upsertSource({ accountId: account.id, kind: 'notifications' });
    await accountsRepo.updateAccount(account.id, { status: 'NEEDS_AUTH' });

    expect(await radar.claimDueSources(10, 60)).toHaveLength(0);
  });
});

describe('own posts', () => {
  it('cycles through recent posts least-recently-checked first', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);

    for (const id of ['a1', 'a2', 'a3']) {
      await radar.recordOwnPost({
        accountId: account.id,
        agentId: fixture.agentId,
        remoteId: id,
        postedAt: new Date().toISOString(),
      });
    }

    const [first] = await radar.ownPostsToCheck(account.id, 1);
    await radar.markOwnPostChecked(first!.id, 2);
    const [second] = await radar.ownPostsToCheck(account.id, 1);
    expect(second!.remoteId).not.toBe(first!.remoteId);
  });

  it('ignores posts too old to be collecting replies', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);
    await radar.recordOwnPost({
      accountId: account.id,
      agentId: fixture.agentId,
      remoteId: 'ancient',
      postedAt: new Date(Date.now() - 30 * 24 * 3_600_000).toISOString(),
    });

    expect(await radar.ownPostsToCheck(account.id, 5)).toHaveLength(0);
  });
});
