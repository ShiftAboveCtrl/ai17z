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
    megabytesPerThirtySeconds: 100,
  };

  it('stays under every published limit it can reach', async () => {
    const { registerSolanaUpstreams, listUpstreams, resetUpstreamsForTest } = await import('@xbam/upstream');
    resetUpstreamsForTest();
    registerSolanaUpstreams();
    const solana = listUpstreams().find((upstream) => upstream.family === 'solana_mainnet')!;
    const { windows, concurrentPerProcess } = solana.limit;

    const perSecondWindow = windows.find((w) => w.intervalMs === 1_000);
    const perMinuteWindow = windows.find((w) => w.intervalMs === 60_000);
    const methodWindow = windows.find((w) => w.per !== undefined);

    // Named before they are used, so deleting one produces a sentence rather
    // than "cannot read properties of undefined" twelve lines later.
    expect(perSecondWindow, 'Solana has no per-second window').toBeDefined();
    expect(perMinuteWindow, 'Solana has no per-minute window').toBeDefined();
    expect(
      methodWindow,
      'Solana has no per-method window: 5/s is 50 in ten seconds against a published 40 for one RPC',
    ).toBeDefined();

    // Requests in any ten seconds: the tighter of the two untargeted windows.
    const inTenSeconds = Math.min(perSecondWindow!.capacity * 10, perMinuteWindow!.capacity);
    expect(inTenSeconds).toBeLessThanOrEqual(PUBLISHED.requestsPerTenSeconds);

    // Per method: this is the one that was over before the window existed --
    // five a second is fifty in ten seconds against a published forty.
    expect(methodWindow!.intervalMs).toBe(10_000);
    expect(methodWindow!.capacity).toBeLessThanOrEqual(PUBLISHED.perMethodPerTenSeconds);

    // Bytes in any thirty seconds. The minute window caps the request count, so
    // the byte ceiling is derived from it rather than chosen for comfort.
    const requestsInThirtySeconds = Math.min(perSecondWindow!.capacity * 30, perMinuteWindow!.capacity);
    const maxBytesPerRequest = 256_000;
    const worstCaseMegabytes = (requestsInThirtySeconds * maxBytesPerRequest) / 1e6;
    expect(worstCaseMegabytes).toBeLessThan(PUBLISHED.megabytesPerThirtySeconds);

    /**
     * Concurrency is not coordinated across processes, and does not need to be.
     *
     * The published cap is per address, which no single process can see. Rather
     * than building leases for it, the arithmetic is pinned: two in flight per
     * process, two processes per installation, is four per installation -- so
     * the machine cap is not reached until ten installations ask Solana at
     * once. If that stops being comfortably true, this test fails and the
     * answer is machine-scoped leases rather than a larger number here.
     */
    const processesPerInstallation = 2; // the api and the worker both call ask()
    const installationsBeforeBreaching =
      PUBLISHED.concurrentConnections / (concurrentPerProcess * processesPerInstallation);
    expect(installationsBeforeBreaching).toBeGreaterThanOrEqual(10);
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
