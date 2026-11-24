import { agents, deliberation as mind, observability } from '@xbam/database';
import { generate, resolveTargets } from '@xbam/models';
import {
  autonomyAtLeast, GoalResume, type GoalAttemptState, type GoalFact, type GoalPlan,
} from '@xbam/shared/contracts';
import { createLogger } from '@xbam/shared';
import { getCapability } from '@xbam/tools';
import { capabilitySettings } from './capabilityPermissions';
import { runCapabilityLoop } from './capabilityLoop';
import { chargeGrowthSession, growthGateFor, policyFor } from './growthGate';
import {
  buildResume, factFromOutput, leavesWriteUncertain, nextAttemptDelayMs, parseGoalEnding,
  QUIET_ABANDON_REASON, QUIET_ATTEMPTS_BEFORE_ABANDON, renderResumeEvidence, WRITE_UNCERTAIN_REASON,
} from './goalResume';
import { pauseState } from './killSwitch';

// Three choices cover a lookup, a follow-up and an action without letting one
// goal occupy the wake indefinitely. This also caps paid classifier turns.
const GOAL_PLAN_MAX_STEPS = 3;
// A minute leaves room for normal reads while yielding to the next wake.
// The existing loop checks elapsed time; there is no plan timer or scheduler.
const GOAL_PLAN_BUDGET_MS = 60_000;
// Below this a model call cannot finish, so the day's time is treated as spent.
const MIN_ATTEMPT_MS = 1_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BUDGET_USED = 'A goal is out of budget for today; it tries again when earlier attempts leave the 24 hour window.';
const log = createLogger('goal-plans');

/**
 * One goal, one bounded attempt per wake, resumed on later wakes.
 *
 * Every attempt runs through the same loop and the same gates as the first
 * one. What carries over is evidence from earlier attempts, rendered inside the
 * untrusted fence, and a budget. The owner still decides goal status and
 * progress: an attempt can only propose an ending.
 */
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
  const interrupted = new Set<string>();
  for (const goal of goals) {
    if (goal.plan?.state !== 'RUNNING') continue;
    const endsAt = Date.parse(goal.plan.startedAt) + goal.plan.budgetMs;
    if (Date.now() < endsAt) continue;
    const delay = nextAttemptDelayMs(wake.intervalSeconds, goal.quietAttempts + 1);
    await mind.interruptGoalAttempt(goal.id, { ...goal.plan, state: 'STOPPED',
      summary: 'The plan was interrupted and will not be replayed.' },
    new Date(endsAt).toISOString(), new Date(Date.now() + delay).toISOString());
    interrupted.add(goal.id);
  }
  if (goals.some(goal => goal.plan?.state === 'RUNNING' && !interrupted.has(goal.id))) return null;

  const now = Date.now();
  // Highest priority first, then the goal that has waited longest.
  const due = goals
    .filter(goal => !interrupted.has(goal.id) && goal.plan?.state !== 'RUNNING')
    .filter(goal => goal.blockedReason === null && goal.proposedEnd === null)
    .filter(goal => goal.nextAttemptAt === null || Date.parse(goal.nextAttemptAt) <= now)
    .sort((a, b) => b.priority - a.priority ||
      (a.lastAttemptAt ? Date.parse(a.lastAttemptAt) : 0) - (b.lastAttemptAt ? Date.parse(b.lastAttemptAt) : 0));

  let budgetUsed = false;
  for (const goal of due) {
    const used = await mind.goalBudgetUse(goal.id).catch(unavailable);
    if (!used) return null;
    const stepsLeft = goal.dailyStepBudget - used.stepsUsed;
    const timeLeft = goal.dailyTimeBudgetMs - used.msUsed;
    if (stepsLeft <= 0 || timeLeft < MIN_ATTEMPT_MS) {
      // Wait until the oldest attempt leaves the window rather than asking again every wake.
      const frees = used.windowStartedAt ? Date.parse(used.windowStartedAt) + DAY_MS : now + DAY_MS;
      await mind.deferGoal(goal.id, new Date(Math.max(frees, now + 60_000)).toISOString()).catch(unavailable);
      budgetUsed = true;
      continue;
    }
    return attempt(agentId, accountId, goal, wake.intervalSeconds, {
      maxSteps: Math.min(GOAL_PLAN_MAX_STEPS, stepsLeft), budgetMs: Math.min(GOAL_PLAN_BUDGET_MS, timeLeft),
    });
  }
  return budgetUsed ? BUDGET_USED : null;
}

