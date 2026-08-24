import type { PolicyConfig, ResolvedContext } from '@xbam/shared/contracts';
import { jobs as jobsRepo, observability } from '@xbam/database';

export type GateDecision =
  | { allow: true }
  | { allow: false; kind: 'PERMANENT' | 'RETRYABLE'; reason: string; message: string; retryAfterMs?: number };

function normalizeHandle(handle: string | null | undefined): string {
  return (handle ?? '').trim().replace(/^@+/, '').toLowerCase();
}

/** Blocklists and self-reply protection. Evaluated before anything is generated. */
export function checkAudience(policy: PolicyConfig, context: ResolvedContext): GateDecision {
  const author = normalizeHandle(context.targetAuthorHandle);
  if (!author) return { allow: true };

  const self = policy.content.selfHandles.map(normalizeHandle).filter(Boolean);
  if (self.includes(author)) {
    return {
      allow: false,
      kind: 'PERMANENT',
      reason: 'self_target',
      message: `The target belongs to this agent (@${author}). Acting would start a self-conversation.`,
    };
  }
  if (policy.content.blockedRemoteHandles.map(normalizeHandle).includes(author)) {
    return {
      allow: false,
      kind: 'PERMANENT',
      reason: 'blocked_handle',
      message: `@${author} is on this agent blocked list.`,
    };
  }
  const allowlist = policy.content.allowedRemoteHandles.map(normalizeHandle).filter(Boolean);
  if (allowlist.length > 0 && !allowlist.includes(author)) {
    return {
      allow: false,
      kind: 'PERMANENT',
      reason: 'not_allowlisted',
      message: `@${author} is not on this agent allowlist.`,
    };
  }
  return { allow: true };
}

function withinWorkingHours(policy: PolicyConfig, now: Date): boolean {
  const hours = policy.rate.workingHours;
  if (!hours.enabled) return true;
  let hour: number;
  try {
    hour = Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: hours.timezone, hour: 'numeric', hour12: false }).format(now),
    );
  } catch {
    // An invalid timezone must not silently block every action.
    return true;
  }
  if (hours.startHour <= hours.endHour) return hour >= hours.startHour && hour <= hours.endHour;
  // Overnight window, e.g. 22:00 to 06:00.
  return hour >= hours.startHour || hour <= hours.endHour;
}

/**
 * Rate limits and working hours, checked immediately before a real remote action.
 * Exceeding a limit is retryable: the job waits rather than being thrown away.
 */
export async function checkActionRate(agentId: string, policy: PolicyConfig): Promise<GateDecision> {
  const now = new Date();
  if (!withinWorkingHours(policy, now)) {
    return {
      allow: false,
      kind: 'RETRYABLE',
      reason: 'outside_working_hours',
      message: `Outside configured working hours (${policy.rate.workingHours.startHour}:00 to ${policy.rate.workingHours.endHour}:00 ${policy.rate.workingHours.timezone}).`,
      retryAfterMs: 15 * 60_000,
    };
  }

  if (policy.rate.maxActionsPerHour > 0) {
    const lastHour = await jobsRepo.countRecentActions(agentId, 60);
    if (lastHour >= policy.rate.maxActionsPerHour) {
      return {
        allow: false,
        kind: 'RETRYABLE',
        reason: 'hourly_rate_limit',
        message: `Hourly action limit reached (${lastHour}/${policy.rate.maxActionsPerHour}).`,
        retryAfterMs: 10 * 60_000,
      };
    }
  }

  if (policy.rate.maxActionsPerDay > 0) {
    const lastDay = await jobsRepo.countRecentActions(agentId, 60 * 24);
    if (lastDay >= policy.rate.maxActionsPerDay) {
      return {
        allow: false,
        kind: 'RETRYABLE',
        reason: 'daily_rate_limit',
        message: `Daily action limit reached (${lastDay}/${policy.rate.maxActionsPerDay}).`,
        retryAfterMs: 60 * 60_000,
      };
    }
  }

  if (policy.rate.minSecondsBetweenActions > 0) {
    const last = await jobsRepo.lastExecutedActionAt(agentId);
    if (last) {
      const elapsedMs = Date.now() - new Date(last).getTime();
      const requiredMs = policy.rate.minSecondsBetweenActions * 1_000;
      if (elapsedMs < requiredMs) {
        return {
          allow: false,
          kind: 'RETRYABLE',
          reason: 'action_cooldown',
          message: `Cooling down between actions (${Math.ceil((requiredMs - elapsedMs) / 1000)}s remaining).`,
          retryAfterMs: requiredMs - elapsedMs,
        };
      }
    }
  }

  return { allow: true };
}

/** Daily spend ceiling, checked before generation. */
export async function checkBudget(agentId: string, policy: PolicyConfig): Promise<GateDecision> {
  const cap = policy.budget.maxCostUsdPerDay;
  if (cap === null) return { allow: true };
  const spent = await observability.spendToday(agentId);
  if (spent >= cap) {
    return {
      allow: false,
      kind: 'RETRYABLE',
      reason: 'daily_budget_exhausted',
      message: `Daily model budget reached (${spent.toFixed(4)} of ${cap} USD).`,
      retryAfterMs: 60 * 60_000,
    };
  }
  return { allow: true };
}
