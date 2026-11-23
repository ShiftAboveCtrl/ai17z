import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  agents, capabilityInvocations, capabilityPermissions, deliberation as mind,
  observability, providers, query,
} from '@xbam/database';
import { DEFAULT_POLICY } from '@xbam/shared/contracts';
import { getAdapter } from '@xbam/models';
import { defineCapability, registerCapability, resetCapabilitiesForTest } from '@xbam/tools';
import { setPauseAll, wakeAgent } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { pursueGoal } from '../../packages/runtime/src/goalPlans';

installHarness();
let runs = 0;
let afterRun: (() => Promise<void>) | undefined;

beforeEach(async () => {
  runs = 0;
  afterRun = undefined;
  resetCapabilitiesForTest();
  registerCapability(defineCapability({
    id: 'test.clock', name: 'Clock', description: 'Read the current time.',
    category: 'READ', effect: 'READ', risk: 'LOW', modelCallable: true,
    input: z.object({}), output: z.object({ now: z.string() }), timeoutMs: 1000,
    async run() {
      runs += 1;
      await afterRun?.();
      return { now: 'noon' };
    },
  }));
  await setPauseAll({ paused: false, by: null });
});
afterEach(() => { resetCapabilitiesForTest(); vi.restoreAllMocks(); });

async function planningAgent(autonomy: 'ACT' | 'SUGGEST' | 'THINK' = 'ACT', repeat = false) {
  const f = await createFixture({ policy: { tools: { ...DEFAULT_POLICY.tools, capabilityLoop: true } } });
  await agents.updateAgent(f.agentId, { state: 'ACTIVE' });
  await mind.setWake(f.agentId, { enabled: true, autonomy });
  await providers.setModelConfig({
    agentId: f.agentId, role: 'classifier', providerCredentialId: f.providerId,
    model: repeat ? 'mock-fixed:<use-capability>{"id":"test.clock","input":{}}</use-capability>' : 'mock-uses:test.clock',
    parameters: {},
  });
  const goal = await mind.addGoal({ agentId: f.agentId, summary: 'Read the current time.', origin: 'OWNER' });
  return { ...f, goalId: goal.id };
}

async function planFor(agentId: string) {
  const [row] = await query<{ plan: { state: string; summary: string; steps: { outcome: string }[] } }>(
    'SELECT plan FROM agent_goals WHERE agent_id=$1', [agentId],
  );
  return row!.plan;
}

