import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ask,
  classifyStatus,
  countsAgainstHealth,
  currentQuotaCoordinator,
  healthOf,
  perDay,
  perMinute,
  perSecond,
  quotaKey,
  registerUpstream,
  resetBreakerForTest,
  resetCacheForTest,
  resetLimiterForTest,
  resetUpstreamsForTest,
  retryAfterMs,
  worthTryingSibling,
} from '@xbam/upstream';
import { fakeUpstream, type FakeQuery } from '../support/fakeUpstream';

/**
 * The unpleasant answers, proved against a fake rather than somebody's endpoint.
 *
 * Every family added from here needs these, and deliberately making a real
 * public service rate-limit or fail is both rude and unreliable. The live proof
 * that a service answers at all is a separate, tiny thing.
 *
 * What matters here is that a rate limit is not treated as an ordinary failure.
 * It is the operator naming a time: the breaker must not cool off a healthy
 * endpoint for being popular, and everything sharing that budget -- including
 * the other worker -- has to hear about it.
 */

beforeEach(() => {
  resetUpstreamsForTest();
  resetBreakerForTest();
  resetCacheForTest();
  resetLimiterForTest();
});
afterEach(() => resetUpstreamsForTest());

describe('reading what an upstream answered', () => {
  it('tells the kinds apart, because they need different answers', () => {
    expect(classifyStatus(200)).toBeNull();
    expect(classifyStatus(429)?.kind).toBe('RATE_LIMITED');
    expect(classifyStatus(401)?.kind).toBe('UNAUTHORIZED');
    expect(classifyStatus(403)?.kind).toBe('UNAUTHORIZED');
    expect(classifyStatus(404)?.kind).toBe('NOT_FOUND');
    expect(classifyStatus(405)?.kind).toBe('UNSUPPORTED');
    expect(classifyStatus(500)?.kind).toBe('UPSTREAM_5XX');
    expect(classifyStatus(502)?.kind).toBe('UPSTREAM_5XX');
    expect(classifyStatus(504)?.kind).toBe('TIMEOUT');
    expect(classifyStatus(418)?.kind).toBe('BAD_RESPONSE');
  });

  it('reads a 503 that names a time as the rate limit it is', () => {
    // Some services shed load with a 503 and a Retry-After, which is a rate
    // limit wearing a different number. Treating it as a server fault would
    // cool the endpoint off instead of waiting the time it asked for.
    const headers = new Headers({ 'retry-after': '30' });
    expect(classifyStatus(503, headers)?.kind).toBe('RATE_LIMITED');
    expect(classifyStatus(503)?.kind).toBe('UPSTREAM_5XX');
  });

  it('understands Retry-After in seconds and as a date', () => {
    const now = Date.parse('2026-09-10T12:00:00Z');
    expect(retryAfterMs('30', now)).toBe(30_000);
    expect(retryAfterMs('  45  ', now)).toBe(45_000);
    expect(retryAfterMs('Thu, 10 Sep 2026 12:01:00 GMT', now)).toBe(60_000);
    // A date already past is nothing to wait for, not a negative wait.
    expect(retryAfterMs('Thu, 10 Sep 2026 11:59:00 GMT', now)).toBe(0);
    expect(retryAfterMs(null, now)).toBeNull();
    expect(retryAfterMs('soon', now)).toBeNull();
  });

  it('refuses to be told to wait for a month', () => {
    // Past a day the header is likelier wrong -- a gateway misconfigured, a year
    // typed wrongly -- than an operator genuinely asking to be left alone until
    // October, and an upstream silently disabled for a fortnight looks exactly
    // like a bug in AI17Z.
    const now = Date.parse('2026-09-10T12:00:00Z');
    expect(retryAfterMs('9999999', now)).toBe(86_400_000);
    expect(retryAfterMs('Fri, 10 Oct 2026 12:00:00 GMT', now)).toBe(86_400_000);
  });

  it('knows which failures are about the question rather than the answerer', () => {
    // Walking the whole family to be told "no such thing" four times spends four
    // budgets to learn nothing.
    expect(worthTryingSibling('NOT_FOUND')).toBe(false);
    expect(worthTryingSibling('UNSUPPORTED')).toBe(false);
    expect(worthTryingSibling('CANCELLED')).toBe(false);
    expect(worthTryingSibling('UPSTREAM_5XX')).toBe(true);
    expect(worthTryingSibling('RATE_LIMITED')).toBe(true);
  });

  it('does not count a rate limit against an upstream’s health', () => {
    // Being popular is not being broken.
    expect(countsAgainstHealth('RATE_LIMITED')).toBe(false);
    expect(countsAgainstHealth('NOT_FOUND')).toBe(false);
    expect(countsAgainstHealth('UPSTREAM_5XX')).toBe(true);
    expect(countsAgainstHealth('BAD_RESPONSE')).toBe(true);
  });
});

