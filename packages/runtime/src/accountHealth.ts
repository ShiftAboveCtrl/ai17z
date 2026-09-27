import type { AccountHealth } from '@xbam/database';
import type { AccountStatus, CapacityCadence, CapacityClass } from '@xbam/shared/contracts';

/**
 * How the runtime is coping, which is not whether the session is signed in.
 *
 * `accounts.status` already answers the second and answers it well: it has
 * CHALLENGE_REQUIRES_USER, SESSION_EXPIRED and NEEDS_AUTH, and AI17Z stops on
 * all three without exception. What it cannot express is "signed in, working,
 * and being told to slow down so often that going looking for strangers is the
 * wrong thing to be doing". That is what health is for, and the two sit beside
 * each other rather than one inside the other so that neither can quietly
 * become the other.
 *
 * The ordering is the design: **optional growth yields first.** Reading what
 * people sent is the last thing to stop, because an agent that stops noticing
 * mentions to protect itself has stopped being an agent. That is the same rule
 * `throttleFor` applies to memory pressure, applied to a different kind of
 * trouble.
 */

/** What the runtime has been seeing lately, all of it already recorded. */
export interface HealthFacts {
  /** The sign-in state, which outranks everything below it. */
  status: AccountStatus;
  /** Writes that failed in the trailing hour. */
  failedWrites: number;
  /** Times the remote asked us to slow down in the trailing hour. */
  rateLimits: number;
  /**
   * Reads where X never drew the page: its logo on a dark screen, a timeline
   * that never arrived. Not the same as a refusal, and not the same as an
   * empty answer either, which is the whole reason it is counted separately.
   */
  stalledReads?: number;
  /** Discovery sources currently failing. */
  failingSources: number;
  /**
   * A write whose outcome could not be established.
   *
   * The most serious thing on this list. A reply that may or may not have gone
   * out must never be retried blindly, and an account holding one stops acting
   * until somebody has looked.
   */
  ambiguousWrites: number;
}

export interface HealthVerdict {
  health: AccountHealth;
  /** A sentence naming what was actually seen, never just the state. */
  reason: string;
  /** How long optional growth is held, when it is. */
  holdMs: number | null;
}

/** Statuses that are the owner's to clear, and that nothing here may soften. */
const NEEDS_A_PERSON: readonly AccountStatus[] = [
  'CHALLENGE_REQUIRES_USER',
  'SESSION_EXPIRED',
  'NEEDS_AUTH',
  'TIMEOUT',
];

const minutes = (n: number) => n * 60_000;

/**
 * Where the account stands, from what has already been recorded.
 *
 * Pure. Everything it reads is a count somebody else wrote down, so this can
 * be held to in a test without a browser, an account or a remote service, and
 * the thresholds are visible rather than buried in the code that reacts to
 * them.
 */
export function judgeHealth(facts: HealthFacts): HealthVerdict {
  if (NEEDS_A_PERSON.includes(facts.status)) {
    return {
      health: 'HUMAN_ACTION_REQUIRED',
      reason:
        facts.status === 'CHALLENGE_REQUIRES_USER'
          ? 'X is asking for something only you can give it. AI17Z never answers one of these.'
          : `This account is ${facts.status.toLowerCase().replace(/_/g, ' ')} and needs you to sign in again.`,
      holdMs: null,
    };
  }

  /*
    An ambiguous write is its own category and sits above the counting.

    One reply that may or may not have been published is worse than twenty that
    plainly failed, because the failures are safe to retry and this one is not.
    Nothing resumes until the exact target has been verified.
  */
  if (facts.ambiguousWrites > 0) {
    return {
      health: 'HUMAN_ACTION_REQUIRED',
      reason:
        `${facts.ambiguousWrites} ${facts.ambiguousWrites === 1 ? 'action' : 'actions'} finished without AI17Z being ` +
        'able to tell whether they went out. Nothing will be retried until that is checked, because retrying one of ' +
        'these is how the same thing gets posted twice.',
      holdMs: null,
    };
  }

  /*
    Thresholds chosen for an account that has to keep working tomorrow.

    These used to be ten rate limits an hour for a cooldown and three to slow
    down, and nothing ever evaluated them, so the numbers were never tested
    against X. Measured on a live account once they were: X began refusing
    two search surfaces at about six page loads a minute, and every further
    request in that state is one more reason for X to keep refusing. One
    explicit "slow down" is therefore already worth slowing down for, and a
    third in the hour is a cooldown.
  */
  const stalled = facts.stalledReads ?? 0;
  if (facts.rateLimits >= 3 || facts.failedWrites >= 5 || stalled >= 4) {
    return {
      health: 'COOLDOWN',
      reason:
        facts.rateLimits >= 3
          ? `X asked this account to slow down ${facts.rateLimits} times in the last hour, so it has stopped going looking for people.`
          : facts.failedWrites >= 5
            ? `${facts.failedWrites} actions failed in the last hour, so it has stopped going looking for people.`
            : `X failed to draw its pages ${stalled} times in the last hour, so this account is resting before it asks again.`,
      holdMs: minutes(60),
    };
  }

  if (facts.rateLimits >= 1 || facts.failedWrites >= 2 || facts.failingSources >= 2 || stalled >= 2) {
    return {
      health: 'DEGRADED',
      reason:
        facts.rateLimits >= 1
          ? `X asked this account to slow down ${facts.rateLimits === 1 ? 'once' : `${facts.rateLimits} times`} recently, so it is reading less and not going looking for people.`
          : stalled >= 2
            ? `X did not finish drawing ${stalled} pages recently, so this account is reading less until it does.`
            : facts.failingSources >= 2 && facts.failedWrites < 2
              ? `${facts.failingSources} discovery sources are failing, so optional growth is paused while that settles.`
              : 'This account is hitting trouble often enough that it has paused going looking for people.',
      holdMs: minutes(15),
    };
  }

  return { health: 'HEALTHY', reason: 'Working normally.', holdMs: null };
}

