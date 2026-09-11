import { beforeEach, describe, expect, it } from 'vitest';
import {
  InMemoryQuotaCoordinator,
  perMinute,
  perSecond,
  perTenSeconds,
  quotaKey,
  resetLimiterForTest,
  takeSlot,
  useQuotaCoordinator,
  type UpstreamLimit,
} from '@xbam/upstream';

/**
 * Budgets that are keyed more finely than "this endpoint".
 *
 * Several operators publish two limits at once: an overall rate, and a tighter
 * one for any single method. Solana's public RPC is the live case -- 100
 * requests per ten seconds per address, and only 40 of any one RPC. An adapter
 * that respects the overall rate can spend the whole of it on `getBalance`,
 * break the published per-method limit, and believe itself polite throughout.
 *
 * The discriminator is central rather than a timer inside an adapter, because a
 * private timer is exactly what this package exists to remove.
 */

const OVERALL = 100;
const PER_METHOD = 40;

/** An upstream with both budgets, shaped like the one that needs them. */
const limit: UpstreamLimit = {
  // High, so the concurrency gauge never interferes with what is being tested.
  concurrentPerProcess: 1_000,
  windows: [
    perTenSeconds(OVERALL, { scope: 'MACHINE', source: 'PUBLISHED' }),
    {
      ...perTenSeconds(PER_METHOD, { scope: 'MACHINE', source: 'PUBLISHED' }),
      per: (query) => (query as { method?: string }).method ?? null,
    },
  ],
};

/** Takes one slot and lets it go, so only the rate budgets are exercised. */
async function ask(method: string): Promise<boolean> {
  const outcome = await takeSlot({
    upstreamId: 'thing.one',
    origin: 'example.test',
    limit,
    query: { method },
    now: Date.now(),
  });
  if (outcome.granted) outcome.slot.release();
  return outcome.granted;
}

async function askMany(method: string, times: number): Promise<number> {
  let granted = 0;
  for (let i = 0; i < times; i += 1) if (await ask(method)) granted += 1;
  return granted;
}

beforeEach(() => {
  resetLimiterForTest();
  useQuotaCoordinator(new InMemoryQuotaCoordinator());
});

describe('a budget counted per method', () => {
  it('stops one method at its own limit while the overall budget still has room', async () => {
    // Forty of the same RPC is all that method may have.
    expect(await askMany('getBalance', PER_METHOD)).toBe(PER_METHOD);
    // The forty-first is refused -- and only sixty of the overall hundred have
    // been spent, so this is the method budget and nothing else.
    expect(await ask('getBalance')).toBe(false);
  });

  it('gives a different method its own budget', async () => {
    await askMany('getBalance', PER_METHOD);
    expect(await ask('getBalance')).toBe(false);
    // A different RPC has not been asked at all, so it may still be.
    expect(await ask('getSlot')).toBe(true);
  });

  it('still applies the overall budget across methods', async () => {
    // Spread so no single method reaches forty: the overall limit is what
    // must stop this, not the per-method one.
    expect(await askMany('a', 30)).toBe(30);
    expect(await askMany('b', 30)).toBe(30);
    expect(await askMany('c', 30)).toBe(30);
    expect(await askMany('d', 10)).toBe(10);
    // One hundred spent. A method nobody has touched is refused anyway.
    expect(await ask('e')).toBe(false);
  });

  it('keys the two budgets apart rather than colliding', () => {
    const overall = quotaKey({ upstreamId: 'thing.one', origin: 'example.test', scope: 'MACHINE' });
    const method = quotaKey({
      upstreamId: 'thing.one',
      origin: 'example.test',
      scope: 'MACHINE',
      per: 'getBalance',
    });
    expect(method).not.toBe(overall);
    // The method budget lives inside the address it belongs to, so two hosts
    // cannot share one method budget by accident.
    expect(method.startsWith(overall)).toBe(true);
  });
});

