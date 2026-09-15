import { describe, expect, it } from 'vitest';
import {
  accounts as accountsRepo,
  growth as growthRepo,
  relationships as relationshipsRepo,
} from '@xbam/database';
import { opportunitiesFor, reconcileCandidates, recordExchange } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * What the radar now knows, and where it ends up.
 *
 * The monitors used to scrape a rendered page, which carries neither the
 * author's numeric id nor an exact engagement count. Both absences travelled
 * the whole way down and cost real behaviour, in two places that had been
 * written years apart and were each waiting for the other end:
 *
 *  - `events.remote_author_id` was null for everything discovered, so a
 *    relationship could only ever be keyed on a handle -- and somebody who
 *    renames themselves becomes a second person, which is the exact
 *    discontinuity the relationships table exists to prevent.
 *  - `findOpportunities` weighs a crowded thread against an empty one and has
 *    done since it was built. Nothing ever populated a reply count.
 *
 * Against a real database, because the point is the trip: a unit test of any
 * one of these hops passes whether or not the next one reads what it wrote.
 */

async function agentWithAccount() {
  const fixture = await createFixture();
  const account = await accountsRepo.createAccount({
    ownerId: fixture.ownerId,
    channel: 'x',
    handle: `self${uniqueSuffix()}`.slice(0, 15),
    displayName: 'The agent',
  });
  await accountsRepo.linkAgentAccount({ agentId: fixture.agentId, accountId: account.id });
  return { ...fixture, accountId: account.id, handle: account.handle! };
}

function candidate(over: Record<string, unknown> = {}) {
  return {
    remoteId: `18${uniqueSuffix()}`,
    remoteUrl: 'https://x.com/stranger/status/1',
    authorHandle: 'stranger',
    authorId: '44196397',
    authorDisplayName: null,
    text: 'The new solana validator client is worth a look if you run one.',
    parentRemoteId: null,
    conversationRemoteId: null,
    occurredAt: new Date().toISOString(),
    eventType: 'MENTION',
    raw: { source: 'search', backend: 'x-graphql', metrics: { replies: 1, likes: 4, views: 900 } },
    ...over,
  };
}

describe('a candidate that came from X’s own data', () => {
  it('records the author’s immutable id on the event', async () => {
    const { accountId } = await agentWithAccount();
    const one = candidate();

    await reconcileCandidates({
      accountId,
      sourceId: null,
      sourceKind: 'mention_search',
      candidates: [one],
      mayTrigger: true,
    });

    const [row] = await growthRepo.discoveredPosts(accountId, { limit: 10 });
    expect(row!.remote_event_id).toBe(one.remoteId);
    // The whole point. Null here is what a scraped article gives.
    expect(row!.author_id).toBe('44196397');
  });

  it('carries the engagement counts through to what the growth screens read', async () => {
    const { accountId } = await agentWithAccount();
    await reconcileCandidates({
      accountId,
      sourceId: null,
      sourceKind: 'mention_search',
      candidates: [candidate()],
      mayTrigger: true,
    });

    const [row] = await growthRepo.discoveredPosts(accountId, { limit: 10 });
    expect(row!.metrics).toMatchObject({ replies: 1, likes: 4, views: 900 });
  });

  it('leaves the counts empty when the reader could not see any', async () => {
    const { accountId } = await agentWithAccount();
    await reconcileCandidates({
      accountId,
      sourceId: null,
      sourceKind: 'notifications',
      // What the rendered page produces: no counts at all, because it renders
      // them abbreviated and a wrong number is worse than none.
      candidates: [candidate({ raw: { source: 'notifications' } })],
      mayTrigger: true,
    });

    const [row] = await growthRepo.discoveredPosts(accountId, { limit: 10 });
    // Empty, never zero. An unmeasured post must not look like an empty thread.
    expect(row!.metrics).toEqual({});
  });
});

describe('the counts, once an opportunity is being weighed', () => {
  it('earns the early-thread reason from a real reply count', async () => {
    const { agentId, accountId, handle } = await agentWithAccount();
    await reconcileCandidates({
      accountId,
      sourceId: null,
      sourceKind: 'tracked_keyword',
      candidates: [candidate({ eventType: 'POST' })],
      mayTrigger: false,
    });

    const verdict = await opportunitiesFor({
      agentId,
      accountId,
      selfHandles: [handle],
      topics: ['solana'],
    });

    const opportunity = verdict.opportunities[0];
    expect(opportunity, `nothing survived: ${JSON.stringify(verdict.declined)}`).toBeDefined();
    const early = opportunity!.reasons.find((reason) => reason.name === 'early');
    // Written when the engine was built and unreachable until now.
    expect(early, 'a reply count should have produced the early-thread reason').toBeDefined();
    expect(early!.detail).toContain('1');
  });

  it('does not earn it when nobody counted', async () => {
    const { agentId, accountId, handle } = await agentWithAccount();
    await reconcileCandidates({
      accountId,
      sourceId: null,
      sourceKind: 'tracked_keyword',
      candidates: [candidate({ eventType: 'POST', raw: { source: 'page' } })],
      mayTrigger: false,
    });

    const verdict = await opportunitiesFor({ agentId, accountId, selfHandles: [handle], topics: ['solana'] });
    const opportunity = verdict.opportunities[0];
    expect(opportunity).toBeDefined();
    // "Nobody has replied yet" is worth points, and an unmeasured post must not
    // collect them by looking like an empty thread.
    expect(opportunity!.reasons.map((r) => r.name)).not.toContain('early');
  });
});

describe('the identity, once a relationship is recorded', () => {
  it('keys a relationship on the numeric id the radar now supplies', async () => {
    const { agentId } = await agentWithAccount();

    await recordExchange({
      agentId,
      channel: 'x',
      handle: 'stranger',
      // Before the radar read X's own data this was null for everything it
      // found, so a relationship had nothing but a handle to be about.
      remoteUserId: '44196397',
      displayName: 'A Stranger',
    });

    const found = await relationshipsRepo.find({ agentId, channel: 'x', handle: 'stranger' });
    expect(found?.remoteUserId).toBe('44196397');

    // And the id finds them after a rename, which is the reason it is kept.
    const afterRename = await relationshipsRepo.find({
      agentId,
      channel: 'x',
      handle: 'stranger_eth',
      remoteUserId: '44196397',
    });
    expect(afterRename?.id).toBe(found!.id);
  });
});
