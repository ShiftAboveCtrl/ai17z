import type { GrowthPolicy } from '@xbam/shared/contracts';

/**
 * Whether the agent may go looking for people right now, and why not.
 *
 * Pure, and takes the counts rather than reading them, for the reason
 * `salience.ts` gives about judgements an owner needs to be able to inspect:
 * what is worth pinning in a test is the decision, not a query. The gathering
 * lives in `growthGate.ts` beside it.
 *
 * Every answer carries a sentence. "Growth is paused" tells an owner nothing;
 * "resting until 09:00, and there are three sessions left today" tells them
 * whether anything is wrong.
 */

export type GrowthState = 'OPEN' | 'RESTING' | 'QUIET_HOURS' | 'SPENT' | 'OFF' | 'HELD';

export interface GrowthVerdict {
  /** Whether a session may run, or continue running, right now. */
  allowed: boolean;
  state: GrowthState;
  /** A sentence for the owner, always. */
  message: string;
  /** When it is worth asking again, when that is knowable. */
  retryAfterMs: number | null;
}

export interface GrowthFacts {
  /** Sessions started in the trailing twenty-four hours. */
  sessionsToday: number;
  /** When the open session started, if one is open. */
  openSessionStartedAt: string | null;
  /** When the last session ended. */
  lastSessionEndedAt: string | null;
  /** Optional model calls and lookups already spent today. */
  modelCallsToday: number;
  researchToday: number;
  /** What the open session has spent, when one is open. */
  modelCallsThisSession: number;
  researchThisSession: number;
  candidatesThisSession: number;
  /** The account's own health, which optional growth yields to first. */
  accountHealth: 'HEALTHY' | 'DEGRADED' | 'COOLDOWN' | 'HUMAN_ACTION_REQUIRED';
  accountHealthReason?: string | null;
}

/** Local hour in the agent's own timezone, or UTC when it cannot be read. */
export function localHour(timezone: string, now: Date): number {
  try {
    const formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).format(now);
    const hour = Number.parseInt(formatted, 10);
    return Number.isFinite(hour) ? hour % 24 : now.getUTCHours();
  } catch {
    /*
      An unusable timezone fails open, the same way the cadence engine's does.
      An agent that visibly ignores a bad setting beats one that mysteriously
      stops, and a typo in a timezone should not silence growth for ever with
      no way to tell why.
    */
    return now.getUTCHours();
  }
}

/**
 * Whether the local hour falls inside the quiet window.
 *
 * Half-open on purpose, `[start, end)`, so 23 to 7 is eight hours rather than
 * nine and the default really is the eight continuous hours it claims to be.
 * An overnight window is the ordinary case, not the exception.
 */
