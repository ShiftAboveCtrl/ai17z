import type { CadenceConfig, QuietHours } from '@xbam/shared/contracts';
import { cadences as cadencesRepo, jobs as jobsRepo } from '@xbam/database';

/**
 * The cadence engine.
 *
 * Everything that asks "may this happen now, and if not, when?" asks here. The
 * point is not the arithmetic, which is simple; it is that there is one answer
 * per account instead of a global env var, a per-agent policy and a queue
 * interval each having an opinion and none of them visible to the owner.
 */

/** Local hour in a timezone, or null when the timezone is not one Node knows. */
function localHour(timezone: string, at: Date): number | null {
  try {
    return Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: 'numeric', hour12: false }).format(at),
    );
  } catch {
    return null;
  }
}

export function withinQuietHours(hours: QuietHours, at: Date): boolean {
  if (!hours.enabled) return false;
  const hour = localHour(hours.timezone, at);
  // An unusable timezone must never silence an account permanently. Failing open
  // is a visible mistake; failing closed is an agent that mysteriously stops.
  if (hour === null) return false;
  const awake =
    hours.startHour <= hours.endHour
      ? hour >= hours.startHour && hour <= hours.endHour
      : hour >= hours.startHour || hour <= hours.endHour;
  return !awake;
}

/** Milliseconds until the account's next waking hour. */
export function msUntilAwake(hours: QuietHours, at: Date): number {
  if (!withinQuietHours(hours, at)) return 0;
  const hour = localHour(hours.timezone, at);
  if (hour === null) return 0;
  const hoursToWait = hour < hours.startHour ? hours.startHour - hour : 24 - hour + hours.startHour;
  // Wake on the hour boundary rather than exactly at the target, so a check that
  // lands a minute early does not sleep another full hour.
  return Math.max(60_000, hoursToWait * 3_600_000 - at.getMinutes() * 60_000);
}

/** Applies jitter symmetrically around the base interval. */
export function jitter(baseMs: number, percent: number, random: () => number = Math.random): number {
  if (percent <= 0) return baseMs;
  const spread = baseMs * (percent / 100);
  return Math.max(1_000, Math.round(baseMs - spread + random() * spread * 2));
}

/**
 * When to poll this account next.
 *
 * Idle backoff doubles per consecutive empty poll up to the ceiling; anything
 * found resets it. Quiet hours override both — there is no point polling an
 * account that may not act on what it finds.
 */
export function nextPollDelayMs(
  config: CadenceConfig,
  options: { emptyStreak: number; foundEvents: boolean; now?: Date; random?: () => number },
): number {
  const now = options.now ?? new Date();
  const asleep = msUntilAwake(config.quietHours, now);
  if (asleep > 0) return asleep;
  if (!config.polling.enabled) return config.polling.maxIntervalSeconds * 1_000;

  const base = config.polling.intervalSeconds * 1_000;
  const streak = options.foundEvents ? 0 : options.emptyStreak;
  const grown = config.polling.backoffWhenIdle ? base * 2 ** Math.min(streak, 10) : base;
  const capped = Math.min(grown, config.polling.maxIntervalSeconds * 1_000);
  return jitter(capped, config.polling.jitterPercent, options.random);
}

export type CadenceDecision =
  | { allow: true }
  | { allow: false; reason: string; message: string; retryAfterMs: number; boundBy: 'account' | 'agent' };

/**
 * Whether this account may act right now.
 *
 * Account ceilings and agent policy limits are both evaluated and the tighter
 * one wins. The verdict names which, because "rate limited" without saying
 * whose limit it was is the kind of message that wastes an afternoon.
 */
export async function checkAccountCadence(
  accountId: string,
  config: CadenceConfig,
  now: Date = new Date(),
): Promise<CadenceDecision> {
  if (withinQuietHours(config.quietHours, now)) {
    return {
      allow: false,
      reason: 'account_quiet_hours',
      message: `This account is outside its active hours (${config.quietHours.startHour}:00 to ${config.quietHours.endHour}:00 ${config.quietHours.timezone}).`,
      retryAfterMs: msUntilAwake(config.quietHours, now),
      boundBy: 'account',
    };
  }

  const acting = config.acting;
  if (acting.maxActionsPerHour > 0) {
    const count = await jobsRepo.countRecentAccountActions(accountId, 60);
    if (count >= acting.maxActionsPerHour) {
      return {
        allow: false,
        reason: 'account_hourly_limit',
        message: `This account has reached its hourly ceiling (${count}/${acting.maxActionsPerHour}), which is separate from the agent limit.`,
        retryAfterMs: 10 * 60_000,
        boundBy: 'account',
      };
    }
  }
  if (acting.maxActionsPerDay > 0) {
    const count = await jobsRepo.countRecentAccountActions(accountId, 60 * 24);
    if (count >= acting.maxActionsPerDay) {
      return {
        allow: false,
        reason: 'account_daily_limit',
        message: `This account has reached its daily ceiling (${count}/${acting.maxActionsPerDay}).`,
        retryAfterMs: 60 * 60_000,
        boundBy: 'account',
      };
    }
  }
  if (acting.minSecondsBetweenActions > 0) {
    const last = await jobsRepo.lastAccountActionAt(accountId);
    if (last) {
      const requiredMs = acting.minSecondsBetweenActions * 1_000;
      const elapsedMs = now.getTime() - new Date(last).getTime();
      if (elapsedMs < requiredMs) {
        return {
          allow: false,
          reason: 'account_cooldown',
          message: `This account is cooling down between actions (${Math.ceil((requiredMs - elapsedMs) / 1_000)}s remaining). Other agents share the same account.`,
          retryAfterMs: requiredMs - elapsedMs,
          boundBy: 'account',
        };
      }
    }
  }
  return { allow: true };
}

/** Loads the cadence in force and evaluates it. */
export async function checkAccountCadenceById(accountId: string): Promise<CadenceDecision> {
  return checkAccountCadence(accountId, await cadencesRepo.activeCadence(accountId));
}
