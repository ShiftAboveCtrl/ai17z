import { agents, deliberation as mind, observability } from '@xbam/database';
import { generate, resolveTargets } from '@xbam/models';
import { autonomyAtLeast, type GoalPlan } from '@xbam/shared/contracts';
import { createLogger } from '@xbam/shared';
import { capabilitySettings } from './capabilityPermissions';
import { runCapabilityLoop } from './capabilityLoop';
import { chargeGrowthSession, growthGateFor, policyFor } from './growthGate';
import { pauseState } from './killSwitch';

// Three choices cover a lookup, a follow-up and an action without letting one
// goal occupy the wake indefinitely. This also caps paid classifier turns.
const GOAL_PLAN_MAX_STEPS = 3;
// A minute leaves room for normal reads while yielding to the next wake.
// The existing loop checks elapsed time; there is no plan timer or scheduler.
const GOAL_PLAN_BUDGET_MS = 60_000;
const log = createLogger('goal-plans');

/** One goal, one bounded attempt. The owner still decides goal progress. */
export async function pursueGoal(agentId: string, accountId: string | null): Promise<string | null> {
  const unavailable = () => {
    log.warn('goal planning pre-claim read was unavailable', { agentId });
    return null;
  };
  const agent = await agents.getAgent(agentId).catch(unavailable);
  const wake = await mind.getWake(agentId).catch(unavailable);
  if (!agent || !wake?.enabled || !autonomyAtLeast(wake.autonomy, 'THINK')) return null;
  const policy = await policyFor(agent).catch(unavailable);
  const paused = await pauseState().catch(unavailable);
  if (!policy?.tools.capabilityLoop || !paused || paused.paused) return null;
  const targets = await resolveTargets(agentId, 'classifier').catch(unavailable);
  if (!targets?.length) return null;

  const goals = await mind.listGoals(agentId, { status: 'ACTIVE' }).catch(unavailable);
  if (!goals) return null;
  // A process that stopped after a committed claim cannot safely replay a
  // write. Record the interrupted attempt after its budget, then leave it ended.
  for (const goal of goals) {
    if (goal.plan?.state === 'RUNNING' && Date.now() >= Date.parse(goal.plan.startedAt) + GOAL_PLAN_BUDGET_MS) {
      await mind.saveGoalPlan(goal.id, { ...goal.plan, state: 'STOPPED',
        summary: 'The plan was interrupted and will not be replayed.' });
    }
  }
  if (goals.some(goal => goal.plan?.state === 'RUNNING')) return null;
  const goal = goals.find(goal => goal.plan === null);
  if (!goal) return null;

  const plan: GoalPlan = {
    state: 'RUNNING', startedAt: new Date().toISOString(), maxSteps: GOAL_PLAN_MAX_STEPS,
    budgetMs: GOAL_PLAN_BUDGET_MS, steps: [], summary: 'A bounded plan is running.',
  };
  if (!(await mind.claimGoalPlan(goal.id, plan))) return null;

  try {
    const settings = await capabilitySettings(agentId, { failClosed: true });
    const result = await runCapabilityLoop({
      agentId, jobId: null, accountId, ...settings, paused: false,
      task: goal.summary, maxSteps: GOAL_PLAN_MAX_STEPS,
      budgetMs: Math.max(0, GOAL_PLAN_BUDGET_MS - (Date.now() - Date.parse(plan.startedAt))),
      messages: [
        { role: 'system', content: 'Pursue the owner goal with a bounded sequence of capability calls. ' +
          'Use each result to choose the next step. Stop when nothing useful remains. ' +
          'Return only a capability call or a concise conclusion. Never return private reasoning. ' +
          'Do not claim the owner goal is complete or change its progress.' },
        { role: 'user', content: goal.summary },
      ],
      generate: async messages => {
        const currentAgent = await agents.getAgent(agentId);
        if (!currentAgent) throw new Error('The agent no longer exists.');
        const gate = await growthGateFor(agentId, accountId, await policyFor(currentAgent));
        if (!gate.allowed) throw new Error('The growth budget no longer allows a model call.');
        await chargeGrowthSession(agentId, 'model');
        const remaining = GOAL_PLAN_BUDGET_MS - (Date.now() - Date.parse(plan.startedAt));
        if (remaining <= 0) throw new Error('The plan time budget was exhausted.');
        return (await generate({ agentId, jobId: null, role: 'classifier',
          purpose: 'goal-plan', messages, maxCalls: 1, retainOutput: false, timeoutMs: remaining })).text;
      },
      goalPlan: {
        sourceRef: `${goal.id}:${plan.startedAt}`,
        checkpoint: async () => {
          const [currentAgent, currentWake, paused, currentGoals, currentSettings] = await Promise.all([
            agents.getAgent(agentId), mind.getWake(agentId), pauseState(),
            mind.listGoals(agentId, { status: 'ACTIVE' }), capabilitySettings(agentId, { failClosed: true }),
          ]);
          const currentPolicy = currentAgent ? await policyFor(currentAgent) : null;
          return { ...currentSettings, paused: paused.paused, autonomy: currentWake?.autonomy ?? 'OBSERVE',
            enabled: currentAgent?.state === 'ACTIVE' && currentWake?.enabled === true &&
              currentPolicy?.tools.capabilityLoop === true && currentGoals.some(g => g.id === goal.id) };
        },
        onStep: async (step, index) => {
          // All queries are committed individually. Trace emission never waits
          // on a foreign key held by an open transaction.
          plan.steps.push({ capabilityId: step.capabilityId, outcome: step.outcome,
            durationMs: step.durationMs, input: step.input ?? null });
          await mind.saveGoalPlan(goal.id, plan);
          await observability.emitTrace({ jobId: null, agentId, type: 'CAPABILITY_USED',
            message: step.detail, data: { goalId: goal.id, step: index, capabilityId: step.capabilityId,
              outcome: step.outcome, durationMs: step.durationMs } });
        },
      },
    });
    plan.state = result.halted ?? (result.exhausted ? 'EXHAUSTED' : 'COMPLETED');
    plan.summary = result.reason ?? 'The bounded plan concluded; goal progress remains the owner\'s decision.';
  } catch {
    // Raw model text and provider errors can contain private content. A failed
    // gate or call ends this attempt with a runtime sentence, never a transcript.
    const exhausted = Date.now() >= Date.parse(plan.startedAt) + GOAL_PLAN_BUDGET_MS;
    plan.state = exhausted ? 'EXHAUSTED' : 'STOPPED';
    plan.summary = exhausted ? 'The plan ended because its time budget was exhausted.'
      : 'The plan stopped because a required gate, model call or record was unavailable.';
  }
  await mind.saveGoalPlan(goal.id, plan);
  return plan.summary;
}
