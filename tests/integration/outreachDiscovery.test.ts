import { describe, expect, it } from 'vitest';
import type { RadarCandidate } from '@xbam/shared/contracts';
import { accounts as accountsRepo, query } from '@xbam/database';
import { reconcileCandidates } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

async function linkedAccount(ownerId: string, agentId: string) {
  const account = await accountsRepo.createAccount({ ownerId, channel: 'x', handle: `watch_${uniqueSuffix()}` });
  await accountsRepo.updateAccount(account.id, { status: 'CONNECTED', enabled: true });
  await accountsRepo.linkAgentAccount({
    agentId,
    accountId: account.id,
    triggerEventTypes: ['MENTION', 'REPLY'],
    actionType: 'REPLY',
  });
  return account;
}

/** What the tracked_account and tracked_keyword monitors actually produce. */
function watchedPost(remoteId: string): RadarCandidate {
  return {
    remoteId,
    remoteUrl: `https://x.com/stranger/status/${remoteId}`,
    authorHandle: 'stranger',
    authorId: null,
    authorDisplayName: 'A stranger',
    text: 'Shipping something today that nobody asked me about.',
    parentRemoteId: null,
    conversationRemoteId: remoteId,
    occurredAt: new Date().toISOString(),
    // Both tracked monitors call harvest(ctx, 'POST', ...), so this is the
    // literal value that reaches the reconciler.
    eventType: 'POST',
    raw: { source: 'tracked_account' },
  };
}

const eventTypeOf = async (remoteId: string) =>
  (await query<{ type: string }>('SELECT type FROM events WHERE remote_event_id = $1', [remoteId]))[0]?.type ?? null;

/**
 * Watching an account is not being mentioned by it.
 *
 * `harvest(ctx, 'POST', ...)` is what both tracked monitors call, and 'POST' is
 * not one of EVENT_TYPES -- so the reconciler's fallback turned every watched
 * post into a MENTION. That is not a mislabel anybody could shrug at: MENTION is
 * in the default trigger set, so watching an account meant replying to
 * everything it posted, in the belief that it had been addressed to the agent.
 * It also put strangers' posts in the inbox, which reads mentions by type.
 */
describe('a post found by watching, not by being mentioned', () => {
  it('is not recorded as a mention', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);
    const remoteId = `19${Date.now()}`.slice(0, 19);

    await reconcileCandidates({
      accountId: account.id,
      sourceId: null,
      sourceKind: 'tracked_account',
      candidates: [watchedPost(remoteId)],
      mayTrigger: true,
    });

    expect(await eventTypeOf(remoteId)).toBe('KEYWORD_MATCH');
  });

  it('does not queue a reply merely because the account is being watched', async () => {
    // The link is triggered by MENTION and REPLY, which is the default. Watching
    // has to be turned on deliberately, not arrive through a mislabel.
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);
    const remoteId = `18${Date.now()}`.slice(0, 19);

    await reconcileCandidates({
      accountId: account.id,
      sourceId: null,
      sourceKind: 'tracked_keyword',
      candidates: [watchedPost(remoteId)],
      mayTrigger: true,
    });

    const queued = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM jobs j JOIN events e ON e.id = j.event_id WHERE e.remote_event_id = $1`,
      [remoteId],
    );
    expect(queued[0]!.n).toBe(0);
  });
});

/**
 * "Context only" has to mean the context is kept.
 *
 * A source with mayTrigger off used to discard its candidates outright while
 * counting them as contextOnly, so watching an account for context produced no
 * context: no event, no discovery record, and nothing to show it had ever
 * looked. The post is real and it happened; only the acting is switched off.
 */
describe('watching a source for context rather than to act on', () => {
  it('keeps the post', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);
    const remoteId = `17${Date.now()}`.slice(0, 19);

    const result = await reconcileCandidates({
      accountId: account.id,
      sourceId: null,
      sourceKind: 'tracked_account',
      candidates: [watchedPost(remoteId)],
      mayTrigger: false,
    });

    expect(result.contextOnly).toBe(1);
    expect(await eventTypeOf(remoteId)).toBe('KEYWORD_MATCH');
  });

  it('queues nothing from it', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);
    const remoteId = `16${Date.now()}`.slice(0, 19);

    await reconcileCandidates({
      accountId: account.id,
      sourceId: null,
      sourceKind: 'tracked_account',
      candidates: [watchedPost(remoteId)],
      mayTrigger: false,
    });

    const queued = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM jobs j JOIN events e ON e.id = j.event_id WHERE e.remote_event_id = $1',
      [remoteId],
    );
    expect(queued[0]!.n).toBe(0);
  });

  it('records how it was found, so a quiet monitor can be told from a broken one', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);
    const remoteId = `15${Date.now()}`.slice(0, 19);

    await reconcileCandidates({
      accountId: account.id,
      sourceId: null,
      sourceKind: 'tracked_account',
      candidates: [watchedPost(remoteId)],
      mayTrigger: false,
    });

    const found = await query<{ source_kind: string }>(
      `SELECT d.source_kind FROM event_discoveries d
         JOIN events e ON e.id = d.event_id WHERE e.remote_event_id = $1`,
      [remoteId],
    );
    expect(found.map((row) => row.source_kind)).toContain('tracked_account');
  });
});
