import { describe, expect, it } from 'vitest';
import { accounts as accountsRepo, radar as radarRepo } from '@xbam/database';
import { DEFAULT_X_RADAR, ensureDefaultRadarSources } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

async function anXAccount() {
  const fixture = await createFixture();
  const account = await accountsRepo.createAccount({
    ownerId: fixture.ownerId,
    channel: 'x',
    handle: `handle_${uniqueSuffix()}`,
    displayName: 'Test',
    remoteAccountId: null,
    capabilities: ['REPLY'],
    settings: {},
  });
  return { ...fixture, accountId: account.id };
}

/**
 * A connected X account has to be watched by more than the notifications page.
 *
 * There are two pollers. The channel poller loads x.com/notifications/mentions
 * and is what most people see the browser doing. The radar is the other four --
 * searching for the handle, searching for replies to it, and walking the
 * agent's own threads -- and it only runs sources that exist as rows.
 *
 * Those rows were opt-in, behind a button, on the theory that each one costs a
 * page load. So a real account came up connected, reported itself ready, and
 * had exactly one surface looking at it. That is precisely the case the mention
 * search was written for: "a quiet notifications surface is no longer silence"
 * only holds if the search is running.
 *
 * Found by reading a live installation: thirty mentions ingested, and zero rows
 * in radar_sources.
 */
describe('a new X account is actually watched', () => {
  it('gets all four monitors', async () => {
    const { accountId } = await anXAccount();
    const created = await ensureDefaultRadarSources(accountId);

    const kinds = (await radarRepo.listSources(accountId)).map((s) => s.kind).sort();
    expect(kinds).toEqual(DEFAULT_X_RADAR.map((p) => p.kind).sort());
    expect(created.sort()).toEqual(DEFAULT_X_RADAR.map((p) => p.kind).sort());
  });

  it('gives each one the interval it was designed with', async () => {
    // All four on the same schedule would mean four page loads at once, every
    // time, which is the cost the opt-in was avoiding. They are staggered.
    const { accountId } = await anXAccount();
    await ensureDefaultRadarSources(accountId);

    const sources = await radarRepo.listSources(accountId);
    for (const preset of DEFAULT_X_RADAR) {
      const source = sources.find((s) => s.kind === preset.kind);
      expect(source?.config?.intervalSeconds, `${preset.kind} has no interval`).toBe(preset.intervalSeconds);
    }
  });

  it('is safe to call again, and creates nothing the second time', async () => {
    // It runs on every start, so this is the common case rather than an edge.
    const { accountId } = await anXAccount();
    await ensureDefaultRadarSources(accountId);
    const again = await ensureDefaultRadarSources(accountId);

    expect(again).toEqual([]);
    expect((await radarRepo.listSources(accountId)).length).toBe(DEFAULT_X_RADAR.length);
  });

  it('never switches back on something that was switched off', async () => {
    // A disabled source is an answer. Re-enabling it because a default says so
    // is worse than never having offered one -- and `upsertSource` would,
    // which is why what exists is read first.
    const { accountId } = await anXAccount();
    await ensureDefaultRadarSources(accountId);
    await radarRepo.upsertSource({ accountId, kind: 'reply_search', enabled: false, label: 'Reply search' });

    await ensureDefaultRadarSources(accountId);

    const replySearch = (await radarRepo.listSources(accountId)).find((s) => s.kind === 'reply_search');
    expect(replySearch?.enabled, 'a source the owner turned off came back on').toBe(false);
  });

  it('gives a mock account nothing, since it has no radar to run', async () => {
    const fixture = await createFixture();
    const account = await accountsRepo.createAccount({
      ownerId: fixture.ownerId,
      channel: 'mock',
      handle: `mock_${uniqueSuffix()}`,
      displayName: 'Mock',
      remoteAccountId: null,
      capabilities: ['REPLY'],
      settings: {},
    });

    expect(await ensureDefaultRadarSources(account.id)).toEqual([]);
    expect(await radarRepo.listSources(account.id)).toEqual([]);
  });

  it('says nothing rather than throwing for an account that is gone', async () => {
    expect(await ensureDefaultRadarSources('00000000-0000-0000-0000-000000000000')).toEqual([]);
  });
});

/**
 * The constraint is the thing that makes upsertSource an upsert.
 *
 * `UNIQUE (account_id, kind, target)` reads as "one source per kind per
 * account", and for the kinds that carry a target it is. For the four that do
 * not it said nothing: SQL nulls are distinct, so two rows with the same
 * account, the same kind and a null target did not conflict, ON CONFLICT never
 * fired, and every call inserted another row.
 *
 * The expensive half was not the duplicates. Easy Mode turns an unwanted
 * monitor off by upserting it disabled -- which wrote a second, disabled row
 * and left the enabled one polling. The setting looked applied and did nothing.
 *
 * Migration 0058 makes the nulls not distinct. This is the property, tested
 * against the database rather than the repository, because the repository was
 * always written as though this already held.
 */
describe('one radar source per kind, target or no target', () => {
  it('updates rather than duplicating when there is no target', async () => {
    const { accountId } = await anXAccount();
    await radarRepo.upsertSource({ accountId, kind: 'mention_search', label: 'first' });
    await radarRepo.upsertSource({ accountId, kind: 'mention_search', label: 'second' });

    const rows = (await radarRepo.listSources(accountId)).filter((s) => s.kind === 'mention_search');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe('second');
  });

  it('actually turns a source off', async () => {
    // The one that cost something: disabling wrote a disabled duplicate and
    // the enabled row went on being claimed by the poller.
    const { accountId } = await anXAccount();
    await radarRepo.upsertSource({ accountId, kind: 'reply_search', enabled: true, label: 'on' });
    await radarRepo.upsertSource({ accountId, kind: 'reply_search', enabled: false, label: 'off' });

    const rows = (await radarRepo.listSources(accountId)).filter((s) => s.kind === 'reply_search');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enabled, 'the source is still enabled after being turned off').toBe(false);
  });

  it('still keeps sources with different targets apart', async () => {
    // The constraint has to go on doing its original job: two watched accounts
    // are two sources.
    const { accountId } = await anXAccount();
    await radarRepo.upsertSource({ accountId, kind: 'tracked_account', target: 'alice', label: 'Alice' });
    await radarRepo.upsertSource({ accountId, kind: 'tracked_account', target: 'bob', label: 'Bob' });

    const targets = (await radarRepo.listSources(accountId))
      .filter((s) => s.kind === 'tracked_account')
      .map((s) => s.target)
      .sort();
    expect(targets).toEqual(['alice', 'bob']);
  });
});
