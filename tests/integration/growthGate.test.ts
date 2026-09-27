import { describe, expect, it } from 'vitest';
import { GrowthPolicy, PolicyConfig } from '@xbam/shared/contracts';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  autonomy as autonomyRepo,
  deliberation as mind,
  query,
} from '@xbam/database';
import { beginGrowthSession, growthGateFor, wakeAgent } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * The growth limits have to stop something real.
 *
 * A setting that nothing reads is a capability the product does not have, and
 * this codebase has already paid for that once with "only verified accounts",
 * which sat in the contract with nothing behind it. These tests exist to make
 * the same mistake impossible here: each one drives the actual entry point
 * rather than the pure function underneath it.
 *
 * Deliberation is the right place to gate. It is the expensive half of
 * optional growth -- it reads observations, calls a classifier and produces
 * the candidates that become proposals -- so checking here means the cost is
 * not paid before the decision is taken. Nothing about answering somebody
 * comes through this path.
 */

async function growingAgent(growth: Partial<GrowthPolicy> = {}) {
  const fixture = await createFixture();
  const active = await agentsRepo.getActivePolicy(fixture.agentId);
  await agentsRepo.savePolicyVersion(
    fixture.agentId,
    // Quiet hours off unless a test asks for them. Several tests here use the
    // real clock, and a default window would make them fail only at night.
    PolicyConfig.parse({ ...active!.config, growth: GrowthPolicy.parse({ quietHoursEnabled: false, ...growth }) }),
    'test',
    null,
  );
  const account = await accountsRepo.createAccount({
    ownerId: fixture.ownerId,
    channel: 'mock',
    handle: `growth_${uniqueSuffix()}`,
  });
  await accountsRepo.updateAccount(account.id, { status: 'CONNECTED', enabled: true });
  await accountsRepo.linkAgentAccount({
    agentId: fixture.agentId,
    accountId: account.id,
    triggerEventTypes: ['MENTION'],
    actionType: 'REPLY',
  });
  // An agent that is not active and not thinking never reaches the gate, and
  // a test that stops short of it proves nothing about the gate.
  await agentsRepo.updateAgent(fixture.agentId, { state: 'ACTIVE' });
  await mind.setWake(fixture.agentId, { enabled: true, autonomy: 'THINK' });
  return { ...fixture, accountId: account.id };
}

const at = (hour: number) => new Date(Date.UTC(2026, 8, 24, hour, 0, 0));

describe('the gate reads what the policy says', () => {
  it('stops optional growth inside the quiet window', async () => {
    const fixture = await growingAgent({ quietHoursEnabled: true, quietHoursStart: 23, quietHoursEnd: 7 });
    const policy = PolicyConfig.parse((await agentsRepo.getActivePolicy(fixture.agentId))!.config);

    const resting = await growthGateFor(fixture.agentId, fixture.accountId, policy, at(3));
    expect(resting.allowed).toBe(false);
    expect(resting.state).toBe('QUIET_HOURS');
    expect((await growthGateFor(fixture.agentId, fixture.accountId, policy, at(14))).allowed).toBe(true);
  }, 60_000);

  it('imposes no time-of-day blackout on an agent whose owner switched quiet hours off', async () => {
    const fixture = await growingAgent({ quietHoursEnabled: false, quietHoursStart: 23, quietHoursEnd: 7 });
    const policy = PolicyConfig.parse((await agentsRepo.getActivePolicy(fixture.agentId))!.config);
    expect((await growthGateFor(fixture.agentId, fixture.accountId, policy, at(3))).allowed).toBe(true);
    expect((await growthGateFor(fixture.agentId, fixture.accountId, policy, at(14))).allowed).toBe(true);
  }, 60_000);

  it('stops once the day’s sessions are used, and survives a restart doing it', async () => {
    const fixture = await growingAgent({ maxSessionsPerHour: 12, maxSessionsPerDay: 2, cooldownMinutes: 0 });
    for (let i = 0; i < 2; i += 1) {
      await autonomyRepo.startSession(fixture.agentId);
      await autonomyRepo.endSession(fixture.agentId, 'test');
    }

    // Nothing in a process holds this: the rows are the budget, so a worker
    // that is replaced comes back to exactly the same answer.
    const policy = PolicyConfig.parse((await agentsRepo.getActivePolicy(fixture.agentId))!.config);
    const verdict = await growthGateFor(fixture.agentId, fixture.accountId, policy, at(14));
    expect(verdict.allowed).toBe(false);
    expect(verdict.state).toBe('SPENT');
    expect(verdict.message).toMatch(/all 2 of today/);
  }, 60_000);

  it('paces repeated growth by rolling hour without requiring a daily stop', async () => {
    const fixture = await growingAgent({ maxSessionsPerHour: 2, maxSessionsPerDay: 0, cooldownMinutes: 0 });
    for (let i = 0; i < 2; i += 1) {
      await autonomyRepo.startSession(fixture.agentId);
      await autonomyRepo.endSession(fixture.agentId, 'test');
    }

    const policy = PolicyConfig.parse((await agentsRepo.getActivePolicy(fixture.agentId))!.config);
    const verdict = await growthGateFor(fixture.agentId, fixture.accountId, policy, at(14));
    expect(verdict.allowed).toBe(false);
    expect(verdict.state).toBe('SPENT');
    expect(verdict.message).toMatch(/rolling hour clears/i);
  }, 60_000);

  it('yields to an account that needs a person', async () => {
    const fixture = await growingAgent();
    await autonomyRepo.setAccountHealth({
      accountId: fixture.accountId,
      health: 'HUMAN_ACTION_REQUIRED',
      reason: 'X is asking for a code.',
    });

    const policy = PolicyConfig.parse((await agentsRepo.getActivePolicy(fixture.agentId))!.config);
    const verdict = await growthGateFor(fixture.agentId, fixture.accountId, policy, at(14));
    expect(verdict.allowed).toBe(false);
    expect(verdict.state).toBe('HELD');
    expect(verdict.message).toMatch(/asking for a code/);
  }, 60_000);
});

