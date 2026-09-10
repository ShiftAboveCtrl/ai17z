import type { UpstreamLimit } from './contract';

/**
 * Asking an endpoint for less than it allows.
 *
 * The budget belongs to the **upstream**, not to the agent asking. Two agents
 * on one installation reading the same chain are two callers of one endpoint,
 * and a per-agent limiter would let a second agent double the traffic the
 * operator sees while both stayed politely inside their own allowance.
 *
 * Two constraints rather than one, because they answer different questions.
 * A rate says how often a request may start; a concurrency says how many may be
 * in the air. An endpoint that allows ten a second and one connection is a real
 * shape, and a limiter that knows only the rate opens ten sockets to a service
 * that wanted one.
 *
 * ### What this is not
 *
 * This is politeness and resilience, and only that. Nothing here rotates an
 * identity, spreads load across origins to look like several callers, or treats
 * a refusal as something to be got around. Being asked to slow down is a signal
 * to slow down. If an upstream says no, the answer is to ask it less, and the
 * breaker beside this decides when to stop asking altogether.
 *
 * ### The boundary, said plainly
 *
 * In-process. Every upstream call in AI17Z is made by the worker, which is one
 * process, so one process is where the budget lives -- the same reasoning that
 * puts `openOnce` in memory while the account lease is in the database. Two
 * workers running against one installation would each keep their own budget and
 * the endpoint would see twice what either believes it is sending. That is a
 * real limit of this design rather than an oversight, and the day a second
 * caller exists this has to move to the database.
 */

interface Bucket {
  /** When a request may next start, as a timestamp. */
  nextFreeAt: number;
  /** How many are in the air. */
  active: number;
  /** Callers waiting for a slot, in arrival order. */
  queue: (() => void)[];
}

const BUCKETS = new Map<string, Bucket>();

function bucketFor(id: string): Bucket {
  let bucket = BUCKETS.get(id);
  if (!bucket) {
    bucket = { nextFreeAt: 0, active: 0, queue: [] };
    BUCKETS.set(id, bucket);
  }
  return bucket;
}

/** How long until this upstream would let another request start. */
export function waitFor(id: string, limit: UpstreamLimit, now = Date.now()): number {
  const bucket = bucketFor(id);
  if (bucket.active >= limit.concurrent) return Number.POSITIVE_INFINITY;
  return Math.max(0, bucket.nextFreeAt - now);
}

/**
 * Waits for a slot, then hands back the release.
 *
 * The release must be called however the request ends, which is why the only
 * caller is `ask` and it is in a `finally`. A leaked slot is an upstream that
 * quietly stops being asked at all -- the worst kind of failure here, because
 * everything keeps working and one source silently drops out.
 */
export async function acquire(id: string, limit: UpstreamLimit): Promise<() => void> {
  const bucket = bucketFor(id);

  while (bucket.active >= limit.concurrent) {
    await new Promise<void>((resolve) => bucket.queue.push(resolve));
  }
  bucket.active += 1;

  const spacingMs = 1000 / limit.perSecond;
  const now = Date.now();
  const startAt = Math.max(now, bucket.nextFreeAt);
  // Claimed before waiting, so several callers arriving together space
  // themselves out instead of all reading the same free moment.
  bucket.nextFreeAt = startAt + spacingMs;
  if (startAt > now) await new Promise((resolve) => setTimeout(resolve, startAt - now));

  let released = false;
  return () => {
    if (released) return;
    released = true;
    bucket.active -= 1;
    bucket.queue.shift()?.();
  };
}

/** Only for tests, and for a worker that has just started. */
export function resetLimiterForTest(): void {
  BUCKETS.clear();
}