/**
 * Whether an action of this kind may proceed at this health.
 *
 * Reading is never gated here. A degraded account still notices that somebody
 * wrote to it, still resolves the thread, and still answers; what it stops is
 * speaking to people who did not ask.
 */
export function mayAct(health: AccountHealth, kind: 'READ' | 'REPLY' | 'GROWTH'): boolean {
  if (kind === 'READ') return health !== 'HUMAN_ACTION_REQUIRED';
  if (kind === 'REPLY') return health === 'HEALTHY' || health === 'DEGRADED';
  return health === 'HEALTHY';
}

// The breaker: what judgeHealth says, held long enough to matter.

/** Where an account's breaker stands, as stored. */
export interface CapacityState {
  health: AccountHealth;
  reason: string | null;
  until: Date | null;
  /** Cooldowns in a row without a clean recovery between them. */
  strikes: number;
}

/** What has happened since the breaker last moved. */
export interface CapacitySince {
  status: AccountStatus;
  rateLimits: number;
  stalled: number;
  /** Pages X answered with its own error page. See BROKEN_AS_PRESSURE. */
  broken?: number;
  failedWrites: number;
  failingSources: number;
  /** How long the breaker has been where it is, for forgiving old strikes. */
  quietForMs?: number | null;
}

/**
 * How many of X's own error pages it takes before they are pressure on the account.
 *
 * One is a page X could not draw, and the source that asked backs off on its
 * own. Measured on a live account: counting every one as account pushback
 * meant a single "something went wrong" on a search, arriving about every two
 * hours, re-tripped a cooldown during every recovery, so the account spent a
 * day cooling down and its strikes only ever climbed. Several at once, across
 * the account's pages, is X saying "not now" and is treated as such.
 */
export const BROKEN_AS_PRESSURE = 3;

/**
 * How long an account must go without trouble before old strikes are forgotten.
 *
 * Strikes make the next cooldown longer. Without a way to forget them, one bad
 * evening decides how an account is treated for days after it recovered.
 */
export const STRIKES_FORGIVEN_AFTER_MS = 6 * 60 * 60_000;

/** How long a cooldown lasts after this many trips in a row. Doubles, and stops doubling. */
export function cooldownMsFor(strikes: number, config: CapacityCadence): number {
  const doubled = config.cooldownMinutes * 2 ** Math.max(0, strikes - 1);
  return minutes(Math.min(doubled, config.maxCooldownMinutes));
}

/**
 * The next state of an account's breaker.
 *
 * `judgeHealth` says what is wrong now and deliberately latches nothing. That
 * is right for a verdict and wrong for a breaker: a cooldown that ends the
 * moment the counts it came from age out is a cooldown that lasts however
 * long the counting window happens to be, and it ends at full speed. This is
 * the half that holds.
 *
 * - A trip opens a cooldown that doubles each time it recurs, to a ceiling.
 * - A cooldown ends in recovery, never straight in health: the account reads
 *   at a reduced budget for as long again, and broad growth waits for the end
 *   of that.
 * - Any pushback during recovery or early pressure trips again, which is what
 *   "repeated degradation means a longer cooldown" amounts to.
 * - A clean recovery forgives one strike. Nothing is forgiven faster than it
 *   was earned.
 *
 * Pure. The counts it is given are counts since the breaker last moved, which
 * is what stops a finished cooldown tripping on the signals that caused it.
 */
