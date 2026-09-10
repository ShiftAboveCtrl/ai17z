import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ask,
  defineUpstream,
  familyHealth,
  familyMembers,
  healthOf,
  listFamilies,
  registerUpstream,
  resetBreakerForTest,
  resetCacheForTest,
  resetLimiterForTest,
  resetUpstreamsForTest,
} from '@xbam/upstream';

/**
 * The runtime underneath Toolspace: asking an outside service politely, once,
 * and being able to say afterwards where the answer came from.
 *
 * Everything here is about the wrapper rather than about any particular
 * service, which is why none of it touches a network. An upstream implements
 * `fetch` and nothing else; the pacing, the caching, the coalescing, the
 * breaker, the falling back to a sibling and the provenance all happen around
 * it. If that were optional, an upstream author would eventually opt out by
 * accident, and the first anyone would know is a rate-limit complaint from
 * somebody's endpoint operator.
 */

interface Query {
  of: string;
}

/** An upstream that counts its calls and does whatever it is told to. */
function fake(options: {
  id: string;
  family?: string;
  rank?: number;
  answer?: string;
  fail?: string;
  delayMs?: number;
  freshMs?: number;
  perSecond?: number;
  concurrent?: number;
  secret?: { key: string; why: string; required: boolean };
}) {
  const calls: { query: Query; secret?: string }[] = [];
  const upstream = defineUpstream<Query, string>({
    id: options.id,
    family: options.family ?? options.id.split('.')[0]!,
    name: options.id,
    description: 'A test upstream.',
    origin: `${options.id}.example`,
    limit: { perSecond: options.perSecond ?? 1000, concurrent: options.concurrent ?? 100 },
    timeoutMs: 1_000,
    freshMs: options.freshMs ?? 60_000,
    rank: options.rank ?? 1,
    ...(options.secret ? { secret: options.secret } : {}),
    cacheKey: (query) => query.of,
    async fetch(query, ctx) {
      calls.push({ query, ...(ctx.secret ? { secret: ctx.secret } : {}) });
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (options.fail) throw new Error(options.fail);
      return options.answer ?? `${options.id} says so`;
    },
  });
  return { upstream, calls };
}

beforeEach(() => {
  resetUpstreamsForTest();
  resetBreakerForTest();
  resetCacheForTest();
  resetLimiterForTest();
});
afterEach(() => resetUpstreamsForTest());

describe('what may be registered', () => {
  it('refuses an id that does not name a family', () => {
    const { upstream } = fake({ id: 'lonely' });
    expect(() => registerUpstream({ ...upstream, id: 'lonely', family: 'lonely' })).toThrow(/family\.name/);
  });

  it('refuses an id and a family that disagree', () => {
    // Fallback reads the family. Two ways of saying which one an upstream is in
    // would eventually differ, and the one nobody reads is the one that decides.
    const { upstream } = fake({ id: 'evm.ankr' });
    expect(() => registerUpstream({ ...upstream, family: 'markets' })).toThrow(/cannot disagree/);
  });

  it('refuses an upstream that declares no limit', () => {
    // An unpaced upstream is one nothing protects, and the whole point of this
    // layer is asking for less than an endpoint allows.
    const { upstream } = fake({ id: 'evm.ankr' });
    expect(() => registerUpstream({ ...upstream, limit: { perSecond: 0, concurrent: 1 } })).toThrow(/positive/);
    expect(() => registerUpstream({ ...upstream, limit: { perSecond: 1, concurrent: 0 } })).toThrow(/positive/);
  });

  it('refuses a second implementation of one id', () => {
    const first = fake({ id: 'evm.ankr' });
    const second = fake({ id: 'evm.ankr' });
    registerUpstream(first.upstream);
    expect(() => registerUpstream(second.upstream)).toThrow(/already registered/);
    // The same object twice is a module loaded twice, which is not a mistake.
    expect(() => registerUpstream(first.upstream)).not.toThrow();
  });

  it('orders a family by rank, and breaks ties on id so it is stable', () => {
    registerUpstream(fake({ id: 'evm.zeta', rank: 2 }).upstream);
    registerUpstream(fake({ id: 'evm.alpha', rank: 2 }).upstream);
    registerUpstream(fake({ id: 'evm.first', rank: 1 }).upstream);
    expect(familyMembers('evm').map((u) => u.id)).toEqual(['evm.first', 'evm.alpha', 'evm.zeta']);
    expect(listFamilies()).toEqual(['evm']);
  });
});

