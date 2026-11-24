import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  agents, capabilityInvocations, capabilityPermissions, deliberation as mind, query,
} from '@xbam/database';
import { DEFAULT_POLICY, type GoalPlan } from '@xbam/shared/contracts';
import { getAdapter } from '@xbam/models';
import { defineCapability, registerCapability, resetCapabilitiesForTest } from '@xbam/tools';
import { setPauseAll, wakeAgent } from '@xbam/runtime';
import { providers } from '@xbam/database';
import { buildServer } from '../../apps/api/src/server';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { pursueGoal } from '../../packages/runtime/src/goalPlans';

installHarness();
let app: FastifyInstance;
let runs = 0;
let afterRun: (() => Promise<void>) | undefined;
let slowWrite = false;

beforeAll(async () => { app = await buildServer(); await app.ready(); });
afterAll(async () => { await app?.close(); resetCapabilitiesForTest(); });
beforeEach(async () => {
  runs = 0;
  afterRun = undefined;
  slowWrite = false;
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
afterEach(() => { vi.restoreAllMocks(); });

async function planningAgent(autonomy: 'ACT' | 'SUGGEST' | 'THINK' = 'ACT', model = 'mock-uses:test.clock') {
  const f = await createFixture({ policy: {
    tools: { ...DEFAULT_POLICY.tools, capabilityLoop: true },
    // The existing growth gate caps model calls per session; these tests span several wakes.
    growth: { ...DEFAULT_POLICY.growth, cooldownMinutes: 0, quietHoursEnabled: false,
      maxModelCallsPerSession: 60, maxModelCallsPerDay: 300, maxSessionsPerHour: 12, maxSessionsPerDay: 48 },
  } });
  await agents.updateAgent(f.agentId, { state: 'ACTIVE' });
  await mind.setWake(f.agentId, { enabled: true, autonomy });
  await providers.setModelConfig({ agentId: f.agentId, role: 'classifier', providerCredentialId: f.providerId,
    model, parameters: {} });
  const goal = await mind.addGoal({ agentId: f.agentId, summary: 'Read the current time.', origin: 'OWNER', pinned: true });
  return { ...f, goalId: goal.id };
}

const REPEAT = 'mock-fixed:<use-capability>{"id":"test.clock","input":{}}</use-capability>';
const wake = (agentId: string) => wakeAgent(agentId, { mayResearch: true });
const makeDue = (goalId: string) =>
  query("UPDATE agent_goals SET next_attempt_at = now() - interval '1 minute' WHERE id = $1", [goalId]);
const attemptsOf = (goalId: string) => query<{
  attempt_no: number; state: string; steps: { outcome: string }[]; summary: string; finished_at: string | null; new_facts: number;
}>('SELECT * FROM agent_goal_attempts WHERE goal_id=$1 ORDER BY attempt_no', [goalId]);
async function goalRow(goalId: string) {
  const [row] = await query<Record<string, unknown>>('SELECT * FROM agent_goals WHERE id=$1', [goalId]);
  return row!;
}

describe('a goal gets another attempt on a later wake', () => {
  it('runs a second attempt after next_attempt_at, carrying the first attempt facts inside the evidence fence', async () => {
    const f = await planningAgent('ACT', REPEAT);
    await wake(f.agentId);
    expect(runs).toBe(3);
    expect((await attemptsOf(f.goalId)).map(a => a.state)).toEqual(['EXHAUSTED']);
    const first = await goalRow(f.goalId);
    expect(Date.parse(first.next_attempt_at as string) - Date.now()).toBeGreaterThan(110 * 60_000);

    await wake(f.agentId);
    expect(runs).toBe(3);
    expect(await attemptsOf(f.goalId)).toHaveLength(1);

    const adapter = getAdapter('mock');
    const original = adapter.generate.bind(adapter);
    const prompts: string[][] = [];
    vi.spyOn(adapter, 'generate').mockImplementation(async request => {
      prompts.push(request.messages.map(m => `${m.role}: ${m.content}`));
      return original(request);
    });
    await makeDue(f.goalId);
    await wake(f.agentId);
    expect(runs).toBe(6);
    expect((await attemptsOf(f.goalId)).map(a => a.attempt_no)).toEqual([1, 2]);
    const text = prompts[0]!.join('\n');
    expect(text).toContain('<<<QUOTED');
    expect(text).toMatch(/<<<QUOTED[^\n]*may be stale[^\n]*\n[\s\S]*now: noon[\s\S]*<<<END QUOTED/);
    expect(prompts[0]!.find(line => line.includes('now: noon'))).toMatch(/^system:/);
  });

  it('doubles the wait after an attempt that found nothing new and resets it on a new fact', async () => {
    const f = await planningAgent('ACT', REPEAT);
    await wake(f.agentId);
    expect((await goalRow(f.goalId)).quiet_attempts).toBe(0);
    await makeDue(f.goalId);
    await wake(f.agentId);
    const second = await goalRow(f.goalId);
    expect(second.quiet_attempts).toBe(1);
    expect(Date.parse(second.next_attempt_at as string) - Date.now()).toBeGreaterThan(230 * 60_000);
    expect((await attemptsOf(f.goalId)).map(a => a.new_facts)).toEqual([1, 0]);
  });

  it('proposes abandoning after five attempts in a row add nothing, and does not touch status', async () => {
    const f = await planningAgent('ACT', REPEAT);
    await wake(f.agentId);
    await query('UPDATE agent_goals SET quiet_attempts=4, daily_step_budget=30 WHERE id=$1', [f.goalId]);
    await makeDue(f.goalId);
    await wake(f.agentId);
    const row = await goalRow(f.goalId);
    expect(row).toMatchObject({ proposed_end: 'ABANDON', status: 'ACTIVE', progress: 0, resolved_at: null });
    expect(row.proposed_end_reason).toMatch(/Five attempts/);
    await makeDue(f.goalId);
    const before = runs;
    await wake(f.agentId);
    expect(runs).toBe(before);
  });

  it('records an interrupted attempt once and never replays it', async () => {
    const f = await planningAgent();
    const plan: GoalPlan = { state: 'RUNNING', startedAt: new Date(Date.now() - 61_000).toISOString(), maxSteps: 3,
      budgetMs: 60_000, steps: [], summary: 'A bounded plan is running.' };
    await query('UPDATE agent_goals SET plan=$2::jsonb WHERE id=$1', [f.goalId, JSON.stringify(plan)]);
    await query("INSERT INTO agent_goal_attempts(goal_id, agent_id, attempt_no, state, started_at) VALUES($1,$2,1,'RUNNING',$3)",
      [f.goalId, f.agentId, plan.startedAt]);
    await wake(f.agentId);
    const [attempt] = await attemptsOf(f.goalId);
    expect(attempt).toMatchObject({ state: 'INTERRUPTED' });
    expect(attempt!.finished_at).not.toBeNull();
    expect((await goalRow(f.goalId)).next_attempt_at).not.toBeNull();
    await makeDue(f.goalId);
    await wake(f.agentId);
    expect(runs).toBe(1);
    expect((await attemptsOf(f.goalId)).map(a => a.state)).toEqual(['INTERRUPTED', 'COMPLETED']);
  });
});

describe('a daily budget over a rolling 24 hours', () => {
  it('runs 3 then 1 steps at a budget of 4, then reports the budget used, then runs again after aging out', async () => {
    const f = await planningAgent('ACT', REPEAT);
    await query('UPDATE agent_goals SET daily_step_budget=4 WHERE id=$1', [f.goalId]);
    await wake(f.agentId);
    await makeDue(f.goalId);
    await wake(f.agentId);
    expect(runs).toBe(4);
    expect((await attemptsOf(f.goalId)).map(a => a.steps.length)).toEqual([3, 1]);

    await makeDue(f.goalId);
    const result = await pursueGoal(f.agentId, null);
    expect(result).toMatch(/budget/i);
    expect(runs).toBe(4);
    expect(await attemptsOf(f.goalId)).toHaveLength(2);
    // The next try waits for the earliest attempt to leave the window.
    expect(Date.parse((await goalRow(f.goalId)).next_attempt_at as string) - Date.now()).toBeGreaterThan(20 * 3_600_000);

    await query("UPDATE agent_goal_attempts SET started_at = started_at - interval '25 hours', finished_at = finished_at - interval '25 hours' WHERE goal_id=$1", [f.goalId]);
    await makeDue(f.goalId);
    await wake(f.agentId);
    expect(runs).toBe(7);
    expect(await attemptsOf(f.goalId)).toHaveLength(3);
  });

  it('stops spending once the daily time budget is used', async () => {
    const f = await planningAgent('ACT', REPEAT);
    await wake(f.agentId);
    await query('UPDATE agent_goals SET daily_time_budget_ms=10000 WHERE id=$1', [f.goalId]);
    await query("UPDATE agent_goal_attempts SET started_at = now() - interval '1 hour', finished_at = now() - interval '1 hour' + interval '12 seconds' WHERE goal_id=$1", [f.goalId]);
    await makeDue(f.goalId);
    expect(await pursueGoal(f.agentId, null)).toMatch(/budget/i);
    expect(runs).toBe(3);
  });

  it('refuses budgets outside the allowed ranges', async () => {
    const f = await planningAgent();
    for (const [column, value] of [['daily_step_budget', 0], ['daily_step_budget', 31],
      ['daily_time_budget_ms', 9_999], ['daily_time_budget_ms', 900_001]] as const) {
      await expect(query(`UPDATE agent_goals SET ${column}=$2 WHERE id=$1`, [f.goalId, value])).rejects.toThrow(/check constraint/);
    }
  });
});

describe('pause, permissions and concurrency', () => {
  it('PAUSE ALL set between wakes prevents any claim', async () => {
    const f = await planningAgent();
    await wake(f.agentId);
    await makeDue(f.goalId);
    await setPauseAll({ paused: true, by: null });
    await wake(f.agentId);
    expect(await attemptsOf(f.goalId)).toHaveLength(1);
    expect(runs).toBe(1);
  });

  it('claims once when two wakes race: one attempt row, the other returns null', async () => {
    const f = await planningAgent();
    const plan = (): GoalPlan => ({ state: 'RUNNING', startedAt: new Date().toISOString(), maxSteps: 3, budgetMs: 60_000,
      steps: [], summary: 'A bounded plan is running.' });
    const claims = await Promise.all([mind.claimGoalAttempt(f.goalId, plan()), mind.claimGoalAttempt(f.goalId, plan())]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await attemptsOf(f.goalId)).map(a => a.state)).toEqual(['RUNNING']);
    await expect(query(`INSERT INTO agent_goal_attempts(goal_id, agent_id, attempt_no, state) VALUES($1,$2,9,'RUNNING')`,
      [f.goalId, f.agentId])).rejects.toThrow(/duplicate key/);
  });

  it('two concurrent wakes run the goal once', async () => {
    const f = await planningAgent();
    const results = await Promise.all([pursueGoal(f.agentId, null), pursueGoal(f.agentId, null)]);
    expect(results.filter(r => r !== null)).toHaveLength(1);
    expect(runs).toBe(1);
    expect(await attemptsOf(f.goalId)).toHaveLength(1);
  });

  it('a revoked grant stays revoked across attempts, and the next attempt obeys current permissions', async () => {
    const f = await planningAgent('ACT', REPEAT);
    await capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'test.clock', permission: 'ALLOWED' });
    afterRun = async () => {
      await capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'test.clock', permission: 'DISABLED' });
    };
    await wake(f.agentId);
    expect(runs).toBe(1);
    const [first] = await attemptsOf(f.goalId);
    expect(first!.state).toBe('STOPPED');
    expect(first!.steps.map(s => s.outcome)).toEqual(['SUCCEEDED', 'REFUSED']);

    afterRun = undefined;
    await capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'test.clock', permission: 'ALLOWED' });
    await makeDue(f.goalId);
    await wake(f.agentId);
    const attempts = await attemptsOf(f.goalId);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.steps.map(s => s.outcome)).toEqual(['SUCCEEDED', 'REFUSED']);
    expect(attempts[1]!.steps[0]!.outcome).toBe('SUCCEEDED');
    expect(runs).toBeGreaterThan(1);
  });
});