describe('what AI17Z allows itself against Solana', () => {
  /**
   * The published figures, from Solana's own documentation, September 2026.
   *
   * The endpoint's response headers advertise more than this -- 250 a second
   * and 150 per method. The documented numbers are stricter, so they are the
   * contract; a header seen once is not.
   */
  const PUBLISHED = {
    requestsPerTenSeconds: 100,
    perMethodPerTenSeconds: 40,
    concurrentConnections: 40,
    newConnectionsPerTenSeconds: 40,
    megabytesPerThirtySeconds: 100,
  };

  it('stays under every published limit, for any number of installations', async () => {
    const { registerSolanaUpstreams, listUpstreams, resetUpstreamsForTest } = await import('@xbam/upstream');
    resetUpstreamsForTest();
    registerSolanaUpstreams();
    const solana = listUpstreams().find((upstream) => upstream.family === 'solana_mainnet')!;
    const { windows } = solana.limit;

    /**
     * Trailing windows, so a span can straddle boundaries.
     *
     * `capacity * ceil(span / interval)` is the honest ceiling for a sliding
     * window, and using the fixed-window figure would understate it.
     */
    const maxIn = (capacity: number, interval: number, span: number) => capacity * Math.ceil(span / interval);

    /** The tightest thing every machine-scoped window allows over a span. */
    const grantsIn = (span: number) =>
      Math.min(
        ...windows
          .filter((w) => w.per === undefined)
          .map((w) => maxIn(w.capacity, w.intervalMs, span)),
      );

    const TEN_SECONDS = 10_000;
    const THIRTY_SECONDS = 30_000;

    // Requests per ten seconds, against the published hundred.
    expect(grantsIn(TEN_SECONDS)).toBeLessThanOrEqual(PUBLISHED.requestsPerTenSeconds);

    /**
     * New connections per ten seconds, against the published forty.
     *
     * `safeFetch` builds one undici Agent per call and closes it, so there is
     * no keep-alive and **every request opens a connection**. The connection
     * rate is therefore exactly the request rate -- not something smaller that
     * pooling would have given. At five a second this was fifty against forty.
     */
    expect(grantsIn(TEN_SECONDS)).toBeLessThanOrEqual(PUBLISHED.newConnectionsPerTenSeconds);

    /**
     * Concurrent connections, against the published forty.
     *
     * Proved without counting installations, which was the wrong proof: AI17Z
     * supports side-by-side installations and publishes no maximum, so "it
     * takes ten of them" showed headroom rather than impossibility.
     *
     * A request begins only after a grant from a MACHINE-scoped window that
     * every AI17Z on this machine shares, and ends within `timeoutMs`. So the
     * connections open at any instant are a subset of the grants in a trailing
     * span of that length -- whatever the number of processes or installations.
     */
    const concurrentCeiling = grantsIn(solana.timeoutMs);
    expect(concurrentCeiling).toBeLessThan(PUBLISHED.concurrentConnections);

    // Per method, against the published forty. This is the one that was being
    // broken before a discriminator existed.
    const methodWindow = windows.find((w) => w.per !== undefined);
    expect(
      methodWindow,
      'Solana has no per-method window: an overall rate can be spent entirely on one RPC',
    ).toBeDefined();
    expect(maxIn(methodWindow!.capacity, methodWindow!.intervalMs, TEN_SECONDS)).toBeLessThanOrEqual(
      PUBLISHED.perMethodPerTenSeconds,
    );

    /**
     * Bytes per thirty seconds, against the published hundred megabytes.
     *
     * Asserted twice on purpose. Against our own windows, which is what
     * actually applies; and against **their** published request ceiling, which
     * is the claim that survives somebody later relaxing ours.
     */
    const maxBytesPerRequest = 256_000;
    expect((grantsIn(THIRTY_SECONDS) * maxBytesPerRequest) / 1e6).toBeLessThan(
      PUBLISHED.megabytesPerThirtySeconds,
    );
    const atTheirCeiling = maxIn(PUBLISHED.requestsPerTenSeconds, TEN_SECONDS, THIRTY_SECONDS);
    expect(atTheirCeiling).toBe(300);
    expect((atTheirCeiling * maxBytesPerRequest) / 1e6).toBeLessThan(PUBLISHED.megabytesPerThirtySeconds);

    // And the response cap is load-bearing rather than decorative: a megabyte
    // each would breach the byte limit at their own request ceiling.
    expect((atTheirCeiling * 1_000_000) / 1e6).toBeGreaterThan(PUBLISHED.megabytesPerThirtySeconds);
  });
});

describe('a caller that gives up while waiting for room', () => {
  /** One in flight at a time, so the second caller has to wait. */
  const narrow: UpstreamLimit = {
    concurrentPerProcess: 1,
    windows: [perMinute(1_000, { scope: 'MACHINE' })],
  };

  const take = (signal?: AbortSignal) =>
    takeSlot({
      upstreamId: 'narrow.one',
      origin: 'narrow.test',
      limit: narrow,
      query: {},
      now: Date.now(),
      ...(signal ? { signal } : {}),
    });

  it('stops waiting, and leaves the room for somebody who wants it', async () => {
    const first = await take();
    expect(first.granted).toBe(true);

    // A second caller queues behind it, then gives up.
    const controller = new AbortController();
    const waiting = take(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    const outcome = await waiting;
    expect(outcome.granted).toBe(false);
    if (!outcome.granted) expect(outcome.why).toMatch(/gave up/i);

    // The abandoned waiter is gone rather than queued: releasing the slot must
    // hand it to a live caller, not spend it waking somebody who has left.
    if (first.granted) first.slot.release();
    const third = await take();
    expect(third.granted).toBe(true);
    if (third.granted) third.slot.release();
  });

  it('does not queue at all when the caller has already gone', async () => {
    const first = await take();
    const controller = new AbortController();
    controller.abort();

    const outcome = await take(controller.signal);
    expect(outcome.granted).toBe(false);

    // And the capacity is intact: releasing the one in flight makes room.
    if (first.granted) first.slot.release();
    const next = await take();
    expect(next.granted).toBe(true);
    if (next.granted) next.slot.release();
  });

  it('leaks nothing when several callers give up together', async () => {
    const held = await take();
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const waiters = controllers.map((controller) => take(controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const controller of controllers) controller.abort();
    for (const outcome of await Promise.all(waiters)) expect(outcome.granted).toBe(false);

    if (held.granted) held.slot.release();
    // One slot, and it is available: none of the three took it on the way out.
    const after = await take();
    expect(after.granted).toBe(true);
    if (after.granted) after.slot.release();
  });
});

describe('a budget with no discriminator', () => {
  it('behaves exactly as it did before the idea existed', async () => {
    const plain: UpstreamLimit = {
      concurrentPerProcess: 1_000,
      windows: [perSecond(3, { scope: 'MACHINE' }), perMinute(5, { scope: 'MACHINE' })],
    };
    const take = async () => {
      const outcome = await takeSlot({
        upstreamId: 'plain.one',
        origin: 'plain.test',
        limit: plain,
        query: { method: 'whatever' },
        now: Date.now(),
      });
      if (outcome.granted) outcome.slot.release();
      return outcome.granted;
    };
    // The minute window binds at five regardless of which method is asked.
    let granted = 0;
    for (let i = 0; i < 8; i += 1) if (await take()) granted += 1;
    expect(granted).toBe(5);
  });
});
