import type { AccountHealth } from '@xbam/database';
import type { AccountStatus } from '@xbam/shared/contracts';

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

  if (facts.rateLimits >= 10 || facts.failedWrites >= 5) {
    return {
      health: 'COOLDOWN',
      reason:
        facts.rateLimits >= 10
          ? `X asked this account to slow down ${facts.rateLimits} times in the last hour, so it has stopped going looking for people.`
          : `${facts.failedWrites} actions failed in the last hour, so it has stopped going looking for people.`,
      holdMs: minutes(60),
    };
  }

  if (facts.rateLimits >= 3 || facts.failedWrites >= 2 || facts.failingSources >= 2) {
    return {
      health: 'DEGRADED',
      reason:
        facts.failingSources >= 2 && facts.rateLimits < 3 && facts.failedWrites < 2
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
