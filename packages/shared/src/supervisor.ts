/**
 * When to restart something that died, and when to stop trying.
 *
 * The native worker is the only process that can drive a browser, and it was
 * started with nothing watching it. If it died, an agent simply stopped: no
 * restart, and until health learned about workers, no sign either.
 *
 * Restarting is the easy half. The half that matters is not restarting for
 * ever: a worker that cannot start -- a bad DATABASE_URL, a port already taken,
 * a missing binary -- fails in a second, and a supervisor that answers that with
 * another attempt every second produces thousands of identical failures, an
 * unreadable log, and no clearer picture than one failure would have given. So
 * a run that ends almost immediately counts against a budget, and running for a
 * while clears it, because that is the difference between "cannot start" and
 * "was working and then something happened".
 *
 * Pure, so the policy can be exercised without spawning anything.
 */

/** A run that ended. */
export interface RunOutcome {
  /** How long it ran before exiting, in milliseconds. */
  ranForMs: number;
  /** Exit code, or null when it was killed by a signal. */
  code: number | null;
}

export interface RestartPolicy {
  /**
   * Under this, the process did not really start.
   *
   * Ten seconds is comfortably longer than a configuration failure takes to
   * surface and far shorter than any useful run.
   */
  tooQuickMs: number;
  /** How many too-quick runs in a row before giving up. */
  maxQuickFailures: number;
  /** First backoff, doubling each consecutive quick failure. */
  baseDelayMs: number;
  /** Ceiling on that backoff. */
  maxDelayMs: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  tooQuickMs: 10_000,
  maxQuickFailures: 5,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
};

export interface RestartDecision {
  restart: boolean;
  /** How long to wait first. Zero for an immediate restart. */
  delayMs: number;
  /** What happened and what is being done about it, in a sentence. */
  reason: string;
  /** Consecutive quick failures after this outcome, to carry into the next call. */
  quickFailures: number;
}

/**
 * What to do about a run that has just ended.
 *
 * `quickFailures` is the count carried from the previous decision; pass 0 for
 * the first. A deliberate stop -- exit code 0, or a termination signal -- is not
 * a failure and is never restarted: something asked it to stop.
 */
export function decideRestart(
  outcome: RunOutcome,
  quickFailures: number,
  policy: RestartPolicy = DEFAULT_RESTART_POLICY,
): RestartDecision {
  // Exit 0 means it was asked to stop and did. Restarting would fight whoever
  // asked, and the commonest asker is the stop script.
  if (outcome.code === 0) {
    return { restart: false, delayMs: 0, reason: 'It exited cleanly, so nothing restarted it.', quickFailures: 0 };
  }

  // Killed by a signal: a stop script, a shutdown, or somebody at a keyboard.
  // Same reasoning -- a supervisor that restarts through a deliberate kill is a
  // process nobody can stop.
  if (outcome.code === null) {
    return { restart: false, delayMs: 0, reason: 'It was stopped, so nothing restarted it.', quickFailures: 0 };
  }

  const quick = outcome.ranForMs < policy.tooQuickMs;

  // It ran for a while and then died. That is the case a supervisor exists for,
  // and the budget resets because whatever went wrong was not "cannot start".
  if (!quick) {
    const seconds = Math.round(outcome.ranForMs / 1000);
    return {
      restart: true,
      delayMs: 0,
      reason: `It ran for ${seconds}s and then exited with code ${outcome.code}. Starting it again.`,
      quickFailures: 0,
    };
  }

  const failures = quickFailures + 1;
  if (failures >= policy.maxQuickFailures) {
    return {
      restart: false,
      delayMs: 0,
      reason: `It has failed to start ${failures} times in a row, each within ${Math.round(policy.tooQuickMs / 1000)} seconds. Something is wrong with the configuration rather than with the run; the last error above says what.`,
      quickFailures: failures,
    };
  }

  const delayMs = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (failures - 1));
  return {
    restart: true,
    delayMs,
    reason: `It exited with code ${outcome.code} after ${Math.round(outcome.ranForMs / 1000)}s, which is too quick to have started properly. Attempt ${failures} of ${policy.maxQuickFailures}; waiting ${Math.round(delayMs / 1000)}s.`,
    quickFailures: failures,
  };
}

/**
 * How long after starting before a missing heartbeat means anything.
 *
 * The worker announces itself once before its loop begins, so this only has to
 * cover connecting to the database and bootstrapping. Generous on purpose: a
 * supervisor that kills a worker still starting up is worse than no supervisor.
 */
export const HEARTBEAT_GRACE_MS = 90_000;

/**
 * Whether a running worker has stopped being alive in the way that matters.
 *
 * Exiting is the easy failure. The one that actually happened was quieter: a
 * `setInterval(() => void tick())` with a `try/finally` and no `catch` raised an
 * unhandled rejection, the worker stopped doing anything, and `tsx watch` kept
 * the process up -- so nothing exited, nothing restarted, and the only sign was
 * an agent that had gone quiet. A process being alive is not the same as a
 * worker running, and the heartbeat is the difference.
 *
 * `lastSeenMs` is null when nothing is known, which is not evidence of anything:
 * a database that cannot be reached answers nothing, and killing a worker over
 * an unanswered question is how a blip becomes an outage.
 */
export function heartbeatIsStale(input: {
  ranForMs: number;
  lastSeenMs: number | null;
  presentWithinMs: number;
  graceMs?: number;
}): boolean {
  const grace = input.graceMs ?? HEARTBEAT_GRACE_MS;
  if (input.ranForMs < grace) return false;
  if (input.lastSeenMs === null) return false;
  return input.lastSeenMs > input.presentWithinMs;
}
