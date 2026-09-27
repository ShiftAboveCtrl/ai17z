import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RadarCandidate } from '@xbam/shared/contracts';
import { PolicyConfig } from '@xbam/shared/contracts';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  query,
  radar as radarRepo,
  type RadarSourceRow,
} from '@xbam/database';
import { getChannelAdapter } from '@xbam/channels';
import { requestDiscovery } from '@xbam/runtime';
import { SocialRadar } from '../../apps/worker/src/radar';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * The agent going looking on its own, through the real radar.
 *
 * Only the adapter's read is replaced, so no browser opens and nothing reaches
 * x.com. What is under test is everything around it: which search is chosen,
 * whether it is allowed to run, what is kept, and what it becomes.
 */

class Radar extends SocialRadar {
  poll(source: RadarSourceRow): Promise<void> {
    return this.pollOne(source);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function growingAgent(growth: Record<string, unknown> = {}) {
  const fixture = await createFixture({
    persona: { topics: ['Robinhood Chain', '$PONS', 'builders', 'God and faith'] },
  });
  await agentsRepo.updateAgent(fixture.agentId, { state: 'ACTIVE' });
  const active = PolicyConfig.parse((await agentsRepo.getActivePolicy(fixture.agentId))!.config);
  await agentsRepo.savePolicyVersion(
    fixture.agentId,
    PolicyConfig.parse({
      ...active,
      outreach: { ...active.outreach, enabled: true, mode: 'AUTONOMOUS', maxPerHour: 10, cooldownDaysPerAuthor: 0 },
      growth: { ...active.growth, maxCandidatesPerSession: 2, ...growth },
    }),
    'test',
    null,
  );
  const account = await accountsRepo.createAccount({ ownerId: fixture.ownerId, channel: 'x', handle: `disc_${uniqueSuffix()}` });
  await accountsRepo.updateAccount(account.id, { status: 'CONNECTED', enabled: true });
  await accountsRepo.linkAgentAccount({
    agentId: fixture.agentId,
    accountId: account.id,
    triggerEventTypes: ['MENTION', 'REPLY'],
    actionType: 'REPLY',
  });
  const source = await radarRepo.upsertSource({ accountId: account.id, kind: 'persona_discovery', config: { minFaves: 25 } });
  return { ...fixture, account, source: (await radarRepo.getSource(source.id))! };
}

const found = (id: string, followers: number, likes: number): RadarCandidate => ({
  remoteId: id,
  remoteUrl: `https://x.com/a${id}/status/${id}`,
  authorHandle: `a${id}`,
  authorId: `u${id}`,
  authorDisplayName: null,
  text: 'Robinhood Chain throughput this week is the most interesting thing happening onchain right now',
  parentRemoteId: null,
  conversationRemoteId: id,
  occurredAt: new Date().toISOString(),
  eventType: 'POST',
  raw: { author: { followers }, metrics: { likes } },
});

function scripted(results: RadarCandidate[]) {
  const asked: { kind: string; target: string | null }[] = [];
  vi.spyOn(getChannelAdapter('x'), 'pollRadarSource').mockImplementation(async (_ctx, request) => {
    asked.push({ kind: request.kind, target: request.target });
    return { candidates: results, cursor: results[0]?.remoteId ?? null, error: null };
  });
  return asked;
}

describe('an agent going looking on its own', () => {
  it('searches its own specific topics for posts people already respond to, and keeps only the best', async () => {
    const agent = await growingAgent();
    const asked = scripted([
      found('1900000000000000501', 40, 30),
      found('1900000000000000502', 180_000, 400),
      found('1900000000000000503', 12_000, 60),
    ]);
    await new Radar().poll(agent.source);

    expect(asked).toHaveLength(1);
    expect(asked[0]!.target).toBe('"Robinhood Chain" min_faves:25 lang:en -filter:replies -filter:retweets');

    // Two kept, the biggest audiences, and each one a candidate the agent came across.
    const events = await query<{ remote_event_id: string; type: string }>(
      `SELECT remote_event_id, type FROM events WHERE account_id = $1 ORDER BY remote_event_id`,
      [agent.account.id],
    );
    expect(events.map((e) => e.remote_event_id)).toEqual(['1900000000000000502', '1900000000000000503']);
    expect(events.every((e) => e.type === 'KEYWORD_MATCH')).toBe(true);

    const after = (await radarRepo.getSource(agent.source.id))!;
    expect(after.cursor).toBe('rotation:1');
    expect(after.idleReason).toMatch(/Searched Robinhood Chain: 3 found, 0 already seen, kept the best 2/);

    // The next session searches the next term, and never the personal or vague ones.
    await new Radar().poll(after);
    expect(asked[1]!.target).toMatch(/^\$PONS min_faves:25/);
    const again = (await radarRepo.getSource(agent.source.id))!;
    expect(again.cursor).toBe('rotation:0');
  });

  it('spends its places on posts it has not seen before', async () => {
    /*
      Popular posts stay popular for hours. Measured on a live agent: the same
      ones came back search after search, the ranker kept choosing them, and
      each was refused downstream as already on record.
    */
    const agent = await growingAgent();
    const big = found('1900000000000000951', 900_000, 900);
    const small = found('1900000000000000952', 5_000, 40);
    scripted([big, small]);
    await new Radar().poll(agent.source);
    // Seen once. The next search returns the same big post and a new one.
    const newer = found('1900000000000000953', 3_000, 20);
    scripted([big, newer]);
    await new Radar().poll((await radarRepo.getSource(agent.source.id))!);

    const ids = (
      await query<{ remote_event_id: string }>(`SELECT remote_event_id FROM events WHERE account_id = $1`, [agent.account.id])
    ).map((r) => r.remote_event_id);
    expect(ids).toContain('1900000000000000953');
    expect((await radarRepo.getSource(agent.source.id))!.idleReason).toMatch(/2 found, 1 already seen, kept the best 1/);
  });

  it('does not spend a place on a post too old to answer', async () => {
    /*
      Measured on a live agent: of three kept, ingest refused two as two and
      three hours old, and the session approached one post instead of three.
    */
    const agent = await growingAgent();
    const old = { ...found('1900000000000000971', 900_000, 900), occurredAt: new Date(Date.now() - 3 * 3_600_000).toISOString() };
    const current = found('1900000000000000972', 4_000, 30);
    const alsoCurrent = found('1900000000000000973', 3_000, 20);
    scripted([old, current, alsoCurrent]);
    await new Radar().poll(agent.source);

    const ids = (
      await query<{ remote_event_id: string }>(`SELECT remote_event_id FROM events WHERE account_id = $1 ORDER BY remote_event_id`, [agent.account.id])
    ).map((r) => r.remote_event_id);
    expect(ids).toEqual(['1900000000000000972', '1900000000000000973']);
    expect((await radarRepo.getSource(agent.source.id))!.idleReason).toMatch(/kept the best 2\. 1 was too old to answer\./);
  });

  it('waits out its quiet hours, and says so', async () => {
    const agent = await growingAgent({ quietHoursEnabled: true, quietHoursStart: 0, quietHoursEnd: 0 });
    // A window of zero hours is none; force one that covers now.
    const hour = new Date().getUTCHours();
    const active = PolicyConfig.parse((await agentsRepo.getActivePolicy(agent.agentId))!.config);
    await agentsRepo.savePolicyVersion(
      agent.agentId,
      PolicyConfig.parse({ ...active, growth: { ...active.growth, quietHoursStart: hour, quietHoursEnd: (hour + 2) % 24 } }),
      'test',
      null,
    );
    const asked = scripted([found('1900000000000000601', 50_000, 90)]);
    await new Radar().poll(agent.source);

    expect(asked).toHaveLength(0);
    const after = (await radarRepo.getSource(agent.source.id))!;
    expect(after.idleReason).toMatch(/Resting until/);
    expect(new Date(after.nextPollAt!).getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);
  });

  it('still runs the search the hour\'s last session asked for', async () => {
    /*
      The session that asks for a search is counted before the search runs.
      Gating the search on "sessions left this hour" refused the fourth
      session's own search on a live agent, every hour.
    */
    const agent = await growingAgent({ maxSessionsPerHour: 2, cooldownMinutes: 0 });
    for (let i = 0; i < 2; i += 1) {
      await query(
        `INSERT INTO agent_growth_sessions (agent_id, started_at, ended_at, ended_reason)
         VALUES ($1, now() - interval '5 minutes', now() - interval '4 minutes', 'test')`,
        [agent.agentId],
      );
    }
    const asked = scripted([found('1900000000000000801', 50_000, 90)]);
    await new Radar().poll(agent.source);
    expect(asked).toHaveLength(1);
  });

  it('remembers whom it approached and whether they answered', async () => {
    const agent = await growingAgent();
    const { actions: actionsRepo } = await import('@xbam/database');
    const approach = async (handle: string, id: string) => {
      const [event] = await query<{ id: string }>(
        `INSERT INTO events (channel, account_id, type, remote_event_id, remote_author_handle, text)
         VALUES ('x', $1, 'KEYWORD_MATCH', $2, $3, 'robinhood chain thoughts') RETURNING id`,
        [agent.account.id, id, handle],
      );
      const [job] = await query<{ id: string }>(
        `INSERT INTO jobs (event_id, agent_id, account_id, channel, action_type, idempotency_key, status)
         VALUES ($1, $2, $3, 'x', 'REPLY', $4, 'EXECUTED') RETURNING id`,
        [event!.id, agent.agentId, agent.account.id, `k-${id}`],
      );
      await query(
        `INSERT INTO actions (job_id, agent_id, account_id, channel, type, status, idempotency_key, executed_at)
         VALUES ($1, $2, $3, 'x', 'REPLY', 'EXECUTED', $4, now() - interval '1 hour')`,
        [job!.id, agent.agentId, agent.account.id, `a-${id}`],
      );
    };
    await approach('silent_one', '1900000000000000901');
    await approach('silent_one', '1900000000000000902');
    await approach('talker', '1900000000000000903');
    await query(
      `INSERT INTO events (channel, account_id, type, remote_event_id, remote_author_handle, text)
       VALUES ('x', $1, 'REPLY', '1900000000000000904', 'talker', '@agent fair point')`,
      [agent.account.id],
    );

    expect(await actionsRepo.approachHistory(agent.agentId, 'silent_one')).toEqual({ approaches: 2, answered: false });
    expect(await actionsRepo.approachHistory(agent.agentId, '@Talker')).toEqual({ approaches: 1, answered: true });
    expect(await actionsRepo.approachHistory(agent.agentId, 'stranger')).toEqual({ approaches: 0, answered: false });

    const memory = await actionsRepo.discoveryMemory(agent.agentId, agent.account.id);
    expect(memory.contactedRecently.sort()).toEqual(['silent_one', 'talker']);
    expect(memory.engagedWithUs).toEqual(['talker']);
  });

  it('does not search for an agent that is paused', async () => {
    const agent = await growingAgent();
    await query(`UPDATE agents SET state = 'PAUSED' WHERE id = $1`, [agent.agentId]);
    const asked = scripted([found('1900000000000000701', 50_000, 90)]);
    await new Radar().poll(agent.source);
    expect(asked).toHaveLength(0);
    expect((await radarRepo.getSource(agent.source.id))!.idleReason).toMatch(/No active agent/);
  });

  it('is asked for by a growth session rather than running on a timer of its own', async () => {
    const agent = await growingAgent();
    await query(`UPDATE radar_sources SET next_poll_at = now() + interval '2 hours' WHERE id = $1`, [agent.source.id]);
    expect(await requestDiscovery(agent.account.id)).toBe(1);
    const after = (await radarRepo.getSource(agent.source.id))!;
    expect(new Date(after.nextPollAt!).getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  });
});