describe('an upstream that says slow down', () => {
  it('waits the time it asked for instead of cooling it off', async () => {
    const limited = fakeUpstream({
      id: 'fam.limited',
      rank: 1,
      behaviour: { answers: [{ kind: 'status', status: 429, retryAfter: '60' }] },
    });
    const other = fakeUpstream({ id: 'fam.other', rank: 2 });
    registerUpstream(limited.upstream);
    registerUpstream(other.upstream);

    const answer = await ask<FakeQuery, string>('fam', { of: 'a' });

    // The sibling answered, and the provenance says so rather than hiding it.
    expect(answer.provenance.upstreamId).toBe('fam.other');
    expect(answer.provenance.fellBackFrom).toEqual(['fam.limited']);
    // Not cooling off: it is healthy, it is just busy.
    expect(healthOf('fam.limited').state).toBe('READY');
    expect(healthOf('fam.limited').failures).toBe(0);
  });

  it('tells everything sharing that budget, not just this caller', async () => {
    // The point of a shared coordinator. The other worker must not carry on
    // into a limit that has just been announced.
    const limited = fakeUpstream({
      id: 'fam.limited',
      origin: 'limited.example',
      behaviour: { answers: [{ kind: 'status', status: 429, retryAfter: '60' }] },
    });
    registerUpstream(limited.upstream);
    await ask<FakeQuery, string>('fam', { of: 'a' }).catch(() => undefined);

    const blocked = await currentQuotaCoordinator().blockedFor({
      key: quotaKey({ upstreamId: 'fam.limited', origin: 'limited.example', scope: 'MACHINE' }),
      now: Date.now(),
    });
    expect(blocked).toBeGreaterThan(50_000);
  });

  it('does not ask again while the time it named is still running', async () => {
    const limited = fakeUpstream({
      id: 'fam.limited',
      behaviour: { answers: [{ kind: 'status', status: 429, retryAfter: '60' }] },
    });
    registerUpstream(limited.upstream);

    await ask<FakeQuery, string>('fam', { of: 'a' }).catch(() => undefined);
    expect(limited.calls).toHaveLength(1);

    await ask<FakeQuery, string>('fam', { of: 'b' }).catch(() => undefined);
    // Not asked a second time: the answer to "may I" came from what it already
    // told us, without spending a request to be refused again.
    expect(limited.calls).toHaveLength(1);
  });
});

describe('an upstream that is simply failing', () => {
  it('cools off after repeated 500s, unlike a rate limit', async () => {
    const broken = fakeUpstream({
      id: 'fam.broken',
      behaviour: { answers: [{ kind: 'status', status: 500 }] },
    });
    registerUpstream(broken.upstream);

    for (const of of ['a', 'b', 'c']) await ask<FakeQuery, string>('fam', { of }).catch(() => undefined);
    expect(healthOf('fam.broken').state).toBe('COOLING_OFF');
    expect(healthOf('fam.broken').failures).toBe(3);
  });

  it('gives up on one that never answers, and says it timed out', async () => {
    const slow = fakeUpstream({ id: 'fam.slow', timeoutMs: 60, behaviour: { delayMs: 5_000 } });
    registerUpstream(slow.upstream);
    await expect(ask<FakeQuery, string>('fam', { of: 'a' })).rejects.toThrow(/TIMEOUT/);
  });

  it('calls a malformed body a bad response, not a network problem', async () => {
    const garbled = fakeUpstream({ id: 'fam.garbled', behaviour: { answers: [{ kind: 'malformed' }] } });
    registerUpstream(garbled.upstream);
    await expect(ask<FakeQuery, string>('fam', { of: 'a' })).rejects.toThrow(/BAD_RESPONSE/);
  });

  it('stops at a question nobody can answer rather than asking everybody', async () => {
    const first = fakeUpstream({ id: 'fam.first', rank: 1, behaviour: { answers: [{ kind: 'status', status: 404 }] } });
    const second = fakeUpstream({ id: 'fam.second', rank: 2 });
    registerUpstream(first.upstream);
    registerUpstream(second.upstream);

    await expect(ask<FakeQuery, string>('fam', { of: 'a' })).rejects.toThrow(/NOT_FOUND/);
    // The sibling was never asked: it does not have it either.
    expect(second.calls).toHaveLength(0);
  });
});

