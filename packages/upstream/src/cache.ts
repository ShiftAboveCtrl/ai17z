/**
 * Not asking twice for something already known, or already being asked.
 *
 * Two separate savings that are easy to confuse:
 *
 *   **caching** answers a question that was asked recently with the answer from
 *   then, and says how old it is;
 *   **coalescing** answers a question that is being asked *right now* by joining
 *   the request already in the air rather than starting a second one.
 *
 * The second matters more than it looks. Four agents waking together and each
 * wanting the same block height is four requests where one would do, and no
 * cache helps because none of them has finished yet. That is the shape of this
 * system: work arrives in bursts on a poll.
 *
 * ### Freshness belongs to the upstream
 *
 * How long an answer stays good is a property of the thing being asked, not of
 * the asking, so it comes off the upstream. A chain's head is stale in seconds
 * and a contract's ABI is not stale in a week; one number for both would be
 * wrong twice.
 *
 * ### A stale answer is never quietly served
 *
 * Past its freshness an entry is not used at all. It is not served with a
 * warning, and it is not served because the upstream is down -- an old number
 * presented as current is worse than no number, and this codebase already
 * refuses that in the analytics path. Absent is not zero, and stale is not
 * fresh.
 */

interface Entry {
  value: unknown;
  fetchedAt: number;
}

const ENTRIES = new Map<string, Entry>();
const IN_FLIGHT = new Map<string, Promise<unknown>>();

/**
 * The most entries kept before the oldest are dropped.
 *
 * A bound rather than a sweep, because this lives in a worker that runs for
 * weeks: an unbounded map of every question ever asked is a slow leak that only
 * shows up on somebody's machine after a fortnight.
 */
const MAX_ENTRIES = 5_000;

export interface Cached<T> {
  value: T;
  fetchedAt: number;
  ageMs: number;
}

/** A fresh answer, or nothing. Never a stale one. */
export function lookup<T>(key: string, freshMs: number, now = Date.now()): Cached<T> | null {
  const entry = ENTRIES.get(key);
  if (!entry) return null;
  const ageMs = now - entry.fetchedAt;
  if (ageMs > freshMs) {
    // Dropped rather than left to be found again by the next caller, so a dead
    // key stops occupying the bound.
    ENTRIES.delete(key);
    return null;
  }
  return { value: entry.value as T, fetchedAt: entry.fetchedAt, ageMs };
}

export function remember(key: string, value: unknown, fetchedAt = Date.now()): void {
  if (ENTRIES.size >= MAX_ENTRIES) {
    // Insertion order: the oldest key is the first one the iterator yields.
    const oldest = ENTRIES.keys().next();
    if (!oldest.done) ENTRIES.delete(oldest.value);
  }
  ENTRIES.set(key, { value, fetchedAt });
}

/**
 * Runs `start`, or joins the identical request already running.
 *
 * The entry is removed as soon as the promise settles, so a failure is not
 * remembered as an in-flight request for ever. Every joiner sees the same
 * outcome, including the same failure -- which is right: they asked the same
 * question at the same moment and there is one true answer to it.
 */
export async function coalesce<T>(key: string, start: () => Promise<T>): Promise<{ value: T; joined: boolean }> {
  const running = IN_FLIGHT.get(key);
  if (running) return { value: (await running) as T, joined: true };

  const promise = start();
  IN_FLIGHT.set(key, promise as Promise<unknown>);
  try {
    return { value: await promise, joined: false };
  } finally {
    IN_FLIGHT.delete(key);
  }
}

/** How many are being asked right now. For diagnostics, not for decisions. */
export function inFlightCount(): number {
  return IN_FLIGHT.size;
}

/** Only for tests, and for a worker that has just started. */
export function resetCacheForTest(): void {
  ENTRIES.clear();
  IN_FLIGHT.clear();
}
