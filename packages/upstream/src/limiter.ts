import { InMemoryQuotaCoordinator } from './memoryQuota';
import { quotaKey, weightOf, type QuotaCoordinator, type UpstreamLimit } from './quota';

/**
 * Asking an endpoint for less than it allows.
 *
 * Two jobs, and they are different in kind:
 *
 *   **the budgets**, which are counted and refill, and belong to whoever the
 *     endpoint counts -- this installation, or the machine's address. Those go
 *     through a coordinator, because more than one process can be spending them;
 *   **the concurrency**, which is a live gauge of what is in the air right now,
 *     and is per process by construction and by name.
 *
 * ### What this is not
 *
 * Politeness and resilience, and only that. Nothing here rotates an identity,
 * spreads load across origins to look like several callers, or treats a refusal
 * as something to get around. Being asked to slow down is a reason to slow down,
 * which is why a 429 reaches the coordinator as a fact everything sharing that
 * budget can see rather than as a failure for one caller to retry past.
 */

interface Gauge {
  active: number;
  queue: (() => void)[];
}

const GAUGES = new Map<string, Gauge>();

/**
 * The coordinator every call goes through.
 *
 * In memory by default, which is right for a test and wrong for an
 * installation: two processes each holding one believe they each have the whole
 * budget. Production replaces it at startup, once, and `ask` never chooses.
 */
let coordinator: QuotaCoordinator = new InMemoryQuotaCoordinator();

export function useQuotaCoordinator(next: QuotaCoordinator): void {
  coordinator = next;
}

export function currentQuotaCoordinator(): QuotaCoordinator {
  return coordinator;
}

function gaugeFor(id: string): Gauge {
  let gauge = GAUGES.get(id);
  if (!gauge) {
    gauge = { active: 0, queue: [] };
    GAUGES.set(id, gauge);
  }
  return gauge;
}

export interface Slot {
  release(): void;
}

export type SlotOutcome = { granted: true; slot: Slot } | { granted: false; retryAfterMs: number; why: string };

/**
 * The longest this will wait for a budget to refill rather than giving up.
 *
 * Two seconds, which is the line between pacing and hanging. A per-second
 * window refills inside it, so four callers arriving together are spaced out --
 * that is what being a good guest looks like, and failing them instead would
 * make a burst of ordinary work look like an outage. A per-minute, per-hour or
 * per-day window never refills inside it, so an exhausted daily quota is
 * reported immediately and the family tries somebody else, rather than holding
 * a job open until tomorrow.
 */
const MAX_PACING_WAIT_MS = 2_000;

/**
 * Takes a slot for one request, or says why not and for how long.
 *
 * A short wait is served; a long one is refused. The difference matters more
 * than it looks: waiting is the polite response to a rate that is about to
 * refill, and refusing is the only sane response to a budget that refills
 * tomorrow -- and one threshold decides which, in one place, rather than every
 * adapter guessing.
 */
