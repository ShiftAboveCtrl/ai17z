import { describe, expect, it } from 'vitest';
import { accounts as accountsRepo, radar as radarRepo, query } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * A source that says it is healthy has to mean it.
 *
 * Every fault in this file was found on one live installation, and all of them
 * wore the same disguise: a green light over a source that had not produced
 * anything for hours or days. `status` was HEALTHY, `consecutive_failures` was
 * zero, `last_success_at` was a minute old, and nothing had been read.
 */

async function connectedAccount(ownerId: string, agentId: string) {
  const account = await accountsRepo.createAccount({
    ownerId,
    channel: 'mock',
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

describe('a cursor is a claim about what has been seen', () => {
  it('is not moved by a poll that could not read the page', async () => {
    const fixture = await createFixture();
    const account = await connectedAccount(fixture.ownerId, fixture.agentId);
    const source = await radarRepo.upsertSource({ accountId: account.id, kind: 'mention_search' });

    await radarRepo.recordPoll({ sourceId: source.id, nextPollAt: new Date(), found: 3, cursor: '111' });
    expect((await radarRepo.getSource(source.id))!.cursor).toBe('111');

    /*
      A failed poll saw nothing, so it cannot vouch for anything. Advancing the
      cursor here would close the very gap the failure opened: everything
      written between the old mark and the new one would be behind the
      high-water mark and never looked at again.
    */
    await radarRepo.recordPoll({
      sourceId: source.id,
      nextPollAt: new Date(),
      found: 0,
      cursor: '999',
      error: 'X could not show mention_search',
    });

    const after = (await radarRepo.getSource(source.id))!;
    expect(after.cursor).toBe('111');
    expect(after.status).toBe('DEGRADED');
    expect(after.consecutiveFailures).toBe(1);
  });

  it('recovers cleanly once the source works again', async () => {
    const fixture = await createFixture();
    const account = await connectedAccount(fixture.ownerId, fixture.agentId);
    const source = await radarRepo.upsertSource({ accountId: account.id, kind: 'notifications' });

    for (let i = 0; i < 3; i += 1) {
      await radarRepo.recordPoll({ sourceId: source.id, nextPollAt: new Date(), found: 0, error: 'browser gone' });
    }
    expect((await radarRepo.getSource(source.id))!.status).toBe('FAILING');

    await radarRepo.recordPoll({ sourceId: source.id, nextPollAt: new Date(), found: 2, cursor: '222' });
    const after = (await radarRepo.getSource(source.id))!;
    expect(after.status).toBe('HEALTHY');
    expect(after.consecutiveFailures).toBe(0);
    expect(after.cursor).toBe('222');
    expect(after.lastError).toBeNull();
  });
});

describe('an empty poll says which kind of empty it was', () => {
  it('keeps the reason a source had nothing to show', async () => {
    const fixture = await createFixture();
    const account = await connectedAccount(fixture.ownerId, fixture.agentId);
    const source = await radarRepo.upsertSource({ accountId: account.id, kind: 'own_threads' });

    await radarRepo.recordPoll({
      sourceId: source.id,
      nextPollAt: new Date(),
      found: 0,
      idleReason: 'nothing posted in the last 72 hours, so there is no thread to check for replies',
    });

    const after = (await radarRepo.getSource(source.id))!;
    // Still healthy, because nothing is wrong. But no longer silent about it:
    // "checked and found nothing" and "there was nothing to check" are
    // different facts and a poll count cannot tell them apart.
    expect(after.status).toBe('HEALTHY');
    expect(after.idleReason).toMatch(/nothing posted/);
  });

  it('clears the reason as soon as a poll actually reads something', async () => {
    const fixture = await createFixture();
    const account = await connectedAccount(fixture.ownerId, fixture.agentId);
    const source = await radarRepo.upsertSource({ accountId: account.id, kind: 'own_threads' });

    await radarRepo.recordPoll({ sourceId: source.id, nextPollAt: new Date(), found: 0, idleReason: 'nothing to do' });
    await radarRepo.recordPoll({ sourceId: source.id, nextPollAt: new Date(), found: 1 });
    expect((await radarRepo.getSource(source.id))!.idleReason).toBeNull();
  });

  it('records that a cycle was spent on the account even when the reading failed', async () => {
    const fixture = await createFixture();
    const account = await connectedAccount(fixture.ownerId, fixture.agentId);
    const source = await radarRepo.upsertSource({ accountId: account.id, kind: 'own_threads' });

    /*
      The eight-day fault, as a property.

      The own-threads source gives an occasional cycle to reading the account
      itself, and used to decide whether it was due by asking when the last
      reading was *stored*. A reading that fails stores nothing, so the first
      failure made it permanently due: every poll thereafter took that branch,
      failed, recorded a healthy zero, and returned without looking at a single
      thread. On the installation where this was found, the last stored reading
      and the last thread checked were both 2026-09-15, and the source went on
      polling every three minutes for eight days reporting HEALTHY.

      Recording the attempt is what breaks the loop.
    */
    await radarRepo.recordPoll({
      sourceId: source.id,
      nextPollAt: new Date(),
      found: 0,
      sideWork: true,
      idleReason: 'spent this cycle trying to read the account and could not: X showed neither count',
    });

    const after = (await radarRepo.getSource(source.id))!;
    expect(after.lastSideWorkAt, 'a failed reading still costs its cycle').not.toBeNull();
    expect(Date.now() - new Date(after.lastSideWorkAt!).getTime()).toBeLessThan(60_000);
    expect(after.status).toBe('HEALTHY');
  });

  it('leaves the mark alone on a poll that read the feed', async () => {
    const fixture = await createFixture();
    const account = await connectedAccount(fixture.ownerId, fixture.agentId);
    const source = await radarRepo.upsertSource({ accountId: account.id, kind: 'own_threads' });

    await radarRepo.recordPoll({ sourceId: source.id, nextPollAt: new Date(), found: 0, sideWork: true });
    const first = (await radarRepo.getSource(source.id))!.lastSideWorkAt;
    await radarRepo.recordPoll({ sourceId: source.id, nextPollAt: new Date(), found: 4 });
    expect((await radarRepo.getSource(source.id))!.lastSideWorkAt).toBe(first);
  });
});

describe('what the agent watches cannot get in front of who wrote to it', () => {
  it('takes direct sources first when more are due than a tick can hold', async () => {
    const fixture = await createFixture();
    const account = await connectedAccount(fixture.ownerId, fixture.agentId);

    // The keyword sources came due first, which under an ordering by lateness
    // alone is all it takes. On the installation where this was found the
    // direct sources were running four to six minutes late while the keyword
    // sources were not yet due at all.
    const keywords = [];
    for (const word of ['one', 'two', 'three', 'four']) {
      keywords.push(await radarRepo.upsertSource({ accountId: account.id, kind: 'tracked_keyword', target: word }));
    }
    const direct = [];
    for (const kind of ['notifications', 'mention_search'] as const) {
      direct.push(await radarRepo.upsertSource({ accountId: account.id, kind }));
    }

    await query(
      `UPDATE radar_sources SET next_poll_at = now() - interval '10 minutes' WHERE id = ANY($1::uuid[])`,
      [keywords.map((k) => k.id)],
    );
    await query(`UPDATE radar_sources SET next_poll_at = now() - interval '1 minute' WHERE id = ANY($1::uuid[])`, [
      direct.map((d) => d.id),
    ]);

    // Three slots, six sources due, and the four that came due first are all
    // optional. Both direct sources have to be in the claim regardless.
    const claimed = await radarRepo.claimDueSources(3, 60);
    const kinds = claimed.map((c) => c.kind);
    expect(kinds).toContain('notifications');
    expect(kinds).toContain('mention_search');
    expect(claimed).toHaveLength(3);
  });

  it('still gets to the optional sources when nothing direct is waiting', async () => {
    const fixture = await createFixture();
    const account = await connectedAccount(fixture.ownerId, fixture.agentId);

    const keyword = await radarRepo.upsertSource({
      accountId: account.id,
      kind: 'tracked_keyword',
      target: 'agent memory',
    });
    const mentions = await radarRepo.upsertSource({ accountId: account.id, kind: 'mention_search' });
    // The direct source is not due; the keyword one is. Priority is about
    // contention, and there is none here.
    await query(`UPDATE radar_sources SET next_poll_at = now() + interval '5 minutes' WHERE id = $1`, [mentions.id]);
    await query(`UPDATE radar_sources SET next_poll_at = now() - interval '1 minute' WHERE id = $1`, [keyword.id]);

    const claimed = await radarRepo.claimDueSources(3, 60);
    expect(claimed.map((c) => c.id)).toEqual([keyword.id]);
  });
});
