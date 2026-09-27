import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RadarPollResult, RadarSourceKind } from '@xbam/shared/contracts';
import { PolicyConfig } from '@xbam/shared/contracts';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  events as eventsRepo,
  query,
  radar as radarRepo,
  targets as targetsRepo,
  withTransaction,
  xCapacity,
  type RadarSourceRow,
} from '@xbam/database';
import { getChannelAdapter } from '@xbam/channels';
import {
  checkActionRate,
  checkReadCapacity,
  checkWriteCapacity,
  growthGateFor,
  ingestNormalizedEvent,
  noteXFailure,
  settleAccountCapacity,
} from '@xbam/runtime';
import { SocialRadar } from '../../apps/worker/src/radar';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * The account's X budget, exercised through the real radar.
 *
 * The adapter's poll is the one thing replaced, so nothing here opens a
 * browser or reaches x.com; everything the radar does around it -- the budget
 * check, the deferral, the cursor, the health, the ledger -- is the shipped
 * code.
 */

class Radar extends SocialRadar {
  poll(source: RadarSourceRow): Promise<void> {
    return this.pollOne(source);
  }
}

const xAdapter = getChannelAdapter('x');

function scriptPolls(answer: (kind: string) => RadarPollResult) {
  const calls: string[] = [];
  vi.spyOn(xAdapter, 'pollRadarSource').mockImplementation(async (_ctx, request) => {
    calls.push(request.kind);
    return answer(request.kind);
  });
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function xAccount() {
  const fixture = await createFixture();
  const account = await accountsRepo.createAccount({
    ownerId: fixture.ownerId,
    channel: 'x',
    handle: `cap_${uniqueSuffix()}`,
  });
  await accountsRepo.updateAccount(account.id, { status: 'CONNECTED', enabled: true });
  await accountsRepo.linkAgentAccount({
    agentId: fixture.agentId,
    accountId: account.id,
    triggerEventTypes: ['MENTION', 'REPLY'],
    actionType: 'REPLY',
  });
  return { ...fixture, account };
}

async function source(accountId: string, kind: RadarSourceKind, target: string | null = null) {
  const row = await radarRepo.upsertSource({ accountId, kind, target, config: { intervalSeconds: 60 } });
  return (await radarRepo.getSource(row.id))!;
}

async function reads(accountId: string, n: number) {
  for (let i = 0; i < n; i += 1) await xCapacity.recordRead(accountId, 'DIRECT');
}

const empty: RadarPollResult = { candidates: [], cursor: null, error: null };

describe('a failed read moves nothing forward', () => {
  it('keeps the cursor, marks the source, and counts a page X never drew as pressure', async () => {
    const { account } = await xAccount();
    const watch = await source(account.id, 'tracked_account', 'someone');
    await query(`UPDATE radar_sources SET cursor = '1900000000000000100' WHERE id = $1`, [watch.id]);
    scriptPolls(() => ({
      candidates: [],
      cursor: null,
      error: 'tracked_account: X never finished drawing @someone: it showed its loading screen and nothing else.',
    }));

    await new Radar().poll((await radarRepo.getSource(watch.id))!);

    const after = (await radarRepo.getSource(watch.id))!;
    expect(after.cursor).toBe('1900000000000000100');
    expect(after.status).toBe('DEGRADED');
    expect(after.consecutiveFailures).toBe(1);
    const usage = await xCapacity.usage(account.id, new Date(Date.now() - 60_000));
    expect(usage.stalled).toBe(1);
    expect(usage.readsByClass.TARGET).toBe(1);
  });

  it('is not recorded as a healthy empty poll however many times it happens', async () => {
    const { account } = await xAccount();
    const mentions = await source(account.id, 'mention_search');
    scriptPolls(() => ({ candidates: [], cursor: null, error: 'mention_search: X never finished drawing the search.' }));
    const radar = new Radar();
    await radar.poll((await radarRepo.getSource(mentions.id))!);
    await radar.poll((await radarRepo.getSource(mentions.id))!);

    const after = (await radarRepo.getSource(mentions.id))!;
    expect(after.status).not.toBe('HEALTHY');
    const state = await xCapacity.getState(account.id);
    // Two stalls since the breaker last moved: reading less.
    expect(state!.health).toBe('DEGRADED');
  });
});

describe('when X asks the account to slow down', () => {
  async function coolingDown() {
    const fixture = await xAccount();
    for (let i = 0; i < 3; i += 1) {
      await noteXFailure(fixture.account.id, 'BROAD', 'X asked AI17Z to slow down. It stopped rather than pushing.');
    }
    return fixture;
  }

  it('pauses broad looking and watched accounts, and still reads what people sent', async () => {
    const { account } = await coolingDown();
    expect((await xCapacity.getState(account.id))!.health).toBe('COOLDOWN');

    const keyword = await source(account.id, 'tracked_keyword', 'robinhood chain');
    const watch = await source(account.id, 'tracked_account', 'owner_pick');
    const notifications = await source(account.id, 'notifications');
    const calls = scriptPolls(() => empty);
    const radar = new Radar();

    await radar.poll(keyword);
    await radar.poll(watch);
    await radar.poll(notifications);

    expect(calls).toEqual(['notifications']);
    for (const held of [keyword, watch]) {
      const after = (await radarRepo.getSource(held.id))!;
      // Deferred, not failed and not quiet: nothing about the source moved.
      expect(after.idleReason).toMatch(/cooling down/i);
      expect(after.status).toBe(held.status);
      expect(after.consecutiveFailures).toBe(0);
      expect(after.lastSuccessAt).toBe(held.lastSuccessAt);
      // Until the cooldown ends, not in five seconds.
      expect(new Date(after.nextPollAt!).getTime() - Date.now()).toBeGreaterThan(10 * 60_000);
    }
  });

  it('holds every action the agent would start itself, and says until when', async () => {
    const { account, agentId } = await coolingDown();
    expect((await checkActionRate(agentId, PolicyConfig.parse({}), account.id, 'DIRECT')).allow).toBe(true);
    for (const klass of ['TARGET', 'BROAD'] as const) {
      const gate = await checkActionRate(agentId, PolicyConfig.parse({}), account.id, klass);
      expect(gate.allow, klass).toBe(false);
      if (!gate.allow) {
        expect(gate.kind).toBe('RETRYABLE');
        // Waited out, never charged as an attempt: the pipeline sends a gate's
        // time to waitForLimit.
        expect(gate.retryAfterMs!).toBeGreaterThan(10 * 60_000);
      }
    }
  });

  it('stops growth sessions, with the moment it can resume', async () => {
    const { account, agentId } = await coolingDown();
    const verdict = await growthGateFor(agentId, account.id, PolicyConfig.parse({ growth: { quietHoursEnabled: false } }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.state).toBe('HELD');
    expect(verdict.message).toMatch(/slow down/i);
    expect(verdict.retryAfterMs!).toBeGreaterThan(10 * 60_000);
  });

  it('touches no other account', async () => {
    const cooled = await coolingDown();
    const other = await xAccount();
    expect((await checkReadCapacity(cooled.account.id, 'BROAD')).allowed).toBe(false);
    expect((await checkReadCapacity(other.account.id, 'BROAD')).allowed).toBe(true);
    expect((await checkWriteCapacity(other.account.id, 'BROAD')).allowed).toBe(true);
  });
});

describe('the budget', () => {
  it('lets broad looking yield first when the account is busy', async () => {
    const { account } = await xAccount();
    await reads(account.id, 30);
    const keyword = await source(account.id, 'tracked_keyword', 'pons');
    const mentions = await source(account.id, 'mention_search');
    const calls = scriptPolls(() => empty);
    const radar = new Radar();

    await radar.poll(keyword);
    await radar.poll(mentions);

    expect(calls).toEqual(['mention_search']);
    expect((await radarRepo.getSource(keyword.id))!.idleReason).toMatch(/stay free for people who wrote in/);
  });

  it('still goes looking while people are being answered, because the busy half is direct', async () => {
    const { account } = await xAccount();
    await reads(account.id, 27);
    const keyword = await source(account.id, 'tracked_keyword', 'robinhood chain');
    const calls = scriptPolls(() => empty);
    await new Radar().poll(keyword);
    expect(calls).toEqual(['tracked_keyword']);
  });

  it('cannot flood X when a worker comes back to a pile of overdue sources', async () => {
    /*
      A restart finds every source due at once. Without a shared budget, each
      one is polled the moment it is claimed and X sees the whole backlog in a
      minute. With it, broad looking takes its share and waits for the rest.
    */
    const { account } = await xAccount();
    const sources: RadarSourceRow[] = [];
    for (let i = 0; i < 20; i += 1) sources.push(await source(account.id, 'tracked_keyword', `topic ${i}`));
    const calls = scriptPolls(() => empty);
    const radar = new Radar();
    for (const row of sources) await radar.poll(row);

    expect(calls.length).toBe(12);
    const usage = await xCapacity.usage(account.id, new Date());
    expect(usage.readsLast10Minutes).toBe(12);
  });
});

describe('recovery', () => {
  it('comes back through a slower spell, and a relapse costs more than the first trip', async () => {
    const { account } = await xAccount();
    for (let i = 0; i < 3; i += 1) await noteXFailure(account.id, 'DIRECT', 'X asked AI17Z to slow down.');
    let state = (await xCapacity.getState(account.id))!;
    expect(state.health).toBe('COOLDOWN');
    expect(state.healthStrikes).toBe(1);

    // The cooldown runs out.
    await query(`UPDATE accounts SET health_until = now() - interval '1 second' WHERE id = $1`, [account.id]);
    await settleAccountCapacity(account.id);
    state = (await xCapacity.getState(account.id))!;
    expect(state.health).toBe('DEGRADED');
    expect(state.healthReason).toMatch(/recovering/i);
    expect((await checkReadCapacity(account.id, 'BROAD')).allowed).toBe(true);
    expect((await checkWriteCapacity(account.id, 'BROAD')).allowed).toBe(false);

    // X pushes back again during recovery: a longer cooldown, not a retry loop.
    await noteXFailure(account.id, 'DIRECT', 'X asked AI17Z to slow down.');
    state = (await xCapacity.getState(account.id))!;
    expect(state.health).toBe('COOLDOWN');
    expect(state.healthStrikes).toBe(2);
    const minutesLeft = (new Date(state.healthUntil!).getTime() - Date.now()) / 60_000;
    expect(minutesLeft).toBeGreaterThan(25);
    expect(minutesLeft).toBeLessThanOrEqual(30);
  });

  it('is healthy again once recovery ends clean', async () => {
    const { account } = await xAccount();
    await xCapacity.setState({
      accountId: account.id,
      health: 'DEGRADED',
      reason: 'Recovering from a cooldown.',
      until: new Date(Date.now() - 1_000),
      strikes: 1,
    });
    const next = await settleAccountCapacity(account.id);
    expect(next!.health).toBe('HEALTHY');
    expect(next!.strikes).toBe(0);
  });
});

describe('an owner-watched account keeps its place', () => {
  it('never moves its cursor backwards when older posts arrive after newer ones', async () => {
    const { account, agentId } = await xAccount();
    const watch = await source(account.id, 'tracked_account', 'owner_pick');
    const record = (postId: string) =>
      withTransaction(async (tx) => {
        const { event } = await eventsRepo.ingestEvent(tx, account.id, {
          channel: 'x',
          type: 'TARGET_ACCOUNT_ACTIVITY',
          remoteEventId: postId,
          remoteMessageId: postId,
          remoteAuthorId: '77',
          remoteAuthorHandle: 'owner_pick',
          remoteAuthorDisplayName: null,
          remoteConversationId: postId,
          parentRemoteMessageId: null,
          remoteUrl: `https://x.com/owner_pick/status/${postId}`,
          text: 'an update',
          occurredAt: new Date().toISOString(),
          raw: {},
        });
        await targetsRepo.recordIngest(tx, {
          sourceId: watch.id,
          eventId: event.id,
          remotePostId: postId,
          remoteUserId: '77',
          handle: 'owner_pick',
          displayName: null,
          mode: 'ENGAGE',
          outcomes: [{ agentId, jobId: null, created: false, disposition: 'CONSIDERING', reason: 'Queued.' }],
        });
      });

    // A poll returns newest first; a later poll can surface an older post.
    await record('1900000000000000300');
    await record('1900000000000000200');
    await record('999000000000000000');

    const [target] = await targetsRepo.listAgentTargets(agentId);
    expect(target!.lastSeenPostId).toBe('1900000000000000300');
    expect(target!.lastProcessedPostId).toBe('1900000000000000300');
  });
});

describe('quiet hours belong to one agent', () => {
  it('switches off for the agent that asked and nobody else, and survives a restart', async () => {
    const allDay = await xAccount();
    const ordinary = await xAccount();
    const active = await agentsRepo.getActivePolicy(allDay.agentId);
    const config = PolicyConfig.parse(active!.config);
    // Both start from the product default, which rests overnight.
    for (const agentId of [allDay.agentId, ordinary.agentId]) {
      await agentsRepo.savePolicyVersion(
        agentId,
        { ...config, growth: { ...config.growth, quietHoursEnabled: true } },
        'The default.',
        null,
      );
    }
    await agentsRepo.savePolicyVersion(
      allDay.agentId,
      { ...config, growth: { ...config.growth, quietHoursEnabled: false } },
      'Growth around the clock for this agent only.',
      null,
    );

    // Read back from the database, which is all a restarted worker has.
    const reread = PolicyConfig.parse((await agentsRepo.getActivePolicy(allDay.agentId))!.config);
    expect(reread.growth.quietHoursEnabled).toBe(false);
    const untouched = PolicyConfig.parse((await agentsRepo.getActivePolicy(ordinary.agentId))!.config);
    expect(untouched.growth.quietHoursEnabled).toBe(true);

    const threeAm = new Date(Date.UTC(2026, 8, 27, 3, 0, 0));
    expect((await growthGateFor(allDay.agentId, allDay.account.id, reread, threeAm)).state).toBe('ELIGIBLE');
    expect((await growthGateFor(ordinary.agentId, ordinary.account.id, untouched, threeAm)).state).toBe('QUIET_HOURS');
  });
});

describe('broad discovery says what it declined, and whom it would reach', () => {
  it('records the audience, holds an owner floor, and never applies it to somebody who wrote in', async () => {
    const fixture = await createFixture({
      policy: {
        outreach: PolicyConfig.parse({}).outreach && {
          ...PolicyConfig.parse({}).outreach,
          enabled: true,
          mode: 'AUTONOMOUS',
          requireTopicMatch: false,
          minAuthorFollowers: 500,
          maxPerHour: 10,
          cooldownDaysPerAuthor: 0,
        },
        engagement: { ...PolicyConfig.parse({}).engagement, strategy: 'SELECTIVE' },
      },
    });
    const account = await accountsRepo.createAccount({ ownerId: fixture.ownerId, channel: 'x', handle: `floor_${uniqueSuffix()}` });
    await accountsRepo.updateAccount(account.id, { status: 'CONNECTED', enabled: true });
    await accountsRepo.linkAgentAccount({
      agentId: fixture.agentId,
      accountId: account.id,
      triggerEventTypes: ['MENTION', 'REPLY'],
      actionType: 'REPLY',
    });
    const event = (id: string, type: 'KEYWORD_MATCH' | 'MENTION', followers: number, text: string) => ({
      channel: 'x' as const,
      type,
      remoteEventId: id,
      remoteMessageId: id,
      remoteAuthorId: `a${id}`,
      remoteAuthorHandle: `author_${id}`,
      remoteAuthorDisplayName: null,
      remoteConversationId: id,
      parentRemoteMessageId: null,
      remoteUrl: `https://x.com/author_${id}/status/${id}`,
      text,
      occurredAt: new Date().toISOString(),
      raw: { author: { followers } },
    });

    const small = await ingestNormalizedEvent({
      accountId: account.id,
      event: event('1900000000000000401', 'KEYWORD_MATCH', 120, 'Robinhood Chain throughput numbers look better than expected this week, what changed?'),
    });
    expect(small.jobs.filter((j) => j.created)).toHaveLength(0);
    expect(small.skipped[0]?.reason).toMatch(/120 followers, below this agent's floor of 500/);

    const direct = await ingestNormalizedEvent({
      accountId: account.id,
      event: event('1900000000000000402', 'MENTION', 5, `@${account.handle} what do you think about the Robinhood Chain fee change?`),
    });
    expect(direct.jobs.filter((j) => j.created)).toHaveLength(1);

    const rows = await query<{ decision: string; author_followers: number | null; reason: string }>(
      `SELECT decision, author_followers, reason FROM broad_candidate_decisions WHERE agent_id = $1`,
      [fixture.agentId],
    );
    // Only the post it came across is a broad candidate. The mention is not.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: 'DECLINED', author_followers: 120 });
  });
});