export async function takeSlot(input: {
  upstreamId: string;
  origin: string;
  limit: UpstreamLimit;
  query: unknown;
  now: number;
  /** Lets a caller that has given up stop waiting for room. */
  signal?: AbortSignal;
}): Promise<SlotOutcome> {
  const weight = weightOf(input.limit, input.query);

  /**
   * The budget a window belongs to.
   *
   * Scope decides where it is counted; `per` decides how finely. A window with
   * a discriminator gets its own budget inside that scope, which is how an
   * operator's per-method limit is respected without an adapter keeping its own
   * timer.
   */
  const keyFor = (window: (typeof input.limit.windows)[number]): string =>
    quotaKey({
      upstreamId: input.upstreamId,
      origin: input.origin,
      scope: window.scope,
      per: window.per?.(input.query) ?? null,
    });

  // Checked at the **base** key for each scope, deliberately not at the
  // discriminated one. A 429 is about the endpoint, so `recordRateLimit` writes
  // it against the address rather than against whichever method happened to
  // provoke it -- and a per-method budget that looked for a block under its own
  // key would never find it, which would turn "they told us to wait" into
  // "carry on" for every method-scoped window.
  for (const scope of new Set(input.limit.windows.map((window) => window.scope))) {
    const blockedFor = await coordinator.blockedFor({
      key: quotaKey({ upstreamId: input.upstreamId, origin: input.origin, scope }),
      now: input.now,
    });
    if (blockedFor > 0) {
      return { granted: false, retryAfterMs: blockedFor, why: 'it asked us to wait' };
    }
  }

  // Grouped by budget so one reservation covers every window that shares one,
  // and the all-or-nothing rule inside the coordinator actually holds. Two
  // windows with different discriminators are different budgets and are
  // reserved separately, which is correct: spending the method budget must not
  // be conditional on the overall one and vice versa.
  const byScope = new Map<string, typeof input.limit.windows>();
  for (const window of input.limit.windows) {
    const key = keyFor(window);
    byScope.set(key, [...(byScope.get(key) ?? []), window]);
  }

  for (const [key, windows] of byScope) {
    let waited = 0;
    for (;;) {
      const reservation = await coordinator.reserve({ key, windows, weight, now: Date.now() });
      if (reservation.granted) break;
      // Long enough that it will not refill soon, or long enough that we have
      // already waited our share: report it and let the family try a sibling.
      if (reservation.retryAfterMs > MAX_PACING_WAIT_MS || waited + reservation.retryAfterMs > MAX_PACING_WAIT_MS) {
        return { granted: false, retryAfterMs: reservation.retryAfterMs, why: `its ${reservation.window} budget` };
      }
      await new Promise((resolve) => setTimeout(resolve, reservation.retryAfterMs));
      waited += reservation.retryAfterMs;
    }
  }

  /**
   * Waiting for room, without leaving anything behind if the caller gives up.
   *
   * The queue used to be a bare list of resolvers with no way out: an
   * invocation that timed out while waiting stayed in it, was eventually woken
   * by somebody else's release, took a slot, and only then discovered its
   * signal was aborted. That self-corrected -- the fetch failed immediately and
   * the `finally` released the slot -- but it woke the wrong waiter and made
   * the real one wait another turn.
   *
   * Now a waiter can be removed, and an abort removes it.
   */
  const gauge = gaugeFor(input.upstreamId);
  while (gauge.active >= input.limit.concurrentPerProcess) {
    if (input.signal?.aborted) {
      return { granted: false, retryAfterMs: 0, why: 'the caller gave up before a slot was free' };
    }

    let waiter: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        waiter = resolve;
        gauge.queue.push(resolve);
        input.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    } catch {
      // Taken out of the queue rather than left to be woken later, which would
      // spend a release on a caller that has gone.
      const at = waiter ? gauge.queue.indexOf(waiter) : -1;
      if (at >= 0) gauge.queue.splice(at, 1);
      return { granted: false, retryAfterMs: 0, why: 'the caller gave up while waiting for a slot' };
    }
  }
  gauge.active += 1;

  let released = false;
  return {
    granted: true,
    slot: {
      release() {
        if (released) return;
        released = true;
        gauge.active -= 1;
        gauge.queue.shift()?.();
      },
    },
  };
}

/** Tells everything sharing this budget that the operator named a time. */
export async function recordRateLimit(input: {
  upstreamId: string;
  origin: string;
  limit: UpstreamLimit;
  until: number;
  why: string;
}): Promise<void> {
  const scopes = new Set(input.limit.windows.map((window) => window.scope));
  // Blocked at every scope the upstream declares, because a 429 is about the
  // endpoint rather than about which of our budgets we thought we were
  // spending. An upstream that declares none is still blocked, by origin,
  // which is the scope an address-based refusal actually has.
  if (scopes.size === 0) scopes.add('MACHINE');
  for (const scope of scopes) {
    await coordinator.blockUntil({
      key: quotaKey({ upstreamId: input.upstreamId, origin: input.origin, scope }),
      until: input.until,
      why: input.why,
    });
  }
}

/** Only for tests, and for a process that has just started. */
export function resetLimiterForTest(): void {
  GAUGES.clear();
  coordinator = new InMemoryQuotaCoordinator();
}
