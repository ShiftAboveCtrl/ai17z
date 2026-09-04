import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, PolicyConfig } from '@xbam/shared/contracts';
import { observability } from '@xbam/database';
import { capResearch, checkBudget, describeSpending } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/** A finished model call, optionally with a price on it. */
async function recordCall(agentId: string, costUsd: number | null): Promise<void> {
  const id = await observability.startModelCall({
    jobId: null,
    agentId,
    providerCredentialId: null,
    purpose: 'test',
    provider: 'mock',
    model: 'mock-echo',
    modelRole: 'primary',
    attempt: 1,
    parameters: {},
    promptLayers: null,
    promptText: null,
  });
  await observability.finishModelCall(id, { status: 'COMPLETED', estimatedCostUsd: costUsd });
}

function policyWith(budget: Partial<PolicyConfig['budget']>): PolicyConfig {
  return PolicyConfig.parse({ ...DEFAULT_POLICY, budget: { ...DEFAULT_POLICY.budget, ...budget } });
}

describe('limits that can actually fire', () => {
  it('counts calls a day and says how close it is before it stops anything', async () => {
    const fixture = await createFixture();
    const policy = policyWith({ maxModelCallsPerDay: 3 });

    await recordCall(fixture.agentId, null);
    await recordCall(fixture.agentId, null);

    expect((await checkBudget(fixture.agentId, policy)).allow).toBe(true);
    const report = await describeSpending(fixture.agentId, policy);
    expect(report.callsPerDay.says).toBe('2 of 3 model calls today.');
  });

  it('refuses at the limit, naming the number reached and when it resets', async () => {
    const fixture = await createFixture();
    const policy = policyWith({ maxModelCallsPerDay: 2 });
    await recordCall(fixture.agentId, null);
    await recordCall(fixture.agentId, null);

    const decision = await checkBudget(fixture.agentId, policy);
    expect(decision.allow).toBe(false);
    if (decision.allow) return;
    expect(decision.reason).toBe('daily_call_limit_reached');
    expect(decision.message).toContain('2 of 2');
    expect(decision.message).toMatch(/Resets/);
    // A limit that has not cleared is not a failure: it waits and is re-checked.
    expect(decision.kind).toBe('RETRYABLE');
    expect(decision.retryAfterMs).toBeGreaterThan(0);
  });

  it('counts a month separately from a day', async () => {
    const fixture = await createFixture();
    await recordCall(fixture.agentId, null);
    const report = await describeSpending(fixture.agentId, policyWith({ maxModelCallsPerMonth: 500 }));
    expect(report.callsPerMonth.says).toBe('1 of 500 model calls this month.');
  });

  it('counts another agent nothing of this one', async () => {
    const mine = await createFixture();
    const theirs = await createFixture();
    await recordCall(theirs.agentId, null);
    const report = await describeSpending(mine.agentId, policyWith({ maxModelCallsPerDay: 10 }));
    expect(report.callsPerDay.used).toBe(0);
  });
});

/**
 * The defect this exists for: a USD limit is offered, set, and can never fire,
 * because a cost is only recorded where somebody told AI17Z what the model
 * charges. It read 0.00 of 5.00 through 137 real calls.
 */
describe('the spending limit that could not enforce itself', () => {
  it('says so, rather than showing nothing spent', async () => {
    const fixture = await createFixture();
    await recordCall(fixture.agentId, null);
    await recordCall(fixture.agentId, null);

    const report = await describeSpending(fixture.agentId, policyWith({ maxCostUsdPerDay: 5 }));
    expect(report.costPerDay.inert).toBe(true);
    expect(report.costPerDay.says).toContain('cannot stop anything yet');
    // And says what to do about it.
    expect(report.costPerDay.says).toContain('price per thousand tokens');
    expect(report.warnings.join(' ')).toContain('cannot stop anything yet');
  });

  it('is not called inert before anything has run', async () => {
    // No calls today says nothing about whether the models are priced, and
    // warning about it on a fresh agent would be noise.
    const fixture = await createFixture();
    const report = await describeSpending(fixture.agentId, policyWith({ maxCostUsdPerDay: 5 }));
    expect(report.costPerDay.inert).toBe(false);
  });

  it('reports real money once the models carry prices', async () => {
    const fixture = await createFixture();
    await recordCall(fixture.agentId, 0.25);
    await recordCall(fixture.agentId, 0.5);

    const report = await describeSpending(fixture.agentId, policyWith({ maxCostUsdPerDay: 5 }));
    expect(report.costPerDay.inert).toBe(false);
    expect(report.costPerDay.says).toBe('0.75 of 5.00 USD today.');
  });

  it('stops the agent once the money is spent', async () => {
    const fixture = await createFixture();
    await recordCall(fixture.agentId, 6);
    const decision = await checkBudget(fixture.agentId, policyWith({ maxCostUsdPerDay: 5 }));
    expect(decision.allow).toBe(false);
    if (decision.allow) return;
    expect(decision.reason).toBe('daily_budget_exhausted');
  });

  it('checks the call count before the cost, because the count always works', async () => {
    // Both are exceeded. The refusal names the one that can be trusted.
    const fixture = await createFixture();
    await recordCall(fixture.agentId, 9);
    const decision = await checkBudget(fixture.agentId, policyWith({ maxModelCallsPerDay: 1, maxCostUsdPerDay: 5 }));
    expect(decision.allow).toBe(false);
    if (decision.allow) return;
    expect(decision.reason).toBe('daily_call_limit_reached');
  });
});

describe('an agent with no ceiling at all', () => {
  it('says that nothing caps it over a day or a month', async () => {
    const fixture = await createFixture();
    const report = await describeSpending(fixture.agentId, policyWith({}));
    expect(report.warnings.join(' ')).toContain('Nothing caps what this agent spends');
  });
});

describe('how many things one message may look up', () => {
  it('keeps the most important and drops the tail', () => {
    // Trimming rather than discarding: the plan is ordered, so two of three
    // answers more of the question than none of it.
    expect(capResearch(['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
  });

  it('leaves a plan within the limit alone', () => {
    expect(capResearch(['a'], 3)).toEqual(['a']);
  });

  it('treats zero as an agent that never looks anything up', () => {
    expect(capResearch(['a', 'b'], 0)).toEqual([]);
  });

  it('says so on the screen rather than only in the policy', async () => {
    const fixture = await createFixture();
    const report = await describeSpending(fixture.agentId, policyWith({ maxResearchCallsPerEvent: 0 }));
    expect(report.researchPerEvent.says).toBe('This agent never looks anything up.');
  });
});
