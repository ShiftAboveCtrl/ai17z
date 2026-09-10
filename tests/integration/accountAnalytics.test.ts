import { describe, expect, it } from 'vitest';
import { postAnalytics, query } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * What the account itself looked like, over time.
 *
 * `post_analytics` answers "how did that post do". This answers the question an
 * owner actually asks first -- whether any of it is adding up -- and it has the
 * same two rules for the same reasons: two readings a day apart are the
 * smallest useful unit, and a metric X did not show is missing rather than
 * zero.
 *
 * Against real Postgres because the guarantee is a unique index that buckets on
 * a lower-cased handle and a UTC minute. A handle's case changes on X without
 * anything else changing, and a mock would happily record the same state twice.
 */
describe('recording what the account looked like', () => {
  it('keeps every reading, so a series is a series', async () => {
    const fixture = await createFixture();
    expect(
      await postAnalytics.recordAccount({
        agentId: fixture.agentId,
        accountId: null,
        handle: 'nova',
        followers: 100,
        following: 80,
      }),
    ).not.toBeNull();

    await query(
      `UPDATE account_analytics SET observed_at = observed_at - interval '2 days' WHERE agent_id = $1`,
      [fixture.agentId],
    );
    expect(
      await postAnalytics.recordAccount({
        agentId: fixture.agentId,
        accountId: null,
        handle: 'nova',
        followers: 140,
        following: 82,
      }),
    ).not.toBeNull();

    const series = await postAnalytics.accountHistory(fixture.agentId);
    expect(series).toHaveLength(2);
    // Oldest first: the order it grew in.
    expect(series[0]!.followers).toBe(100);
    expect(series[1]!.followers).toBe(140);
  });

  it('records one reading a minute however often it is looked at', async () => {
    // Two reads in the same minute are looking at one state, and recording both
    // would make a flat line look like activity.
    const fixture = await createFixture();
    const reading = { agentId: fixture.agentId, accountId: null, handle: 'nova', followers: 100 };
    expect(await postAnalytics.recordAccount(reading)).not.toBeNull();
    expect(await postAnalytics.recordAccount(reading)).toBeNull();
    expect(await postAnalytics.accountHistory(fixture.agentId)).toHaveLength(1);
  });

  it('treats a handle as the same handle whatever its capitals', async () => {
    // X changes the display case of a handle without anything else changing,
    // and a series that split in two the day somebody did that would look like
    // an account that started again from nothing.
    const fixture = await createFixture();
    expect(
      await postAnalytics.recordAccount({ agentId: fixture.agentId, accountId: null, handle: 'Nova', followers: 100 }),
    ).not.toBeNull();
    expect(
      await postAnalytics.recordAccount({ agentId: fixture.agentId, accountId: null, handle: 'nova', followers: 101 }),
    ).toBeNull();
  });

  it('leaves a count X did not show missing rather than zero', async () => {
    // An agent told it has zero followers will say so.
    const fixture = await createFixture();
    const row = await postAnalytics.recordAccount({
      agentId: fixture.agentId,
      accountId: null,
      handle: 'nova',
      followers: 100,
    });
    expect(row!.followers).toBe(100);
    expect(row!.following).toBeNull();
  });

  it('says nothing about growth from a single reading', async () => {
    // One point is not a trend. The screen decides what to show, but it can
    // only do that honestly if the series says how many readings there were.
    const fixture = await createFixture();
    await postAnalytics.recordAccount({ agentId: fixture.agentId, accountId: null, handle: 'nova', followers: 100 });
    expect(await postAnalytics.accountHistory(fixture.agentId)).toHaveLength(1);
  });
});