async function attempt(
  agentId: string, accountId: string | null, goal: Awaited<ReturnType<typeof mind.listGoals>>[number],
  wakeIntervalSeconds: number, ceilings: { maxSteps: number; budgetMs: number },
): Promise<string | null> {
  const plan: GoalPlan = {
    state: 'RUNNING', startedAt: new Date().toISOString(), maxSteps: ceilings.maxSteps,
    budgetMs: ceilings.budgetMs, steps: [], summary: 'A bounded plan is running.',
  };
  const claim = await mind.claimGoalAttempt(goal.id, plan);
  if (!claim) return null;

  // A checkpoint that fails its schema is ignored, never repaired.
  const prior = GoalResume.safeParse(goal.resume);
  const priorResume = prior.success ? prior.data : null;
  const evidence = renderResumeEvidence(priorResume, Date.now());
  const fresh: GoalFact[] = [];
  const last: { step: { capabilityId: string; outcome: string } | null } = { step: null };

  let state: GoalAttemptState;
  let answer = '';
  try {
    const settings = await capabilitySettings(agentId, { failClosed: true });
    const result = await runCapabilityLoop({
      agentId, jobId: null, accountId, ...settings, paused: false,
      task: goal.summary, maxSteps: plan.maxSteps,
      budgetMs: Math.max(0, plan.budgetMs - (Date.now() - Date.parse(plan.startedAt))),
      messages: [
        { role: 'system', content: 'Pursue the owner goal with a bounded sequence of capability calls. ' +
          'Use each result to choose the next step. Stop when nothing useful remains. ' +
          'Return only a capability call or a concise conclusion. Never return private reasoning. ' +
          'The owner decides whether a goal is complete and sets its progress. If the goal is finished, ' +
          'end your conclusion with a last line "DONE: <reason>". If it cannot be advanced, end with ' +
          '"ABANDON: <reason>". Either is only a proposal for the owner.' },
        ...(evidence ? [{ role: 'system' as const, content: evidence }] : []),
        { role: 'user', content: goal.summary },
      ],
      generate: async messages => {
        const currentAgent = await agents.getAgent(agentId);
        if (!currentAgent) throw new Error('The agent no longer exists.');
        const gate = await growthGateFor(agentId, accountId, await policyFor(currentAgent));
        if (!gate.allowed) throw new Error('The growth budget no longer allows a model call.');
        await chargeGrowthSession(agentId, 'model');
        const remaining = plan.budgetMs - (Date.now() - Date.parse(plan.startedAt));
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
          last.step = { capabilityId: step.capabilityId, outcome: step.outcome };
          if (step.outcome === 'SUCCEEDED') {
            const fact = factFromOutput(step.capabilityId, step.output, claim.attemptNo, Date.now());
            if (fact) fresh.push(fact);
          }
          await mind.saveGoalPlan(goal.id, plan);
          await mind.saveAttemptSteps(claim.attemptId, plan.steps);
          await observability.emitTrace({ jobId: null, agentId, type: 'CAPABILITY_USED',
            message: step.detail, data: { goalId: goal.id, step: index, capabilityId: step.capabilityId,
              outcome: step.outcome, durationMs: step.durationMs } });
        },
      },
    });
    state = result.halted ?? (result.exhausted ? 'EXHAUSTED' : 'COMPLETED');
    plan.summary = result.reason ?? 'The bounded plan concluded; goal progress remains the owner\'s decision.';
    answer = result.halted ? '' : result.answer;
  } catch {
    // Raw model text and provider errors can contain private content. A failed
    // gate or call ends this attempt with a runtime sentence, never a transcript.
    const exhausted = Date.now() >= Date.parse(plan.startedAt) + plan.budgetMs;
    state = exhausted ? 'EXHAUSTED' : 'STOPPED';
    plan.summary = exhausted ? 'The plan ended because its time budget was exhausted.'
      : 'The plan stopped because a required gate, model call or record was unavailable.';
  }
  plan.state = state;

  // A closed marker proposes an ending. The reason is kept on the goal for the
  // owner to read; the attempt record carries only a runtime sentence.
  let proposedEnd = parseGoalEnding(answer);
  if (proposedEnd) {
    plan.summary = proposedEnd.end === 'DONE'
      ? 'It proposed that this goal is done. The owner decides.'
      : 'It proposed abandoning this goal. The owner decides.';
  }

  // Never replayed: a write whose outcome is unknown stops the goal until the owner looks.
  const blockedReason = last.step && leavesWriteUncertain(getCapability(last.step.capabilityId)?.effect, last.step.outcome)
    ? WRITE_UNCERTAIN_REASON : null;
  if (blockedReason) plan.summary = blockedReason;

  const { resume, added } = buildResume({ prior: priorResume, fresh, attemptNo: claim.attemptNo,
    hint: plan.summary, outcome: state, now: Date.now() });
  const quietAttempts = added > 0 ? 0 : goal.quietAttempts + 1;
  if (!proposedEnd && !blockedReason && quietAttempts >= QUIET_ATTEMPTS_BEFORE_ABANDON) {
    proposedEnd = { end: 'ABANDON', reason: QUIET_ABANDON_REASON };
    plan.summary = QUIET_ABANDON_REASON;
  }
  await mind.finishGoalAttempt(goal.id, {
    attemptId: claim.attemptId, state, plan, summary: plan.summary, newFacts: added, resume, quietAttempts,
    nextAttemptAt: new Date(Date.now() + nextAttemptDelayMs(wakeIntervalSeconds, quietAttempts)).toISOString(),
    proposedEnd, blockedReason,
  });
  return plan.summary;
}