describe('an answer that says where it came from', () => {
  it('carries the upstream, the host and the moment', async () => {
    registerUpstream(fake({ id: 'evm.ankr' }).upstream);
    const answer = await ask<Query, string>('evm', { of: 'height' });
    expect(answer.value).toBe('evm.ankr says so');
    expect(answer.provenance.upstreamId).toBe('evm.ankr');
    expect(answer.provenance.origin).toBe('evm.ankr.example');
    expect(answer.provenance.source).toBe('LIVE');
    expect(answer.provenance.fellBackFrom).toEqual([]);
    expect(Date.parse(answer.provenance.fetchedAt)).not.toBeNaN();
  });

  it('says an answer was remembered, and how old it is', async () => {
    const first = fake({ id: 'evm.ankr' });
    registerUpstream(first.upstream);
    await ask<Query, string>('evm', { of: 'height' });
    const again = await ask<Query, string>('evm', { of: 'height' });

    expect(first.calls).toHaveLength(1);
    expect(again.provenance.source).toBe('CACHED');
    expect(again.provenance.ageMs).toBeGreaterThanOrEqual(0);
  });

  it('names what it fell back from, so a limping family does not look healthy', async () => {
    registerUpstream(fake({ id: 'evm.broken', rank: 1, fail: 'connection refused' }).upstream);
    registerUpstream(fake({ id: 'evm.working', rank: 2 }).upstream);

    const answer = await ask<Query, string>('evm', { of: 'height' });
    expect(answer.value).toBe('evm.working says so');
    expect(answer.provenance.upstreamId).toBe('evm.working');
    expect(answer.provenance.fellBackFrom).toEqual(['evm.broken']);
  });
});

describe('a question already being asked', () => {
  it('joins the request in the air rather than starting a second', async () => {
    // The shape of this system: work arrives in bursts on a poll, so several
    // agents want the same thing at the same moment and no cache helps because
    // none of them has finished yet.
    const source = fake({ id: 'evm.ankr', delayMs: 20 });
    registerUpstream(source.upstream);

    const answers = await Promise.all([
      ask<Query, string>('evm', { of: 'height' }),
      ask<Query, string>('evm', { of: 'height' }),
      ask<Query, string>('evm', { of: 'height' }),
      ask<Query, string>('evm', { of: 'height' }),
    ]);

    expect(source.calls).toHaveLength(1);
    expect(answers.every((a) => a.value === 'evm.ankr says so')).toBe(true);
    expect(answers.filter((a) => a.provenance.source === 'COALESCED')).toHaveLength(3);
    expect(answers.filter((a) => a.provenance.source === 'LIVE')).toHaveLength(1);
  });

  it('does not join two different questions', async () => {
    const source = fake({ id: 'evm.ankr', delayMs: 10 });
    registerUpstream(source.upstream);
    await Promise.all([ask<Query, string>('evm', { of: 'a' }), ask<Query, string>('evm', { of: 'b' })]);
    expect(source.calls.map((c) => c.query.of).sort()).toEqual(['a', 'b']);
  });
});

describe('knowing when to stop asking', () => {
  it('leaves an upstream alone after three failures in a row', async () => {
    const broken = fake({ id: 'evm.broken', rank: 1, fail: 'connection refused' });
    registerUpstream(broken.upstream);
    registerUpstream(fake({ id: 'evm.working', rank: 2 }).upstream);

    for (let i = 0; i < 3; i += 1) await ask<Query, string>('evm', { of: `q${i}` });
    expect(broken.calls).toHaveLength(3);
    expect(healthOf('evm.broken').state).toBe('COOLING_OFF');

    // The fourth question does not spend a timeout finding out what is already
    // known: it goes straight past.
    const answer = await ask<Query, string>('evm', { of: 'q4' });
    expect(broken.calls).toHaveLength(3);
    expect(answer.provenance.upstreamId).toBe('evm.working');
    expect(answer.provenance.fellBackFrom).toEqual(['evm.broken']);
  });

  it('clears the count on one success and nothing else', async () => {
    const flaky = fake({ id: 'evm.flaky', fail: 'timeout' });
    registerUpstream(flaky.upstream);
    await ask<Query, string>('evm', { of: 'a' }).catch(() => undefined);
    await ask<Query, string>('evm', { of: 'b' }).catch(() => undefined);
    expect(healthOf('evm.flaky').failures).toBe(2);

    resetUpstreamsForTest();
    registerUpstream(fake({ id: 'evm.flaky' }).upstream);
    await ask<Query, string>('evm', { of: 'c' });
    expect(healthOf('evm.flaky').failures).toBe(0);
    expect(healthOf('evm.flaky').state).toBe('READY');
  });

  it('says what could not answer, rather than only that nothing could', async () => {
    registerUpstream(fake({ id: 'evm.one', rank: 1, fail: 'connection refused' }).upstream);
    registerUpstream(fake({ id: 'evm.two', rank: 2, fail: '503' }).upstream);

    await expect(ask<Query, string>('evm', { of: 'height' })).rejects.toThrow(
      /evm\.one \(connection refused\).*evm\.two \(503\)/,
    );
  });

  it('is a permanent failure when nothing is registered for the family at all', async () => {
    // Different from everything being down: no amount of retrying registers an
    // upstream, and a retryable error would spin for ever on a typo.
    await expect(ask<Query, string>('nobody', { of: 'x' })).rejects.toThrow(/Nothing is registered/);
  });
});

