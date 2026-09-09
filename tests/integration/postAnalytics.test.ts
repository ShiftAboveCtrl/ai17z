import { describe, expect, it } from 'vitest';
import { postAnalytics, query } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * Observations, not totals.
 *
 * Every question Growth asks is about change: did this format do better than
 * that one, is this post still being seen a day later. A number overwritten
 * each time it is read answers none of them, so these are snapshots and nothing
 * replaces an older one.
 *
 * Against real Postgres because the guarantee is the unique index -- a poller
 * that runs twice in a minute is recording one observation, not two -- and a
 * mock would accept both and prove the opposite.
 */
const post = (n: string) => `20000000000000000${n}`;

describe('recording what a post did', () => {
  it('keeps every reading, so a series is a series', async () => {
    const fixture = await createFixture();
    const id = post('1');

    await postAnalytics.record({
      agentId: fixture.agentId,
      accountId: null,
      remotePostId: id,
      source: 'TIMELINE',
      impressions: 100,
      likes: 2,
    });
    // A minute later, by the clock the index buckets on.
    await query(
      `UPDATE post_analytics SET observed_at = observed_at - interval '5 minutes' WHERE remote_post_id = $1`,
      [id],
    );
    await postAnalytics.record({
      agentId: fixture.agentId,
      accountId: null,
      remotePostId: id,
      source: 'TIMELINE',
      impressions: 340,
      likes: 9,
    });

    const readings = await postAnalytics.history(id);
    expect(readings).toHaveLength(2);
    // Oldest first: the order it grew in.
    expect(readings[0]!.impressions).toBe(100);
    expect(readings[1]!.impressions).toBe(340);
  });

  it('does not record the same reading twice in one minute', async () => {
    // A poller that runs twice is looking at one observation.
    const fixture = await createFixture();
    const id = post('2');
    const reading = {
      agentId: fixture.agentId,
      accountId: null,
      remotePostId: id,
      source: 'TIMELINE' as const,
      impressions: 10,
    };
    expect(await postAnalytics.record(reading)).not.toBeNull();
    expect(await postAnalytics.record(reading)).toBeNull();
    expect(await postAnalytics.history(id)).toHaveLength(1);
  });

  it('keeps the two sources apart, because they are different evidence', async () => {
    // A count read off a timeline and one read off the owner's analytics view
    // are not the same claim, and one must not suppress the other.
    const fixture = await createFixture();
    const id = post('3');
    const base = { agentId: fixture.agentId, accountId: null, remotePostId: id, impressions: 5 };
    expect(await postAnalytics.record({ ...base, source: 'TIMELINE' })).not.toBeNull();
    expect(await postAnalytics.record({ ...base, source: 'POST_ANALYTICS' })).not.toBeNull();
    expect(await postAnalytics.history(id)).toHaveLength(2);
  });

  it('says nothing about growth from a single reading', async () => {
    // One point is not a trend, and "up 0" about a post nobody looked at twice
    // is worse than saying nothing.
    const fixture = await createFixture();
    const id = post('4');
    await postAnalytics.record({
      agentId: fixture.agentId,
      accountId: null,
      remotePostId: id,
      source: 'TIMELINE',
      impressions: 7,
    });
    expect(await postAnalytics.growth(id)).toBeNull();
  });

  it('reports what moved between the first and last reading', async () => {
    const fixture = await createFixture();
    const id = post('5');
    await postAnalytics.record({
      agentId: fixture.agentId,
      accountId: null,
      remotePostId: id,
      source: 'TIMELINE',
      impressions: 100,
      likes: 1,
    });
    await query(
      `UPDATE post_analytics SET observed_at = observed_at - interval '5 minutes' WHERE remote_post_id = $1`,
      [id],
    );
    await postAnalytics.record({
      agentId: fixture.agentId,
      accountId: null,
      remotePostId: id,
      source: 'TIMELINE',
      impressions: 500,
      likes: 12,
    });

    const moved = await postAnalytics.growth(id);
    expect(moved).not.toBeNull();
    expect(moved).toContainEqual({ metric: 'impressions', from: 100, to: 500 });
    expect(moved).toContainEqual({ metric: 'likes', from: 1, to: 12 });
    // Nothing invented for a metric X never showed.
    expect(moved!.map((m) => m.metric)).not.toContain('bookmarks');
  });

  it('treats a metric X did not show as missing, not as zero', async () => {
    // An agent told a post got zero impressions will say so.
    const fixture = await createFixture();
    const id = post('6');
    const row = await postAnalytics.record({
      agentId: fixture.agentId,
      accountId: null,
      remotePostId: id,
      source: 'TIMELINE',
      likes: 3,
    });
    expect(row!.likes).toBe(3);
    expect(row!.impressions).toBeNull();
    expect(row!.profile_visits).toBeNull();
  });
});
