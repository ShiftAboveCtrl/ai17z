import { describe, expect, it } from 'vitest';
import { accounts as accountsRepo, postAnalytics, query } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * The account's own numbers, and the rules the recording follows.
 *
 * The browser half -- reading a profile page -- is proved against real X. What
 * is proved here is everything the recording promises around it, because each
 * of these is a silent wrong answer rather than a failure:
 *
 *   a reading with nothing in it must not occupy the minute the real one needs;
 *   a metric X did not show is missing, never zero;
 *   two instances measuring at once must not appear in each other's series.
 *
 * The last matters because both golden installations run on one machine against
 * one browser binary, and a series that mixed them would be a follower count
 * for the wrong account presented as this one's.
 */
describe('recording what the account looked like', () => {
  it('keeps a metric X did not show as missing rather than zero', async () => {
    // An agent told it has zero followers will say so.
    const fixture = await createFixture();
    const row = await postAnalytics.recordAccount({
      agentId: fixture.agentId,
      accountId: null,
      handle: 'nova',
      followers: 1_284,
    });
    expect(row!.followers).toBe(1_284);
    expect(row!.following).toBeNull();
  });

  it('does not let one agent’s reading appear in another’s series', async () => {
    // Two installations, one machine. A series that mixed them would report
    // somebody else's follower count as this account's.
    const a = await createFixture();
    const b = await createFixture();
    await postAnalytics.recordAccount({ agentId: a.agentId, accountId: null, handle: 'first', followers: 10 });
    await postAnalytics.recordAccount({ agentId: b.agentId, accountId: null, handle: 'second', followers: 999 });

    const seriesA = await postAnalytics.accountHistory(a.agentId);
    expect(seriesA).toHaveLength(1);
    expect(seriesA[0]!.followers).toBe(10);
    expect(seriesA.map((row) => row.handle)).not.toContain('second');
  });

  it('builds a series from readings taken apart, oldest first', async () => {
    const fixture = await createFixture();
    await postAnalytics.recordAccount({ agentId: fixture.agentId, accountId: null, handle: 'nova', followers: 100 });
    await query(
      `UPDATE account_analytics SET observed_at = observed_at - interval '1 day' WHERE agent_id = $1`,
      [fixture.agentId],
    );
    await postAnalytics.recordAccount({ agentId: fixture.agentId, accountId: null, handle: 'nova', followers: 100 });

    const series = await postAnalytics.accountHistory(fixture.agentId);
    // Two readings of an unchanged number are still a series: the claim is
    // "measured twice, no movement", which is a different thing from "measured
    // once and assumed".
    expect(series).toHaveLength(2);
    expect(series.map((row) => row.followers)).toEqual([100, 100]);
    expect(new Date(series[0]!.observed_at).getTime()).toBeLessThan(new Date(series[1]!.observed_at).getTime());
  });

  it('records one reading a minute, so a poll that runs twice is one state', async () => {
    const fixture = await createFixture();
    const reading = { agentId: fixture.agentId, accountId: null, handle: 'nova', followers: 100 };
    expect(await postAnalytics.recordAccount(reading)).not.toBeNull();
    expect(await postAnalytics.recordAccount(reading)).toBeNull();
    expect(await postAnalytics.accountHistory(fixture.agentId)).toHaveLength(1);
  });

  it('knows when the account was last looked at, so a cadence can be kept', async () => {
    // The radar's own-threads source asks this to decide whether to spend a
    // cycle on the account instead of on a post. Returning nothing for an
    // account never read is what makes the first reading happen at all.
    const fixture = await createFixture();
    const account = await accountsRepo.createAccount({
      ownerId: fixture.ownerId,
      channel: 'x',
      handle: `cad_${uniqueSuffix()}`,
    });
    expect(await postAnalytics.lastAccountReadingAt(account.id)).toBeNull();

    await postAnalytics.recordAccount({
      agentId: fixture.agentId,
      accountId: account.id,
      handle: account.handle,
      followers: 5,
    });
    const seen = await postAnalytics.lastAccountReadingAt(account.id);
    expect(seen).not.toBeNull();
    expect(Date.now() - new Date(seen!).getTime()).toBeLessThan(60_000);
  });

  it('ties the reading to the account it was taken from', async () => {
    const fixture = await createFixture();
    const account = await accountsRepo.createAccount({
      ownerId: fixture.ownerId,
      channel: 'x',
      handle: `obs_${uniqueSuffix()}`,
    });
    const row = await postAnalytics.recordAccount({
      agentId: fixture.agentId,
      accountId: account.id,
      handle: account.handle,
      followers: 7,
      following: 3,
    });
    expect(row!.account_id).toBe(account.id);
    expect(row!.handle).toBe(account.handle);
  });
});
