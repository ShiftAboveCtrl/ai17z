import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * How long work that nobody is watching may wait for a rate budget to refill.
 *
 * The limiter serves a short wait and refuses a long one, because a person
 * waiting for a page should not sit behind somebody else's budget. That is
 * the right answer for a person and the wrong one for a paper trade running
 * in the background: measured on 2026-10-11, a live agent's buys were refused
 * as NO_MARKET hour after hour because GeckoTerminal's four requests per ten
 * seconds were in use, and a few seconds of waiting would have answered every
 * one. So background work says how patient it is, and only that.
 *
 * Ambient for the reason `callSignal.ts` gives, and kept apart from it rather
 * than added to it: that module is a signal and nothing else, on purpose, and
 * this is a number and nothing else. Clamped, so no caller can ask for less
 * than the default or tie up a worker for minutes.
 */

export const DEFAULT_PATIENCE_MS = 2_000;
export const MAX_PATIENCE_MS = 60_000;

const storage = new AsyncLocalStorage<number>();

/** Runs `work` allowed to wait up to `ms` for each rate budget it meets. */
export function withPatience<T>(ms: number, work: () => T): T {
  return storage.run(Math.max(DEFAULT_PATIENCE_MS, Math.min(MAX_PATIENCE_MS, Math.round(ms))), work);
}

/** How long the work currently running may wait for a budget. */
export function currentPatience(): number {
  return storage.getStore() ?? DEFAULT_PATIENCE_MS;
}
