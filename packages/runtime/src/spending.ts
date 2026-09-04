/**
 * What an agent has spent, and whether each limit on it can actually fire.
 *
 * The gate in `policyGate.ts` decides; this describes. They are separate because
 * a limit is only useful if somebody can see how close to it they are before it
 * stops a job, and because one of these limits is measurable only when a person
 * has told AI17Z what the model charges.
 *
 * That last point is the reason this file exists at all. A cost is written to a
 * model call only where the role carries a price per thousand tokens, so a
 * "5 USD a day" limit set against models with no prices reads 0.00 of 5.00
 * forever and never stops anything. Guessing prices per model would be worse --
 * a wrong number stops an agent that was within its budget, and a stale one
 * lets it past. So the limit stays honest and says it cannot be enforced yet.
 */
import type { PolicyConfig } from '@xbam/shared/contracts';
import { observability } from '@xbam/database';

export interface LimitReport {
  /** What the owner set it to; null when there is no limit. */
  limit: number | null;
  used: number;
  /** True when the limit is set and nothing could enforce it. */
  inert: boolean;
  /** A whole sentence, because a number on its own explains nothing. */
  says: string;
}

export interface SpendingReport {
  callsPerJob: LimitReport;
  callsPerDay: LimitReport;
  callsPerMonth: LimitReport;
  researchPerEvent: LimitReport;
  costPerDay: LimitReport;
  /** Everything that needs attention, in the words the screen shows. */
  warnings: string[];
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export async function describeSpending(agentId: string, policy: PolicyConfig): Promise<SpendingReport> {
  const budget = policy.budget;
  const [today, month, coverage, spent] = await Promise.all([
    observability.callsSince(agentId, 'day'),
    observability.callsSince(agentId, 'month'),
    observability.costCoverage(agentId),
    observability.spendToday(agentId),
  ]);

  const warnings: string[] = [];

  const callsPerJob: LimitReport = {
    limit: budget.maxModelCallsPerJob,
    used: 0,
    inert: false,
    says: `At most ${plural(budget.maxModelCallsPerJob, 'model call', 'model calls')} for any one message, including retries and fallbacks.`,
  };

  const researchPerEvent: LimitReport = {
    limit: budget.maxResearchCallsPerEvent,
    used: 0,
    inert: false,
    says:
      budget.maxResearchCallsPerEvent === 0
        ? 'This agent never looks anything up.'
        : `At most ${plural(budget.maxResearchCallsPerEvent, 'lookup', 'lookups')} for any one message. A longer plan is trimmed to its most important entries.`,
  };

  const callsPerDay: LimitReport = {
    limit: budget.maxModelCallsPerDay,
    used: today,
    inert: false,
    says:
      budget.maxModelCallsPerDay === null
        ? `${plural(today, 'model call', 'model calls')} today. No daily limit.`
        : `${today} of ${budget.maxModelCallsPerDay} model calls today.`,
  };

  const callsPerMonth: LimitReport = {
    limit: budget.maxModelCallsPerMonth,
    used: month,
    inert: false,
    says:
      budget.maxModelCallsPerMonth === null
        ? `${plural(month, 'model call', 'model calls')} this month. No monthly limit.`
        : `${month} of ${budget.maxModelCallsPerMonth} model calls this month.`,
  };

  // Inert when a limit is set, calls have happened, and none of them carried a
  // price. Not when nothing has run yet -- an agent that has made no calls
  // today tells us nothing about whether its models are priced.
  const nothingPriced = coverage.calls > 0 && coverage.priced === 0;
  const costPerDay: LimitReport = {
    limit: budget.maxCostUsdPerDay,
    used: spent,
    inert: budget.maxCostUsdPerDay !== null && nothingPriced,
    says:
      budget.maxCostUsdPerDay === null
        ? nothingPriced
          ? 'No spending limit. Nothing is being costed, because no model here has a price set.'
          : `${spent.toFixed(2)} USD today. No spending limit.`
        : nothingPriced
          ? `This limit cannot stop anything yet: none of today's ${plural(coverage.calls, 'call', 'calls')} was costed, because no model here has a price set. Set the price per thousand tokens on the models it uses.`
          : `${spent.toFixed(2)} of ${budget.maxCostUsdPerDay.toFixed(2)} USD today.`,
  };

  if (costPerDay.inert) warnings.push(costPerDay.says);
  if (callsPerDay.limit !== null && today >= callsPerDay.limit) {
    warnings.push('The daily model call limit has been reached. Nothing more will be generated until it resets.');
  }
  if (callsPerMonth.limit !== null && month >= callsPerMonth.limit) {
    warnings.push('The monthly model call limit has been reached.');
  }
  if (
    callsPerDay.limit === null &&
    callsPerMonth.limit === null &&
    budget.maxCostUsdPerDay === null
  ) {
    warnings.push('Nothing caps what this agent spends over a day or a month. Only the per-message limit applies.');
  }

  return { callsPerJob, callsPerDay, callsPerMonth, researchPerEvent, costPerDay, warnings };
}

/**
 * Trims a research plan to what the owner allows for one message.
 *
 * From the front rather than by dropping the plan, because whoever decided what
 * was worth looking up put the most important first: keeping the best two of an
 * over-ambitious three answers more of the question than looking nothing up.
 *
 * A cap of zero means an agent that never looks anything up, which is a
 * deliberate setting rather than an error.
 */
export function capResearch<T>(lookups: readonly T[], cap: number): T[] {
  if (!Number.isFinite(cap) || cap < 0) return [...lookups];
  return lookups.slice(0, Math.floor(cap));
}
