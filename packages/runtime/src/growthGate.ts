import { agents as agentsRepo, autonomy as autonomyRepo } from '@xbam/database';
import { PolicyConfig } from '@xbam/shared/contracts';
import { growthWindow, type GrowthFacts, type GrowthVerdict } from './growthWindow';

/**
 * The gathering half of the growth decision.
 *
 * `growthWindow` is pure and takes the counts; this is what goes and gets
 * them. Split for the reason `salience.ts` gives: the judgement is the thing
 * worth pinning in a test, and a judgement that can only be exercised through
 * a database is a judgement nobody writes enough tests for.
 *
 * Every count here is read from rows that already exist. Nothing keeps a
 * running total in a process, because a counter in memory resets when the
 * worker is upgraded and an agent whose budget resets on deploy has no budget.
 */

/** The policy for one agent, or the defaults when it has none. */
export async function policyFor(agent: { id: string; policyVersionId: string | null }): Promise<PolicyConfig> {
  const row = agent.policyVersionId
    ? await agentsRepo.getPolicyVersion(agent.policyVersionId)
    : await agentsRepo.getActivePolicy(agent.id);
  return PolicyConfig.parse(row?.config ?? {});
}

/**
 * Whether this agent may go looking for people right now.
 *
 * Returns null rather than throwing when something cannot be read: growth
 * being unavailable is not a reason to stop an agent thinking, and the caller
 * treats a null as "no opinion" and carries on. Failing closed here would mean
 * a transient database blip silently switched an agent's autonomy off.
 */
export async function growthGateFor(
  agentId: string,
  accountId: string | null,
  policy: PolicyConfig | Promise<PolicyConfig>,
  now = new Date(),
): Promise<GrowthVerdict> {
  const resolved = await policy;
  const [open, sessions, lastEnded, spent, health] = await Promise.all([
    autonomyRepo.openSession(agentId),
    autonomyRepo.sessionsToday(agentId),
    autonomyRepo.lastSessionEndedAt(agentId),
    autonomyRepo.spentToday(agentId),
    accountId ? autonomyRepo.getAccountHealth(accountId) : Promise.resolve(null),
  ]);

  const facts: GrowthFacts = {
    sessionsToday: sessions,
    openSessionStartedAt: open?.startedAt ?? null,
    lastSessionEndedAt: lastEnded,
    modelCallsToday: spent.modelCalls,
    researchToday: spent.researchCalls,
    modelCallsThisSession: open?.modelCalls ?? 0,
    researchThisSession: open?.researchCalls ?? 0,
    candidatesThisSession: open?.candidatesConsidered ?? 0,
    accountHealth: health?.health ?? 'HEALTHY',
    accountHealthReason: health?.healthReason ?? null,
  };

  return growthWindow(resolved.growth, facts, now);
}

/**
 * Opens a session if one is due, or closes one that has run its course.
 *
 * Called by whatever is about to do optional work, so the ledger reflects what
 * actually happened rather than what a timer thought would happen. A session
 * that produced nothing is still a session and still rests afterwards, which
 * is why closing is unconditional rather than depending on output.
 */
export async function openOrContinueSession(agentId: string): Promise<void> {
  if (!(await autonomyRepo.openSession(agentId))) await autonomyRepo.startSession(agentId);
}

export async function closeSession(agentId: string, reason: string): Promise<void> {
  await autonomyRepo.endSession(agentId, reason);
}