describe('budgets of every shape', () => {
  it('honours a per-minute cap that a per-second one would miss', async () => {
    const capped = fakeUpstream({
      id: 'fam.capped',
      windows: [perSecond(100, { scope: 'MACHINE' }), perMinute(3, { scope: 'MACHINE' })],
    });
    registerUpstream(capped.upstream);

    for (const of of ['a', 'b', 'c']) await ask<FakeQuery, string>('fam', { of });
    expect(capped.calls).toHaveLength(3);

    await expect(ask<FakeQuery, string>('fam', { of: 'd' })).rejects.toThrow(/minute/);
    expect(capped.calls).toHaveLength(3);
  });

  it('honours a daily cap', async () => {
    const capped = fakeUpstream({
      id: 'fam.daily',
      windows: [perSecond(100, { scope: 'MACHINE' }), perDay(2, { scope: 'MACHINE' })],
    });
    registerUpstream(capped.upstream);

    await ask<FakeQuery, string>('fam', { of: 'a' });
    await ask<FakeQuery, string>('fam', { of: 'b' });
    await expect(ask<FakeQuery, string>('fam', { of: 'c' })).rejects.toThrow(/day/);
    expect(capped.calls).toHaveLength(2);
  });

  it('charges a weighted request what it actually costs', async () => {
    // A compute-unit endpoint charges more for some methods. A scheduler that
    // counts requests cannot pace those, and the adapter must not be the one
    // keeping that arithmetic.
    const weighted = fakeUpstream({
      id: 'fam.weighted',
      windows: [perMinute(10, { scope: 'MACHINE' })],
      weigh: (query) => (query as FakeQuery).costs ?? 1,
    });
    registerUpstream(weighted.upstream);

    await ask<FakeQuery, string>('fam', { of: 'a', costs: 6 });
    await ask<FakeQuery, string>('fam', { of: 'b', costs: 3 });
    expect(weighted.calls).toHaveLength(2);

    // Nine of ten spent; a request costing four does not fit.
    await expect(ask<FakeQuery, string>('fam', { of: 'c', costs: 4 })).rejects.toThrow(/minute/);
    // One costing one still does.
    await ask<FakeQuery, string>('fam', { of: 'd', costs: 1 });
    expect(weighted.calls).toHaveLength(3);
  });

  it('lets only one request at a time through a strict upstream', async () => {
    const single = fakeUpstream({ id: 'fam.single', concurrentPerProcess: 1, behaviour: { delayMs: 40 } });
    registerUpstream(single.upstream);

    let inFlight = 0;
    let highest = 0;
    const watched = {
      ...single.upstream,
      async fetch(query: FakeQuery, ctx: Parameters<typeof single.upstream.fetch>[1]) {
        inFlight += 1;
        highest = Math.max(highest, inFlight);
        try {
          return await single.upstream.fetch(query, ctx);
        } finally {
          inFlight -= 1;
        }
      },
    };
    resetUpstreamsForTest();
    registerUpstream(watched);

    await Promise.all(['a', 'b', 'c'].map((of) => ask<FakeQuery, string>('fam', { of })));
    expect(highest).toBe(1);
  });
});
