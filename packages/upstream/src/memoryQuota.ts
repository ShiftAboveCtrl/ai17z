import type { QuotaCoordinator, QuotaWindow } from './quota';

/**
 * A coordinator that knows only about this process.
 *
 * The default, and the one every unit test uses. It is correct for a single
 * process and honest about being nothing more: two processes each holding one
 * of these each believe they have the whole budget, which is exactly the
 * arithmetic that lets an installation with a container worker and a native
 * worker show an endpoint twice what it published.
 *
 * Production supplies a coordinator that shares state. This one stays because a
 * test that needs a real database to prove a scheduler paces requests is a test
 * nobody runs.
 *
 * ### Sliding, not fixed
 *
 * A fixed window lets twice the capacity through across a boundary: spend the
 * whole minute's budget in its last second, and the whole of the next minute's
 * in its first. Timestamps are kept and counted against the trailing interval
 * instead, which costs an array per window and removes the burst.
 */
export class InMemoryQuotaCoordinator implements QuotaCoordinator {
  /** Spend timestamps per window, keyed by budget and interval. */
  private readonly spent = new Map<string, { at: number; weight: number }[]>();
  private readonly blocked = new Map<string, { until: number; why: string }>();

  private windowKey(key: string, window: QuotaWindow): string {
    return `${key}|${window.scope}|${window.intervalMs}`;
  }

  private used(windowKey: string, intervalMs: number, now: number): number {
    const entries = this.spent.get(windowKey);
    if (!entries) return 0;
    const cutoff = now - intervalMs;
    // Trimmed on read: the alternative is a sweep, and a sweep in a worker that
    // runs for weeks is a timer nobody remembers to stop.
    while (entries.length > 0 && entries[0]!.at <= cutoff) entries.shift();
    return entries.reduce((total, entry) => total + entry.weight, 0);
  }

  async reserve(input: {
    key: string;
    windows: QuotaWindow[];
    weight: number;
    now: number;
  }): Promise<{ granted: true } | { granted: false; retryAfterMs: number; window: string }> {
    const blocked = this.blocked.get(input.key);
    if (blocked && blocked.until > input.now) {
      return { granted: false, retryAfterMs: blocked.until - input.now, window: blocked.why };
    }

    // Every window is checked before any is spent. Spending the per-second
    // budget on the way to discovering the daily one is full turns a busy hour
    // into a day's allowance of refusals.
    for (const window of input.windows) {
      const windowKey = this.windowKey(input.key, window);
      const used = this.used(windowKey, window.intervalMs, input.now);
      if (used + input.weight > window.capacity) {
        const entries = this.spent.get(windowKey) ?? [];
        const oldest = entries[0]?.at ?? input.now;
        return {
          granted: false,
          retryAfterMs: Math.max(1, oldest + window.intervalMs - input.now),
          window: window.label,
        };
      }
    }

    for (const window of input.windows) {
      const windowKey = this.windowKey(input.key, window);
      const entries = this.spent.get(windowKey) ?? [];
      entries.push({ at: input.now, weight: input.weight });
      this.spent.set(windowKey, entries);
    }
    return { granted: true };
  }

  async blockUntil(input: { key: string; until: number; why: string }): Promise<void> {
    const existing = this.blocked.get(input.key);
    // The later of the two. A second 429 arriving while the first is still in
    // force must not shorten it.
    if (existing && existing.until >= input.until) return;
    this.blocked.set(input.key, { until: input.until, why: input.why });
  }

  async blockedFor(input: { key: string; now: number }): Promise<number> {
    const blocked = this.blocked.get(input.key);
    if (!blocked || blocked.until <= input.now) return 0;
    return blocked.until - input.now;
  }

  /** Only for tests, and for a process that has just started. */
  reset(): void {
    this.spent.clear();
    this.blocked.clear();
  }
}