describe('an attempt ends a goal only by proposing', () => {
  it('a DONE marker sets proposed_end and leaves status, progress and resolved_at alone', async () => {
    const f = await planningAgent('ACT', 'mock-fixed:I checked.\nDONE: shipped the report');
    await wake(f.agentId);
    expect(await goalRow(f.goalId)).toMatchObject({ proposed_end: 'DONE', proposed_end_reason: 'shipped the report',
      status: 'ACTIVE', progress: 0, resolved_at: null, resolution: '' });
    expect((await attemptsOf(f.goalId))[0]).toMatchObject({ state: 'COMPLETED' });
    await makeDue(f.goalId);
    await wake(f.agentId);
    expect(await attemptsOf(f.goalId)).toHaveLength(1);
  });

  it('ignores prose that merely talks about being done', async () => {
    const f = await planningAgent('ACT', 'mock-fixed:The goal is done, I think. DONE is a good word.');
    await wake(f.agentId);
    expect(await goalRow(f.goalId)).toMatchObject({ proposed_end: null, status: 'ACTIVE' });
  });

  it('deliberation code has no way to write a goal status', () => {
    const source = readFileSync(new URL('../../packages/runtime/src/goalPlans.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/updateGoal\(/);
    expect(source).not.toMatch(/status\s*:\s*['"](COMPLETED|ABANDONED|PAUSED)/);
    const repo = readFileSync(new URL('../../packages/database/src/repositories/deliberation.ts', import.meta.url), 'utf8');
    const finish = repo.slice(repo.indexOf('export async function finishGoalAttempt'));
    const body = finish.slice(0, finish.indexOf('\nexport ', 10));
    expect(body).not.toMatch(/\bstatus\s*=|\bprogress\s*=|\bresolution\s*=|resolved_at\s*=/);
  });
});

describe('a write that may have happened blocks the goal until the owner looks', () => {
  async function writingAgent() {
    const f = await planningAgent('ACT', REPEAT);
    resetCapabilitiesForTest();
    registerCapability(defineCapability({
      id: 'test.clock', name: 'Publish time', description: 'Publish the current time.',
      category: 'CREATE', effect: 'WRITE', risk: 'HIGH', modelCallable: true,
      input: z.object({}), output: z.object({}), timeoutMs: 50,
      async run() {
        runs += 1;
        if (slowWrite) await new Promise(resolve => setTimeout(resolve, 400));
        return {};
      },
    }));
    await capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'test.clock', permission: 'ALLOWED' });
    return f;
  }

  it('sets blocked_reason after a TIMED_OUT write and invokes nothing on the next wake', async () => {
    const f = await writingAgent();
    slowWrite = true;
    await wake(f.agentId);
    expect(runs).toBe(1);
    expect((await attemptsOf(f.goalId))[0]!.steps.map(s => s.outcome)).toEqual(['TIMED_OUT']);
    expect((await goalRow(f.goalId)).blocked_reason).toBe('A write may or may not have happened; the owner must check.');
    const recorded = (await capabilityInvocations.listForAgent(f.agentId)).length;

    await makeDue(f.goalId);
    slowWrite = false;
    await wake(f.agentId);
    expect(runs).toBe(1);
    expect(await attemptsOf(f.goalId)).toHaveLength(1);
    expect(await capabilityInvocations.listForAgent(f.agentId)).toHaveLength(recorded);
  });

  it('a refused write does not block the goal', async () => {
    const f = await writingAgent();
    await capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'test.clock', permission: 'DISABLED' });
    await wake(f.agentId);
    expect((await goalRow(f.goalId)).blocked_reason).toBeNull();
  });
});