describe('deliberation obeys it', () => {
  it('rests instead of thinking inside the quiet window, and records that it rested', async () => {
    /*
      Recorded as a quiet wake rather than a failure, because doing nothing is
      a result and a screen that listed only the productive runs would make a
      correctly quiet agent look broken.
    */
    const fixture = await growingAgent({ quietHoursEnabled: true, quietHoursStart: 0, quietHoursEnd: 23 });
    const outcome = await wakeAgent(fixture.agentId, { now: at(12), mayResearch: false });
    expect(outcome.produced).toBe(0);
    expect(outcome.candidates).toBe(0);
    expect(outcome.reason).toMatch(/resting|still answered/i);
  }, 60_000);

  it('thinks at any hour when its owner switched quiet hours off', async () => {
    const fixture = await growingAgent({ quietHoursEnabled: false });
    const outcome = await wakeAgent(fixture.agentId, { now: at(3), mayResearch: false });
    expect(outcome.reason).not.toMatch(/resting/i);
  }, 60_000);

  it('never stops an agent thinking because growth state could not be read', async () => {
    // Growth being unavailable is not a reason to switch an agent's autonomy
    // off. A transient database blip must not do silently what an owner never
    // asked for.
    const fixture = await growingAgent();
    const outcome = await wakeAgent(fixture.agentId, { now: at(14), mayResearch: false });
    expect(outcome).toBeTruthy();
  }, 60_000);
});

describe('the real scheduler owns the durable session lifecycle', () => {
  it('opens, records, closes and enters cooldown even when a wake finds nothing', async () => {
    const fixture = await growingAgent({ cooldownMinutes: 45 });
    const now = new Date();
    await wakeAgent(fixture.agentId, { now, mayResearch: false });

    const rows = await query<{ ended_at: string | null; ended_reason: string | null }>(
      `SELECT ended_at, ended_reason FROM agent_growth_sessions WHERE agent_id=$1 ORDER BY started_at DESC`,
      [fixture.agentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ended_at).not.toBeNull();
    expect(rows[0]!.ended_reason).toMatch(/found nothing|looked at/i);

    const policy = PolicyConfig.parse((await agentsRepo.getActivePolicy(fixture.agentId))!.config);
    const verdict = await growthGateFor(fixture.agentId, fixture.accountId, policy, new Date());
    expect(verdict.state).toBe('RESTING');
    expect(verdict.retryAfterMs).toBeGreaterThan(0);
  }, 60_000);

  it('automatically opens a later session after cooldown and keeps agents isolated', async () => {
    const one = await growingAgent({ cooldownMinutes: 0 });
    const two = await growingAgent({ cooldownMinutes: 0 });

    await wakeAgent(one.agentId, { mayResearch: false });
    await wakeAgent(one.agentId, { mayResearch: false });
    await wakeAgent(two.agentId, { mayResearch: false });

    expect(await autonomyRepo.sessionsToday(one.agentId)).toBe(2);
    expect(await autonomyRepo.sessionsToday(two.agentId)).toBe(1);
    expect(await autonomyRepo.openSession(one.agentId)).toBeNull();
    expect(await autonomyRepo.openSession(two.agentId)).toBeNull();
  }, 120_000);

  it('recovers a session left open by a restart instead of wedging forever', async () => {
    const fixture = await growingAgent({
      sessionMinutes: 1,
      cooldownMinutes: 0,
    });
    await autonomyRepo.startSession(fixture.agentId);
    await query(
      `UPDATE agent_growth_sessions SET started_at=now() - interval '2 minutes'
        WHERE agent_id=$1 AND ended_at IS NULL`,
      [fixture.agentId],
    );

    const policy = PolicyConfig.parse((await agentsRepo.getActivePolicy(fixture.agentId))!.config);
    const verdict = await beginGrowthSession(fixture.agentId, fixture.accountId, policy, new Date());
    expect(verdict.allowed).toBe(true);
    expect(verdict.state).toBe('OPEN');

    const rows = await query<{ ended_at: string | null }>(
      `SELECT ended_at FROM agent_growth_sessions WHERE agent_id=$1 ORDER BY started_at`,
      [fixture.agentId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.ended_at).not.toBeNull();
    expect(rows[1]!.ended_at).toBeNull();
  }, 60_000);
});