export function inQuietHours(policy: GrowthPolicy, now: Date): boolean {
  const { quietHoursStart: start, quietHoursEnd: end } = policy;
  if (start === end) return false;
  const hour = localHour(policy.timezone, now);
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** Milliseconds until the quiet window ends, from the top of the hour. */
function msUntilQuietEnds(policy: GrowthPolicy, now: Date): number {
  const hour = localHour(policy.timezone, now);
  let hours = policy.quietHoursEnd - hour;
  if (hours <= 0) hours += 24;
  // Only ever an estimate: it does not know the minute, and it does not need
  // to. Asking again an hour early costs one query.
  return hours * 60 * 60_000;
}

const minutes = (n: number) => n * 60_000;

/**
 * The whole decision, in one place.
 *
 * Ordered by what an owner would want told first. An account that needs a
 * person is not "resting", and saying so would be the same kind of comfortable
 * lie the radar was telling when it reported healthy sources it had never
 * polled.
 */
export function growthWindow(policy: GrowthPolicy, facts: GrowthFacts, now = new Date()): GrowthVerdict {
  if (!policy.enabled) {
    return { allowed: false, state: 'OFF', message: 'Going looking for people is switched off.', retryAfterMs: null };
  }

  /*
    Health first, and optional growth is what yields.

    A challenge or a lost session is the owner's to clear and nothing here
    should paper over it. Degraded and cooldown are the runtime coping, and the
    correct response to coping is to stop adding optional work to it -- reading
    what people sent is a different matter and is not gated here.
  */
  if (facts.accountHealth === 'HUMAN_ACTION_REQUIRED') {
    return {
      allowed: false,
      state: 'HELD',
      message: facts.accountHealthReason ?? 'This account needs you before it does anything else.',
      retryAfterMs: null,
    };
  }
  if (facts.accountHealth === 'COOLDOWN' || facts.accountHealth === 'DEGRADED') {
    return {
      allowed: false,
      state: 'HELD',
      message:
        facts.accountHealthReason ??
        'This account is having trouble, so it has stopped going looking for people until that settles.',
      retryAfterMs: minutes(10),
    };
  }

  if (inQuietHours(policy, now)) {
    return {
      allowed: false,
      state: 'QUIET_HOURS',
      message: `Resting until ${String(policy.quietHoursEnd).padStart(2, '0')}:00 ${policy.timezone}. Anything sent to this agent is still answered.`,
      retryAfterMs: msUntilQuietEnds(policy, now),
    };
  }

  // An open session runs until its time is up or its budget is gone. Checked
  // before the daily limits so a session in progress is not cut short by the
  // arithmetic that decides whether a *new* one may start.
  if (facts.openSessionStartedAt) {
    const ranFor = now.getTime() - new Date(facts.openSessionStartedAt).getTime();
    if (ranFor >= minutes(policy.sessionMinutes)) {
      return {
        allowed: false,
        state: 'RESTING',
        message: `This session ran its ${policy.sessionMinutes} minutes.`,
        retryAfterMs: minutes(policy.cooldownMinutes),
      };
    }
    if (facts.modelCallsThisSession >= policy.maxModelCallsPerSession) {
      return {
        allowed: false,
        state: 'SPENT',
        message: `This session has used its ${policy.maxModelCallsPerSession} model calls.`,
        retryAfterMs: minutes(policy.cooldownMinutes),
      };
    }
    if (facts.candidatesThisSession >= policy.maxCandidatesPerSession) {
      return {
        allowed: false,
        state: 'SPENT',
        message: `This session has already thought hard about ${policy.maxCandidatesPerSession}.`,
        retryAfterMs: minutes(policy.cooldownMinutes),
      };
    }
    return { allowed: true, state: 'OPEN', message: 'A growth session is running.', retryAfterMs: null };
  }

  if (facts.modelCallsToday >= policy.maxModelCallsPerDay) {
    return {
      allowed: false,
      state: 'SPENT',
      message: `Today's ${policy.maxModelCallsPerDay} optional model calls are used up. Answering people is unaffected.`,
      retryAfterMs: minutes(60),
    };
  }
  if (facts.sessionsToday >= policy.maxSessionsPerDay) {
    return {
      allowed: false,
      state: 'SPENT',
      message: `That is all ${policy.maxSessionsPerDay} of today's sessions.`,
      retryAfterMs: minutes(60),
    };
  }

  if (facts.lastSessionEndedAt) {
    const since = now.getTime() - new Date(facts.lastSessionEndedAt).getTime();
    const cooldown = minutes(policy.cooldownMinutes);
    if (since < cooldown) {
      const left = Math.round((cooldown - since) / 60_000);
      return {
        allowed: false,
        state: 'RESTING',
        message: `Resting between sessions. ${left} ${left === 1 ? 'minute' : 'minutes'} to go.`,
        retryAfterMs: cooldown - since,
      };
    }
  }

  return { allowed: true, state: 'OPEN', message: 'Clear to go looking.', retryAfterMs: null };
}

/**
 * Whether one more of something may be spent inside an open session.
 *
 * Separate from the window above because the answer changes during a session
 * and the caller is a different place: the window decides whether to start,
 * this decides whether to keep going.
 */
export function maySpend(
  policy: GrowthPolicy,
  facts: GrowthFacts,
  what: 'model' | 'research',
): { allowed: boolean; message: string } {
  if (what === 'research') {
    if (facts.researchThisSession >= policy.maxResearchPerSession) {
      return { allowed: false, message: `This session has looked up its ${policy.maxResearchPerSession} things.` };
    }
    if (facts.researchToday >= policy.maxResearchPerDay) {
      return { allowed: false, message: `Today's ${policy.maxResearchPerDay} optional lookups are used up.` };
    }
    return { allowed: true, message: 'Within the lookup budget.' };
  }
  if (facts.modelCallsThisSession >= policy.maxModelCallsPerSession) {
    return { allowed: false, message: `This session has used its ${policy.maxModelCallsPerSession} model calls.` };
  }
  if (facts.modelCallsToday >= policy.maxModelCallsPerDay) {
    return { allowed: false, message: `Today's ${policy.maxModelCallsPerDay} optional model calls are used up.` };
  }
  return { allowed: true, message: 'Within the model budget.' };
}