describe('what is carried is evidence, never model output', () => {
  it('keeps a model sentinel out of the checkpoint, the attempts and the model call records', async () => {
    const f = await planningAgent();
    const adapter = getAdapter('mock');
    const original = adapter.generate.bind(adapter);
    vi.spyOn(adapter, 'generate').mockImplementation(async request => {
      const called = request.messages.some(m => m.role === 'system' && m.content.startsWith('test.clock returned:'));
      return called ? { text: 'PRIVATE_REASONING_SENTINEL', requestId: null, promptTokens: null, completionTokens: null, raw: null }
        : original(request);
    });
    await wake(f.agentId);
    const row = await goalRow(f.goalId);
    expect(row.resume).toMatchObject({ attemptNo: 1, facts: [{ capabilityId: 'test.clock', summary: 'now: noon' }] });
    const calls = await query('SELECT * FROM model_calls WHERE agent_id=$1', [f.agentId]);
    expect(calls.length).toBeGreaterThan(0);
    const stored = JSON.stringify([row.resume, row.plan, await attemptsOf(f.goalId), calls]);
    expect(stored).not.toContain('PRIVATE_REASONING_SENTINEL');
  });
});

describe('owner view and decisions', () => {
  async function owned(model?: string) {
    const f = await planningAgent('ACT', model);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login',
      payload: { email: f.ownerEmail, password: 'test-password-1234' } });
    const headers = { authorization: `Bearer ${login.json().data.token}` };
    return { ...f, headers, base: `/api/agents/${f.agentId}/mind/goals/${f.goalId}` };
  }

  it('lists attempts with steps, sentences and the day budget', async () => {
    const f = await owned();
    await wake(f.agentId);
    const response = await app.inject({ url: `${f.base}/attempts`, headers: f.headers });
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.attempts).toHaveLength(1);
    expect(data.attempts[0]).toMatchObject({ attemptNo: 1, state: 'COMPLETED', steps: [{ capabilityId: 'test.clock' }] });
    expect(data.attempts[0].summary).toEqual(expect.any(String));
    expect(data.usage).toMatchObject({ stepsUsed: 1, stepBudget: 6, timeBudgetMs: 180_000 });
  });

  it('accept-end settles the goal through updateGoal and audits it', async () => {
    const f = await owned('mock-fixed:DONE: shipped the report');
    await wake(f.agentId);
    const accepted = await app.inject({ method: 'POST', url: `${f.base}/accept-end`, headers: f.headers });
    expect(accepted.statusCode).toBe(200);
    expect(await goalRow(f.goalId)).toMatchObject({ status: 'COMPLETED', resolution: 'shipped the report',
      proposed_end: null });
    expect((await goalRow(f.goalId)).resolved_at).not.toBeNull();
    const [audit] = await query("SELECT action FROM audit_events WHERE entity_id::text=$1 AND action='mind.goal.end.accepted'", [f.agentId]);
    expect(audit).toBeDefined();
    expect((await app.inject({ method: 'POST', url: `${f.base}/accept-end`, headers: f.headers })).statusCode).toBe(409);
  });

  it('an accepted ABANDON marks the goal abandoned', async () => {
    const f = await owned('mock-fixed:ABANDON: the source is gone for good');
    await wake(f.agentId);
    await app.inject({ method: 'POST', url: `${f.base}/accept-end`, headers: f.headers });
    expect(await goalRow(f.goalId)).toMatchObject({ status: 'ABANDONED', resolution: 'the source is gone for good' });
  });

  it('dismiss-end clears the proposal, resets the quiet count and allows the next attempt', async () => {
    const f = await owned('mock-fixed:DONE: shipped the report');
    await wake(f.agentId);
    await query('UPDATE agent_goals SET quiet_attempts=5 WHERE id=$1', [f.goalId]);
    const dismissed = await app.inject({ method: 'POST', url: `${f.base}/dismiss-end`, headers: f.headers });
    expect(dismissed.statusCode).toBe(200);
    expect(await goalRow(f.goalId)).toMatchObject({ proposed_end: null, proposed_end_reason: '', status: 'ACTIVE', quiet_attempts: 0 });
    await wake(f.agentId);
    expect(await attemptsOf(f.goalId)).toHaveLength(2);
  });

  it('unblock clears the block so a new attempt can start', async () => {
    const f = await owned();
    await query("UPDATE agent_goals SET blocked_reason='A write may or may not have happened; the owner must check.' WHERE id=$1", [f.goalId]);
    await wake(f.agentId);
    expect(await attemptsOf(f.goalId)).toHaveLength(0);
    const response = await app.inject({ method: 'POST', url: `${f.base}/unblock`, headers: f.headers });
    expect(response.statusCode).toBe(200);
    await wake(f.agentId);
    expect(await attemptsOf(f.goalId)).toHaveLength(1);
  });

  it('edits budgets through the existing PATCH within range', async () => {
    const f = await owned();
    const ok = await app.inject({ method: 'PATCH', url: f.base, headers: f.headers,
      payload: { dailyStepBudget: 10, dailyTimeBudgetMs: 300_000 } });
    expect(ok.statusCode).toBe(200);
    expect(await goalRow(f.goalId)).toMatchObject({ daily_step_budget: 10, daily_time_budget_ms: 300_000 });
    for (const payload of [{ dailyStepBudget: 0 }, { dailyStepBudget: 31 }, { dailyTimeBudgetMs: 9_999 }]) {
      expect((await app.inject({ method: 'PATCH', url: f.base, headers: f.headers, payload })).statusCode).toBe(422);
    }
  });

  it('keeps another owner out of every decision', async () => {
    const f = await owned('mock-fixed:DONE: shipped the report');
    await wake(f.agentId);
    const other = await createFixture();
    const login = await app.inject({ method: 'POST', url: '/api/auth/login',
      payload: { email: other.ownerEmail, password: 'test-password-1234' } });
    const headers = { authorization: `Bearer ${login.json().data.token}` };
    for (const [method, path] of [['GET', 'attempts'], ['POST', 'accept-end'], ['POST', 'dismiss-end'], ['POST', 'unblock']] as const) {
      const response = await app.inject({ method, url: `${f.base}/${path}`, headers });
      expect([403, 404]).toContain(response.statusCode);
    }
    expect((await goalRow(f.goalId)).status).toBe('ACTIVE');
  });
});
