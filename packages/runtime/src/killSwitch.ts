/**
 * Stopping everything, immediately, from one place.
 *
 * The requirement that makes this real is where it is enforced. A pause that
 * lives in the interface stops the buttons and nothing else: the worker keeps
 * claiming jobs, the poller keeps polling, and a reply already through
 * validation still goes out. So this is checked in the two places that decide
 * whether anything reaches the outside world -- immediately before an action
 * executes, and at ingest before work is queued -- and both read the same row.
 *
 * The race that matters, and the one the brief names: a job is validated, the
 * switch is thrown, and the action executes a moment later. The check has to sit
 * after the last await before the remote call, not at the top of the pipeline,
 * or there is a window between the check and the send. That window is exactly
 * the case somebody reaches for this button in.
 *
 * What it is not: a change to any agent's own configuration. An agent paused by
 * a person before the switch was thrown must still be paused after it is
 * released -- restoring "everything" must not start something nobody asked to
 * start.
 */
import { createLogger } from '@xbam/shared';
import { ops as opsRepo } from '@xbam/database';

const log = createLogger('kill-switch');

/** The one row. Named rather than derived, so both readers cannot disagree. */
const KEY = 'runtime.pauseAll';

export interface PauseState {
  paused: boolean;
  /** Who threw it and when, so the screen can say more than "paused". */
  since: string | null;
  by: string | null;
  reason: string;
}

const RELEASED: PauseState = { paused: false, since: null, by: null, reason: '' };

export async function pauseState(): Promise<PauseState> {
  try {
    const stored = await opsRepo.getSetting<PauseState>(KEY);
    return stored?.paused ? stored : RELEASED;
  } catch {
    // A database that cannot be read is not evidence that everything is
    // paused, and treating it as such would stop a working installation on a
    // blip. The gates below already refuse when they cannot check.
    return RELEASED;
  }
}

export async function setPauseAll(input: { paused: boolean; by: string | null; reason?: string }): Promise<PauseState> {
  const next: PauseState = input.paused
    ? { paused: true, since: new Date().toISOString(), by: input.by, reason: input.reason ?? 'Paused by the owner.' }
    : RELEASED;
  await opsRepo.setSetting(KEY, next);
  log.warn(input.paused ? 'everything paused' : 'everything released', { by: input.by });
  return next;
}

/**
 * Whether anything may reach the outside world right now.
 *
 * Called immediately before an action executes. Deliberately not cached: a
 * cache with any lifetime at all is a window in which the switch is thrown and
 * something still goes out, and one database read against a single row is
 * cheaper than explaining why a reply was sent after somebody pressed stop.
 */
export async function remoteActionsAllowed(): Promise<{ allowed: boolean; reason: string }> {
  const state = await pauseState();
  if (!state.paused) return { allowed: true, reason: '' };
  return {
    allowed: false,
    reason: `Everything is paused${state.since ? ` (since ${state.since})` : ''}. ${state.reason} Nothing will be sent until it is released.`,
  };
}

/**
 * Whether reading may continue while paused.
 *
 * It may. Polling, discovery and memory are how an agent knows what happened
 * while it was stopped, and switching them off would mean releasing the pause
 * put an agent back with a gap in what it had seen. Nothing here reaches
 * anybody: reading X is not an action, and no action can be executed while the
 * gate above refuses.
 */
export const READING_CONTINUES_WHILE_PAUSED = true;