export function settleCapacity(
  prev: CapacityState,
  since: CapacitySince,
  config: CapacityCadence,
  now: Date,
): CapacityState {
  const broken = since.broken ?? 0;
  const stalled = since.stalled + (broken >= BROKEN_AS_PRESSURE ? broken : 0);
  const snapshot = judgeHealth({
    status: since.status,
    failedWrites: since.failedWrites,
    rateLimits: since.rateLimits,
    failingSources: since.failingSources,
    ambiguousWrites: 0,
    stalledReads: stalled,
  });

  if (snapshot.health === 'HUMAN_ACTION_REQUIRED') {
    return { health: 'HUMAN_ACTION_REQUIRED', reason: snapshot.reason, until: null, strikes: prev.strikes };
  }

  const pushback = since.rateLimits + stalled;
  const trip = (why: string): CapacityState => {
    const strikes = prev.strikes + 1;
    return { health: 'COOLDOWN', reason: why, until: new Date(now.getTime() + cooldownMsFor(strikes, config)), strikes };
  };

  // A person fixed whatever needed them. Come back gently, not at full speed.
  if (prev.health === 'HUMAN_ACTION_REQUIRED') {
    return {
      health: 'DEGRADED',
      reason: 'Recovering after the account needed you. Reading resumes slowly before anything optional does.',
      until: new Date(now.getTime() + minutes(config.cooldownMinutes)),
      strikes: prev.strikes,
    };
  }

  if (prev.health === 'COOLDOWN') {
    if (prev.until && now < prev.until) return prev;
    // Recovery lasts as long as the cooldown did.
    return {
      health: 'DEGRADED',
      reason:
        'Recovering from a cooldown. Reading resumes at a reduced rate, and going looking for people waits until this is over.',
      until: new Date(now.getTime() + cooldownMsFor(Math.max(1, prev.strikes), config)),
      strikes: prev.strikes,
    };
  }

  if (prev.health === 'DEGRADED') {
    // Anything at all since slowing down means slowing down was not enough.
    if (pushback > 0 || snapshot.health === 'COOLDOWN') {
      return trip(
        snapshot.health === 'HEALTHY' ? 'X pushed back again while this account was already reading less.' : snapshot.reason,
      );
    }
    if (prev.until && now < prev.until) return prev;
    // Discovery sources still failing for their own reasons keep it slowed,
    // but never trip it: a source X cannot show is not X asking for less.
    if (snapshot.health === 'DEGRADED') {
      return { ...prev, reason: snapshot.reason, until: new Date(now.getTime() + minutes(5)) };
    }
    return { health: 'HEALTHY', reason: null, until: null, strikes: Math.max(0, prev.strikes - 1) };
  }

  // HEALTHY
  if (snapshot.health === 'COOLDOWN') return trip(snapshot.reason);
  if (snapshot.health === 'DEGRADED') {
    return {
      health: 'DEGRADED',
      reason: snapshot.reason,
      until: new Date(now.getTime() + (snapshot.holdMs ?? minutes(15))),
      strikes: prev.strikes,
    };
  }
  // Healthy and quiet long enough: the strikes from a bad evening are over.
  if (prev.strikes > 0 && pushback === 0 && (since.quietForMs ?? 0) >= STRIKES_FORGIVEN_AFTER_MS) {
    return { health: 'HEALTHY', reason: null, until: null, strikes: 0 };
  }
  return prev.reason === null && prev.until === null ? prev : { ...prev, reason: null, until: null };
}

/** How much of the ten-minute budget the whole account may use at this health. */
const BUDGET_AT: Record<AccountHealth, number> = {
  HEALTHY: 1,
  DEGRADED: 0.6,
  COOLDOWN: 0.35,
  HUMAN_ACTION_REQUIRED: 0,
};

export interface CapacityVerdict {
  allowed: boolean;
  /** A sentence. Shown on the source, the job and the owner's panel. */
  message: string;
  retryAfterMs: number | null;
}

/**
 * Whether one more read of X may happen now, for this class.
 *
 * The shares are the protection. Broad growth may use only the first part of
 * the budget, a watched account a larger part, and somebody who wrote to the
 * agent all of it. So when the account is busy, looking for strangers is what
 * waits, and when it is in trouble, only what people sent is still read.
 */