describe('an upstream nobody has given a key to', () => {
  const needsKey = { key: 'ANKR_KEY', why: 'Higher rate limits.', required: true };

  it('is skipped without being counted as broken', async () => {
    // It is not failing. Counting it as failing would cool off a service that
    // has never once been asked.
    const gated = fake({ id: 'evm.ankr', rank: 1, secret: needsKey });
    registerUpstream(gated.upstream);
    registerUpstream(fake({ id: 'evm.free', rank: 2 }).upstream);

    const answer = await ask<Query, string>('evm', { of: 'height' }, { secretFor: async () => undefined });
    expect(gated.calls).toHaveLength(0);
    expect(answer.provenance.upstreamId).toBe('evm.free');
    expect(healthOf('evm.ankr').failures).toBe(0);
    expect(healthOf('evm.ankr').state).toBe('READY');
  });

  it('is used, and handed the key, once one is stored', async () => {
    const gated = fake({ id: 'evm.ankr', rank: 1, secret: needsKey });
    registerUpstream(gated.upstream);
    const answer = await ask<Query, string>('evm', { of: 'height' }, { secretFor: async () => 'sk-live-value' });
    expect(gated.calls[0]?.secret).toBe('sk-live-value');
    expect(answer.provenance.upstreamId).toBe('evm.ankr');
  });

  it('never puts the key in the answer, the provenance or a log line', async () => {
    const logged: string[] = [];
    registerUpstream(fake({ id: 'evm.ankr', secret: needsKey }).upstream);
    const answer = await ask<Query, string>(
      'evm',
      { of: 'height' },
      {
        secretFor: async () => 'sk-must-never-travel',
        log: (message, data) => logged.push(`${message} ${JSON.stringify(data ?? {})}`),
      },
    );
    expect(JSON.stringify(answer)).not.toContain('sk-must-never-travel');
    expect(logged.join(' ')).not.toContain('sk-must-never-travel');
  });

  it('reports needing a key as its own state, not as a failure', async () => {
    registerUpstream(fake({ id: 'evm.ankr', secret: needsKey }).upstream);
    const [entry] = await familyHealth('evm', { secretFor: async () => undefined });
    expect(entry!.health.state).toBe('NEEDS_SECRET');
    expect(entry!.health.why).toMatch(/ANKR_KEY/);
    expect(entry!.health.failures).toBe(0);
  });
});

describe('asking for less than an endpoint allows', () => {
  it('paces requests to the declared rate', async () => {
    vi.useFakeTimers();
    try {
      // Four different questions, so nothing is cached or coalesced, at five a
      // second: the fourth cannot start before 600ms have passed.
      const source = fake({ id: 'evm.ankr', perSecond: 5 });
      registerUpstream(source.upstream);

      const all = Promise.all(
        ['a', 'b', 'c', 'd'].map((of) => ask<Query, string>('evm', { of })),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(source.calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(200);
      expect(source.calls).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(400);
      expect(source.calls).toHaveLength(4);
      await all;
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps one budget for an upstream however many agents are asking', async () => {
    // The budget belongs to the endpoint, not to the caller. Two agents reading
    // one chain are two callers of one service, and a per-agent limiter would
    // let the second double what its operator sees.
    vi.useFakeTimers();
    try {
      const source = fake({ id: 'evm.ankr', perSecond: 2 });
      registerUpstream(source.upstream);
      const all = Promise.all([
        ask<Query, string>('evm', { of: 'agent-one' }),
        ask<Query, string>('evm', { of: 'agent-two' }),
      ]);
      await vi.advanceTimersByTimeAsync(0);
      expect(source.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(500);
      expect(source.calls).toHaveLength(2);
      await all;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a remembered answer', () => {
  it('is not served once it is past its freshness', async () => {
    // Stale is not fresh, and an old number presented as current is worse than
    // no number. It is not served with a warning either.
    const source = fake({ id: 'evm.ankr', freshMs: 50 });
    registerUpstream(source.upstream);

    await ask<Query, string>('evm', { of: 'height' });
    const fresh = await ask<Query, string>('evm', { of: 'height' }, { now: Date.now() + 10 });
    expect(fresh.provenance.source).toBe('CACHED');
    expect(source.calls).toHaveLength(1);

    const stale = await ask<Query, string>('evm', { of: 'height' }, { now: Date.now() + 5_000 });
    expect(stale.provenance.source).toBe('LIVE');
    expect(source.calls).toHaveLength(2);
  });

  it('is not shared between two upstreams in one family', async () => {
    // They are interchangeable to a caller, but rank exists because somebody
    // decided one is better. Serving the worse one's answer when the better one
    // would have been asked spends that decision without saying so.
    const one = fake({ id: 'evm.one', rank: 1 });
    const two = fake({ id: 'evm.two', rank: 2 });
    registerUpstream(two.upstream);
    await ask<Query, string>('evm', { of: 'height' });
    expect(two.calls).toHaveLength(1);

    registerUpstream(one.upstream);
    const answer = await ask<Query, string>('evm', { of: 'height' });
    expect(answer.provenance.upstreamId).toBe('evm.one');
    expect(one.calls).toHaveLength(1);
  });
});
