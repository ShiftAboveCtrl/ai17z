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
  const [open, sessionsHour, sessions, lastEnded, spent, health] = await Promise.all([
    autonomyRepo.openSession(agentId),
    autonomyRepo.sessionsThisHour(agentId),
    autonomyRepo.sessionsToday(agentId),
    autonomyRepo.lastSessionEndedAt(agentId),
    autonomyRepo.spentToday(agentId),
    accountId ? autonomyRepo.getAccountHealth(accountId) : Promise.resolve(null),
  ]);

  const facts: GrowthFacts = {
    sessionsThisHour: sessionsHour,
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
    accountHealthUntil: health?.healthUntil ?? null,
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

/** The states that mean the open session itself is what ran out. */
const SESSION_IS_OVER = new Set<GrowthVerdict['state']>(['RESTING', 'SPENT', 'QUIET_HOURS']);

/**
 * Settle the ledger, then say where the agent stands.
 *
 * This is the half that was missing. `openOrContinueSession` and
 * `closeSession` shipped and were called by nothing, so `agent_growth_sessions`
 * had no rows on either live installation: the gate read "no session open,
 * nothing spent, nothing to rest from" every time and therefore always said
 * yes. Nothing was being suppressed, which is why it went unnoticed, and none
 * of the pacing the policy describes was happening either.
 *
 * Closing has to happen here rather than at the end of whatever did the work,
 * because the process that opened a session is exactly the process that may
 * not survive to close it. A worker killed mid-session leaves an open row, and
 * without this the agent reads as RESTING for ever: the window says the
 * session has run its time, and the cooldown that would clear it never starts
 * because the cooldown is measured from a close that never happened. The same
 * wedge catches a session that did no work at all, which is the ordinary case
 * on a quiet afternoon.
 *
 * Deliberately a separate function from `growthGateFor` rather than a flag on
 * it. `growthGateFor` is what the autonomy screen reads, and a status read
 * that closes the thing it is describing is a screen that changes the system
 * by being looked at.
 */
export async function settleGrowthSession(
  agentId: string,
  accountId: string | null,
  policy: PolicyConfig | Promise<PolicyConfig>,
  now = new Date(),
): Promise<GrowthVerdict> {
  const resolved = await policy;
  const verdict = await growthGateFor(agentId, accountId, resolved, now);
  if (verdict.allowed || !SESSION_IS_OVER.has(verdict.state)) return verdict;
  if (!(await autonomyRepo.openSession(agentId))) return verdict;

  // The window's own sentence is the reason, so the ledger says the same thing
  // the owner was told rather than a second paraphrase of it.
  await autonomyRepo.endSession(agentId, verdict.message);
  // Read again: the cooldown now starts from this moment, so what the caller
  // gets back is the state the agent is actually in and not the one it was in
  // a line ago.
  // `endSession` uses the database clock. The caller's `now` was captured
  // before that write, so with a zero-minute cooldown it can be a few
  // milliseconds earlier than `ended_at` and look as though the cooldown has
  // not begun yet. Re-read no earlier than the completed write.
  return growthGateFor(agentId, accountId, resolved, new Date(Math.max(now.getTime(), Date.now())));
}

/**
 * Settle, and open a session when there is room for one.
 *
 * The one call a caller about to do optional work needs. Returns the verdict
 * it should obey; when that verdict allows, a session is open and charging it
 * is the caller's business.
 */
export async function beginGrowthSession(
  agentId: string,
  accountId: string | null,
  policy: PolicyConfig | Promise<PolicyConfig>,
  now = new Date(),
): Promise<GrowthVerdict> {
  const verdict = await settleGrowthSession(agentId, accountId, policy, now);
  if (!verdict.allowed) return verdict;
  await openOrContinueSession(agentId);
  // ELIGIBLE meant "could start one"; one has now started.
  return verdict.state === 'ELIGIBLE'
    ? { ...verdict, state: 'OPEN', message: 'A growth session is running.' }
    : verdict;
}

/**
 * Charge the open session for something it spent.
 *
 * Silent when no session is open, which is correct rather than lax: work done
 * outside a session is work the budget was never meant to cover, and throwing
 * here would turn an accounting question into a failed wake.
 */
export async function chargeGrowthSession(
  agentId: string,
  what: 'candidates' | 'model' | 'research' | 'action',
  howMany = 1,
): Promise<void> {
  if (howMany <= 0) return;
  await autonomyRepo.chargeSession(agentId, what, howMany);
}
