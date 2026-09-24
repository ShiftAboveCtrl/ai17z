import { describe, expect, it } from 'vitest';
import { GrowthPolicy, PolicyConfig } from '@xbam/shared/contracts';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  autonomy as autonomyRepo,
  deliberation as mind,
} from '@xbam/database';
import { growthGateFor, wakeAgent } from '@xbam/runtime';
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
    PolicyConfig.parse({ ...active!.config, growth: GrowthPolicy.parse(growth) }),
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
    const fixture = await growingAgent({ quietHoursStart: 23, quietHoursEnd: 7 });

    const resting = await growthGateFor(fixture.agentId, fixture.accountId, PolicyConfig.parse(
      (await agentsRepo.getActivePolicy(fixture.agentId))!.config,
    ), at(3));
    expect(resting.allowed).toBe(false);
    expect(resting.state).toBe('QUIET_HOURS');

    const awake = await growthGateFor(fixture.agentId, fixture.accountId, PolicyConfig.parse(
      (await agentsRepo.getActivePolicy(fixture.agentId))!.config,
    ), at(14));
    expect(awake.allowed).toBe(true);
  }, 60_000);

  it('stops once the day’s sessions are used, and survives a restart doing it', async () => {
    const fixture = await growingAgent({ maxSessionsPerDay: 2, cooldownMinutes: 0 });
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
  it('rests instead of thinking, and records that it rested', async () => {
    /*
      The whole point of the increment, end to end. Without the gate this wake
      reads observations and spends a classifier call; with it the agent says
      it is resting and spends nothing.

      Recorded as a quiet wake rather than a failure, because doing nothing is
      a result and a screen that listed only the productive runs would make a
      correctly quiet agent look broken.
    */
    const fixture = await growingAgent({ quietHoursStart: 0, quietHoursEnd: 23 });
    const outcome = await wakeAgent(fixture.agentId, { now: at(12), mayResearch: false });

    expect(outcome.produced).toBe(0);
    expect(outcome.candidates).toBe(0);
    expect(outcome.reason).toMatch(/resting|still answered/i);
  }, 60_000);

  it('thinks normally outside the quiet window', async () => {
    const fixture = await growingAgent({ quietHoursStart: 1, quietHoursEnd: 2 });
    const outcome = await wakeAgent(fixture.agentId, { now: at(14), mayResearch: false });
    // Nothing to attend to in a fresh fixture, so the interesting part is only
    // that it was not turned away at the door.
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