export function readAllowance(input: {
  state: CapacityState;
  klass: CapacityClass;
  readsLast10Minutes: number;
  /**
   * What each class has spent of those. A class is capped on its own spending
   * as well as on the account's total, because a cap on the total alone means
   * broad looking runs only when the account is otherwise idle: measured on a
   * live account, direct and watched reads came to 27 of 36 by themselves and
   * the agent's own search was never allowed to run once.
   */
  readsByClass?: Partial<Record<CapacityClass, number>>;
  config: CapacityCadence;
  now: Date;
  /**
   * The read is the thread of a reply to somebody who wrote in. It is counted
   * like any other, and it never waits behind polling: a person is waiting
   * for this one, and on a live installation it waited a minute at a time
   * behind the account's own monitors.
   */
  forReply?: boolean;
}): CapacityVerdict {
  const { state, klass, config, now } = input;
  if (input.forReply && klass === 'DIRECT' && state.health !== 'HUMAN_ACTION_REQUIRED') {
    return { allowed: true, message: 'A reply to somebody who wrote in.', retryAfterMs: null };
  }
  const until = state.until && state.until > now ? state.until.getTime() - now.getTime() : null;

  if (state.health === 'HUMAN_ACTION_REQUIRED') {
    return {
      allowed: false,
      message: state.reason ?? 'This account needs you before it reads anything.',
      retryAfterMs: null,
    };
  }
  if (state.health === 'COOLDOWN' && klass !== 'DIRECT') {
    return {
      allowed: false,
      message: `Cooling down: ${state.reason ?? 'X pushed back.'} Only what people send this account is being read.`,
      retryAfterMs: until ?? minutes(5),
    };
  }

  const budget = Math.max(1, Math.floor(config.readsPer10Minutes * BUDGET_AT[state.health]));
  const recovering = state.health === 'HEALTHY' ? '' : ' while it recovers';
  // Broad work waits longer, so it never races direct work for the slot a
  // read ageing out frees up.
  const wait = klass === 'BROAD' ? minutes(3) : minutes(1);

  if (klass === 'DIRECT') {
    if (input.readsLast10Minutes >= budget) {
      return {
        allowed: false,
        message: `This account has made ${input.readsLast10Minutes} reads of X in ten minutes, its whole budget${recovering}.`,
        retryAfterMs: wait,
      };
    }
    return { allowed: true, message: 'Within budget.', retryAfterMs: null };
  }

  const who = klass === 'TARGET' ? 'Checking watched accounts' : 'Going looking';
  const open = Math.max(1, Math.floor(budget * (1 - config.directReserve)));
  if (input.readsLast10Minutes >= open) {
    return {
      allowed: false,
      message:
        `This account has made ${input.readsLast10Minutes} reads of X in ten minutes${recovering}. ` +
        `${who} waits so the last ${budget - open} of ${budget} stay free for people who wrote in.`,
      retryAfterMs: wait,
    };
  }
  const own = input.readsByClass?.[klass] ?? 0;
  const cap = Math.max(1, Math.floor(budget * (klass === 'TARGET' ? config.targetShare : config.broadShare)));
  if (own >= cap) {
    return {
      allowed: false,
      message: `${who} has used ${own} of its ${cap} reads in ten minutes${recovering}.`,
      retryAfterMs: wait,
    };
  }
  return { allowed: true, message: 'Within budget.', retryAfterMs: null };
}

/**
 * Whether a public action of this class may start now.
 *
 * Nothing already under way is stopped by this: a write being verified is
 * checked by the executor that started it. What waits is the next one.
 */
export function writeAllowance(state: CapacityState, klass: CapacityClass, now: Date): CapacityVerdict {
  const until = state.until && state.until > now ? state.until.getTime() - now.getTime() : null;
  if (state.health === 'HUMAN_ACTION_REQUIRED') {
    return { allowed: false, message: state.reason ?? 'This account needs you before it acts.', retryAfterMs: null };
  }
  /*
    A reply to somebody who wrote in is not held by a cooldown.

    It used to be, and on a live installation that held an answer to a person
    for sixty-seven minutes while the account cooled down from X refusing its
    searches. X's pushback was about reading, the reply is one write, and the
    account's own spacing and ceilings still apply to it. What waits is
    everything the agent would have started on its own.
  */
  if (state.health === 'COOLDOWN' && klass !== 'DIRECT') {
    return {
      allowed: false,
      message: `Waiting out a cooldown before acting: ${state.reason ?? 'X pushed back.'}`,
      retryAfterMs: until ?? minutes(5),
    };
  }
  if (state.health === 'DEGRADED' && klass === 'BROAD') {
    return {
      allowed: false,
      message: `Not approaching anybody new while the account is reading less: ${state.reason ?? 'X pushed back recently.'}`,
      retryAfterMs: until ?? minutes(10),
    };
  }
  return { allowed: true, message: 'Clear to act.', retryAfterMs: null };
}