describe('a goal becomes a bounded plan on a worker wake', () => {
  it('uses the first step result to choose and supply a second step', async () => {
    const f = await planningAgent();
    registerCapability(defineCapability({
      id: 'test.followup', name: 'Follow up', description: 'Check the time read by the clock.',
      category: 'READ', effect: 'READ', risk: 'LOW', modelCallable: true,
      input: z.object({ seen: z.literal('noon') }), output: z.object({ checked: z.boolean() }), timeoutMs: 1000,
      async run() { return { checked: true }; },
    }));
    vi.spyOn(getAdapter('mock'), 'generate').mockImplementation(async request => {
      const returned = request.messages.filter(m => m.role === 'system').map(m => m.content);
      const text = returned.some(m => m.startsWith('test.followup returned:')) ? 'The checks concluded.'
        : returned.some(m => m.startsWith('test.clock returned:') && m.includes('noon'))
          ? '<use-capability>{"id":"test.followup","input":{"seen":"noon"}}</use-capability>'
          : '<use-capability>{"id":"test.clock","input":{}}</use-capability>';
      // The caller limits the provider's existing timeout to the plan budget.
      expect(request.timeoutMs).toBeGreaterThan(0);
      expect(request.timeoutMs).toBeLessThanOrEqual(60_000);
      return { text, requestId: null, promptTokens: null, completionTokens: null, raw: null };
    });
    await wakeAgent(f.agentId, { mayResearch: true });
    expect(await planFor(f.agentId)).toMatchObject({ state: 'COMPLETED', steps: [
      { capabilityId: 'test.clock', outcome: 'SUCCEEDED' },
      { capabilityId: 'test.followup', outcome: 'SUCCEEDED', input: { seen: 'noon' } },
    ] });
    const traces = (await observability.listAgentTrace(f.agentId)).filter(t => t.data.goalId === f.goalId);
    expect(traces).toHaveLength(2);
    expect(traces.map(t => t.data.step).sort()).toEqual([1, 2]);
  });

  it('runs a goal through capabilities and records one trace per step', async () => {
    const f = await planningAgent();
    await wakeAgent(f.agentId, { mayResearch: true });
    expect(runs).toBe(1);
    expect((await planFor(f.agentId)).state).toBe('COMPLETED');
    expect(await capabilityInvocations.listForAgent(f.agentId)).toHaveLength(1);
    const traces = (await observability.listAgentTrace(f.agentId)).filter(t => t.data.goalId === f.goalId);
    expect(traces).toHaveLength(1);
    expect(traces[0]!.data).toMatchObject({ step: 1, outcome: 'SUCCEEDED' });
    // An ended plan never repeats on the next wake, and owner progress stays theirs.
    await wakeAgent(f.agentId, { mayResearch: true });
    expect(runs).toBe(1);
    expect((await mind.listGoals(f.agentId))[0]!.progress).toBe(0);
  });

  it('PAUSE ALL prevents even creating a plan', async () => {
    const f = await planningAgent();
    await setPauseAll({ paused: true, by: null });
    await wakeAgent(f.agentId, { mayResearch: true });
    expect(await planFor(f.agentId)).toBeNull();
    expect(runs).toBe(0);
  });

  it.each(['THINK', 'SUGGEST'] as const)('at %s proposes one step and stops without failing', async autonomy => {
    const f = await planningAgent(autonomy, true);
    await wakeAgent(f.agentId, { mayResearch: true });
    expect(runs).toBe(0);
    expect(await planFor(f.agentId)).toMatchObject({ state: 'PROPOSED', steps: [{ outcome: 'PROPOSED' }] });
    expect(await capabilityInvocations.listForAgent(f.agentId)).toHaveLength(0);
  });

  it('ends an unbounded request at the step budget with a recorded sentence', async () => {
    const f = await planningAgent('ACT', true);
    await wakeAgent(f.agentId, { mayResearch: true });
    expect(runs).toBe(3);
    expect(await planFor(f.agentId)).toMatchObject({ state: 'EXHAUSTED', summary: expect.stringMatching(/step budget.*\.$/) });
    expect((await observability.listAgentTrace(f.agentId)).filter(t => t.data.goalId === f.goalId)).toHaveLength(3);
  });

  it('a revoked grant stops the next step permanently, even after it is allowed again', async () => {
    const f = await planningAgent('ACT', true);
    await capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'test.clock', permission: 'ALLOWED' });
    afterRun = async () => {
      await capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'test.clock', permission: 'DISABLED' });
    };
    await wakeAgent(f.agentId, { mayResearch: true });
    expect(runs).toBe(1);
    expect(await planFor(f.agentId)).toMatchObject({ state: 'STOPPED', steps: [{ outcome: 'SUCCEEDED' }, { outcome: 'REFUSED' }] });
    await capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'test.clock', permission: 'ALLOWED' });
    await wakeAgent(f.agentId, { mayResearch: true });
    expect(runs).toBe(1);
  });

  it('PAUSE ALL during a plan prevents another step', async () => {
    const f = await planningAgent('ACT', true);
    afterRun = async () => { await setPauseAll({ paused: true, by: null }); };
    await wakeAgent(f.agentId, { mayResearch: true });
    expect(runs).toBe(1);
    expect(await planFor(f.agentId)).toMatchObject({ state: 'STOPPED', summary: 'Everything is paused.' });
  });

  it('an autonomy downgrade during a plan proposes the next step and stops', async () => {
    const f = await planningAgent('ACT', true);
    afterRun = async () => { await mind.setWake(f.agentId, { autonomy: 'SUGGEST' }); };
    await wakeAgent(f.agentId, { mayResearch: true });
    expect(runs).toBe(1);
    expect(await planFor(f.agentId)).toMatchObject({ state: 'PROPOSED', steps: [
      { outcome: 'SUCCEEDED' }, { outcome: 'PROPOSED' },
    ] });
  });

  it('ends at the time budget and records a sentence without retrying', async () => {
    const f = await planningAgent('ACT', true);
    const realNow = Date.now.bind(Date);
    afterRun = async () => { vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 61_000); };
    await wakeAgent(f.agentId, { mayResearch: true });
    vi.restoreAllMocks();
    expect(runs).toBe(1);
    expect(await planFor(f.agentId)).toMatchObject({ state: 'EXHAUSTED', summary: expect.stringMatching(/time budget.*\.$/) });
    await wakeAgent(f.agentId, { mayResearch: true });
    expect(runs).toBe(1);
  });

  it('write capabilities stay disabled by default', async () => {
    const f = await planningAgent();
    resetCapabilitiesForTest();
    registerCapability(defineCapability({
      id: 'test.clock', name: 'Publish time', description: 'Publish the current time.',
      category: 'CREATE', effect: 'WRITE', risk: 'HIGH', modelCallable: true,
      input: z.object({}), output: z.object({}), timeoutMs: 1000,
      async run() { runs += 1; return {}; },
    }));
    await wakeAgent(f.agentId, { mayResearch: true });
    expect(runs).toBe(0);
    expect(await planFor(f.agentId)).toMatchObject({ state: 'STOPPED',
      summary: expect.stringContaining('not offered'), steps: [{ outcome: 'REFUSED' }] });
    const recorded = await capabilityInvocations.listForAgent(f.agentId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ outcome: 'REFUSED', detail: expect.stringContaining('not offered') });
  });

  it('an approval requirement stops the plan for the owner', async () => {
    const f = await planningAgent();
    await capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'test.clock', permission: 'OWNER_APPROVAL' });
    await wakeAgent(f.agentId, { mayResearch: true });
    expect(runs).toBe(0);
    expect((await planFor(f.agentId)).summary).toMatch(/approval/);
    expect((await planFor(f.agentId)).state).toBe('STOPPED');
  });

  it('does not retain model deliberation in goals, traces or model-call output', async () => {
    const f = await planningAgent();
    vi.spyOn(getAdapter('mock'), 'generate').mockResolvedValue({ text: 'PRIVATE_REASONING_SENTINEL',
      requestId: null, promptTokens: null, completionTokens: null, raw: null });
    await wakeAgent(f.agentId, { mayResearch: true });
    expect((await planFor(f.agentId)).state).toBe('COMPLETED');
    const calls = await query('SELECT raw_output FROM model_calls WHERE agent_id=$1', [f.agentId]);
    expect(calls.length).toBeGreaterThan(0);
    expect(JSON.stringify([await planFor(f.agentId), await observability.listAgentTrace(f.agentId), calls]))
      .not.toContain('PRIVATE_REASONING_SENTINEL');
  });

  it('leaves planning to worker wakes', async () => {
    const f = await planningAgent();
    await wakeAgent(f.agentId);
    expect(await planFor(f.agentId)).toBeNull();
    expect(runs).toBe(0);
  });

  it('honors the capability-loop opt-in', async () => {
    const f = await planningAgent();
    const current = await agents.getActivePolicy(f.agentId);
    await agents.savePolicyVersion(f.agentId,
      { ...current!.config, tools: { ...DEFAULT_POLICY.tools, capabilityLoop: false } }, 'Disable capability planning.', f.ownerId);
    await wakeAgent(f.agentId, { mayResearch: true });
    expect(await planFor(f.agentId)).toBeNull();
    expect(runs).toBe(0);
  });

  it('an interrupted plan is recorded and never replayed', async () => {
    const f = await planningAgent();
    await query(`UPDATE agent_goals SET plan=$2::jsonb WHERE id=$1`, [f.goalId, JSON.stringify({
      state: 'RUNNING', startedAt: new Date(Date.now() - 61_000).toISOString(), maxSteps: 3,
      budgetMs: 60_000, steps: [], summary: 'A bounded plan is running.',
    })]);
    await wakeAgent(f.agentId, { mayResearch: true });
    expect(await planFor(f.agentId)).toMatchObject({ state: 'STOPPED', summary: expect.stringMatching(/interrupted/) });
    await wakeAgent(f.agentId, { mayResearch: true });
    expect(runs).toBe(0);
  });

  it('leaves a goal unclaimed when a pre-claim wake read fails', async () => {
    const f = await planningAgent();
    vi.spyOn(mind, 'getWake').mockRejectedValueOnce(new Error('read unavailable'));
    expect(await pursueGoal(f.agentId, null)).toBeNull();
    expect(await planFor(f.agentId)).toBeNull();
    expect(runs).toBe(0);
  });

  it('leaves a goal unclaimed when the pre-claim goal read fails', async () => {
    const f = await planningAgent();
    vi.spyOn(mind, 'listGoals').mockRejectedValueOnce(new Error('read unavailable'));
    expect(await pursueGoal(f.agentId, null)).toBeNull();
    expect(await planFor(f.agentId)).toBeNull();
  });
});
