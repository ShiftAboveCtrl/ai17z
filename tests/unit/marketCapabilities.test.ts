import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What a token is trading at, and the ways that answer goes wrong.
 *
 * **By pricing the wrong side of the pair.** The indexer reports
 * `base_token_price_usd`, and for the WETH/USDC pool that is 2467. Asking what
 * USDC is worth and reading "the price" of its deepest pools answers two and a
 * half thousand dollars. The live canary caught this; the unit tests did not
 * exist yet.
 *
 * **By accepting a ticker.** Anyone can mint a token with a given symbol. A
 * symbol is not an identity and is refused, with a refusal that says why.
 *
 * **By quoting a price from a puddle.** A pool with a few hundred dollars in it
 * produces a number, not a market value.
 */

let replies: Record<string, { status?: number; body: string }> = {};
let requested: string[] = [];

vi.mock('undici', () => ({
  Agent: class {
    async close() {}
  },
  async fetch(input: unknown) {
    const url = String(input);
    requested.push(url);
    // Longest match wins. `/networks/eth/tokens/0x.../pools` contains both
    // `/tokens/` and `/pools`, and first-match would answer a pool list with a
    // token -- a fixture bug that looks exactly like the code being wrong.
    const key = Object.keys(replies)
      .filter((candidate) => url.includes(candidate))
      .sort((a, b) => b.length - a.length)[0];
    const reply = key ? replies[key]! : { status: 404, body: '{}' };
    return new Response(reply.body, {
      status: reply.status ?? 200,
      headers: new Headers({ 'content-type': 'application/json' }),
    });
  },
}));

const { registerGeckoUpstreams, resetBreakerForTest, resetCacheForTest, resetLimiterForTest, resetUpstreamsForTest } =
  await import('@xbam/upstream');
const { registerMarketCapabilities } = await import('@xbam/runtime');
const { getCapability, resetCapabilitiesForTest } = await import('@xbam/tools');

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_LOWER = USDC.toLowerCase();
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const WETH_USDC_POOL = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';

/** The real WETH/USDC pool shape, with USDC as the QUOTE token. */
function wethUsdcPool(liquidity = '105680701.1374') {
  return {
    id: `eth_${WETH_USDC_POOL}`,
    type: 'pool',
    attributes: {
      address: WETH_USDC_POOL,
      name: 'WETH / USDC 0.05%',
      base_token_price_usd: '2467.48',
      quote_token_price_usd: '0.99946570522496',
      reserve_in_usd: liquidity,
      volume_usd: { h24: '66536284.86' },
    },
    relationships: {
      base_token: { data: { id: `eth_${WETH}`, type: 'token' } },
      quote_token: { data: { id: `eth_${USDC_LOWER}`, type: 'token' } },
      dex: { data: { id: 'uniswap_v3', type: 'dex' } },
    },
  };
}

const tokenAnswer = {
  body: JSON.stringify({
    data: {
      id: `eth_${USDC_LOWER}`,
      type: 'token',
      attributes: { address: USDC_LOWER, name: 'USD Coin', symbol: 'USDC', decimals: 6, total_supply: '50652893859577844.0' },
    },
  }),
};

function context() {
  return {
    agentId: 'agent-1',
    jobId: null,
    accountId: null,
    config: {},
    logger: { info() {}, warn() {}, error() {}, debug() {}, child: () => context().logger } as never,
    signal: new AbortController().signal,
  };
}

async function run<T>(id: string, input: unknown): Promise<T> {
  const capability = getCapability(id)!;
  return capability.run(capability.input.parse(input) as never, context()) as Promise<T>;
}

interface Pool {
  name: string | null;
  baseToken: { address: string | null; priceUsd: string | null };
  quoteToken: { address: string | null; priceUsd: string | null };
  priceUsdOfRequested: string | null;
  liquidityUsd: string | null;
  thin: boolean;
}

beforeEach(() => {
  resetUpstreamsForTest();
  resetBreakerForTest();
  resetCacheForTest();
  resetLimiterForTest();
  resetCapabilitiesForTest();
  registerGeckoUpstreams();
  registerMarketCapabilities();
  replies = {};
  requested = [];
});
afterEach(() => {
  resetUpstreamsForTest();
  resetCapabilitiesForTest();
});

describe('pricing the right side of a pair', () => {
  it('reports the price of the token that was asked about, not the base token', async () => {
    // The bug this exists for: USDC is the QUOTE token of WETH/USDC, so the
    // base price is 2467. Answering that to "what is USDC worth" is the kind of
    // confident wrong number this whole package exists to avoid.
    replies[`/tokens/${USDC}`] = tokenAnswer;
    replies[`/tokens/${USDC}/pools`] = { body: JSON.stringify({ data: [wethUsdcPool()] }) };

    const answer = await run<{ pools: Pool[] }>('market.resolve_exact', { chain: 'ethereum', address: USDC });
    expect(answer.pools.length, 'the fixture should have produced a pool').toBeGreaterThan(0);
    const pool = answer.pools[0]!;

    expect(pool.priceUsdOfRequested).toBe('0.99946570522496');
    expect(pool.priceUsdOfRequested).not.toBe('2467.48');
    // Both sides are named, so nothing has to be inferred from a pool's name.
    expect(pool.baseToken).toEqual({ address: WETH, priceUsd: '2467.48' });
    expect(pool.quoteToken.address).toBe(USDC_LOWER);
  });

  it('matches the address whatever its case', async () => {
    // Their ids are lower-cased; an address somebody pastes is checksummed.
    replies[`/tokens/${USDC}`] = tokenAnswer;
    replies[`/tokens/${USDC}/pools`] = { body: JSON.stringify({ data: [wethUsdcPool()] }) };
    const answer = await run<{ pools: Pool[] }>('market.resolve_exact', { chain: 'ethereum', address: USDC });
    expect(answer.pools[0]!.priceUsdOfRequested).not.toBeNull();
  });

  it('leaves it null when no particular token was asked about', async () => {
    replies['/pools/'] = { body: JSON.stringify({ data: wethUsdcPool() }) };
    const answer = await run<{ pool: Pool }>('market.snapshot', { chain: 'ethereum', poolAddress: WETH_USDC_POOL });
    // A pool read on its own has no "requested" side, and says so rather than
    // picking one.
    expect(answer.pool.priceUsdOfRequested).toBeNull();
    expect(answer.pool.baseToken.priceUsd).toBe('2467.48');
    expect(answer.pool.quoteToken.priceUsd).toBe('0.99946570522496');
  });
});

describe('a ticker is not an identity', () => {
  it('refuses one, and says why rather than complaining about length', async () => {
    // A `min(26)` rule fires before the format check and answers "String must
    // contain at least 26 character(s)", which teaches nobody anything.
    const capability = getCapability('market.resolve_exact')!;
    const refusal = capability.input.safeParse({ chain: 'ethereum', address: 'USDC' });
    expect(refusal.success).toBe(false);
    const message = JSON.stringify(refusal.error?.issues);
    expect(message).toMatch(/not a name or ticker/i);
    expect(message).toMatch(/anyone can mint a token with a given symbol/i);
    expect(message).not.toMatch(/at least 26 character/i);
    expect(requested).toHaveLength(0);
  });

  it('accepts an exact address on either chain family', () => {
    const capability = getCapability('market.resolve_exact')!;
    expect(capability.input.safeParse({ chain: 'ethereum', address: USDC }).success).toBe(true);
    expect(
      capability.input.safeParse({ chain: 'solana', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }).success,
    ).toBe(true);
  });
});

describe('the chain a caller names is not the id the indexer uses', () => {
  it('maps them explicitly rather than lower-casing and hoping', async () => {
    replies[`/tokens/${USDC}`] = tokenAnswer;
    replies[`/tokens/${USDC}/pools`] = { body: JSON.stringify({ data: [] }) };
    await run('market.resolve_exact', { chain: 'polygon', address: USDC });
    // `polygon` is `polygon_pos` there. A wrong id returns somebody else's
    // pool rather than an error, which is the dangerous kind of wrong.
    expect(requested[0]).toContain('/networks/polygon_pos/');
    expect(requested[0]).not.toContain('/networks/polygon/');
  });

  it('uses eth, not ethereum', async () => {
    replies[`/tokens/${USDC}`] = tokenAnswer;
    replies[`/tokens/${USDC}/pools`] = { body: JSON.stringify({ data: [] }) };
    await run('market.resolve_exact', { chain: 'ethereum', address: USDC });
    expect(requested[0]).toContain('/networks/eth/');
  });
});

describe('liquidity decides whether a price means anything', () => {
  it('calls a shallow pool thin', async () => {
    replies['/pools/'] = { body: JSON.stringify({ data: wethUsdcPool('250.00') }) };
    const answer = await run<{ pool: Pool; caveats: string[] }>('market.snapshot', {
      chain: 'ethereum',
      poolAddress: WETH_USDC_POOL,
    });
    expect(answer.pool.thin).toBe(true);
    expect(answer.caveats.join(' ')).toMatch(/moved by a small trade/i);
  });

  it('does not call a deep pool thin', async () => {
    replies['/pools/'] = { body: JSON.stringify({ data: wethUsdcPool('105680701.1374') }) };
    const answer = await run<{ pool: Pool; caveats: string[] }>('market.snapshot', {
      chain: 'ethereum',
      poolAddress: WETH_USDC_POOL,
    });
    expect(answer.pool.thin).toBe(false);
    expect(answer.caveats).toEqual([]);
  });

  it('orders pools deepest first, because that is where a price should come from', async () => {
    const shallow = { ...wethUsdcPool('500'), id: 'eth_0xshallow' };
    shallow.attributes = { ...shallow.attributes, address: '0xshallow' };
    replies[`/tokens/${USDC}`] = tokenAnswer;
    replies[`/tokens/${USDC}/pools`] = { body: JSON.stringify({ data: [shallow, wethUsdcPool('105680701')] }) };

    const answer = await run<{ pools: Pool[] }>('market.resolve_exact', { chain: 'ethereum', address: USDC });
    expect(answer.pools[0]!.liquidityUsd).toBe('105680701');
  });

  it('says so when every pool is thin', async () => {
    replies[`/tokens/${USDC}`] = tokenAnswer;
    replies[`/tokens/${USDC}/pools`] = { body: JSON.stringify({ data: [wethUsdcPool('100'), wethUsdcPool('250')] }) };
    const answer = await run<{ caveats: string[] }>('market.resolve_exact', { chain: 'ethereum', address: USDC });
    expect(answer.caveats.join(' ')).toMatch(/every pool found is thin/i);
  });
});

describe('what it refuses to imply', () => {
  it('does not present a new pool as a discovery', async () => {
    replies['/new_pools'] = { body: JSON.stringify({ data: [wethUsdcPool('900')] }) };
    const answer = await run<{ caveats: string[] }>('market.new_pools', { chain: 'ethereum' });
    expect(answer.caveats.join(' ')).toMatch(/most of these are worth nothing/i);
    expect(answer.caveats.join(' ')).toMatch(/token\.inspect_risk/);
  });

  it('does not present trending as quality', async () => {
    replies['trending_pools'] = { body: JSON.stringify({ data: [wethUsdcPool()] }) };
    const answer = await run<{ caveats: string[] }>('market.trending', {});
    expect(answer.caveats.join(' ')).toMatch(/attention is often manufactured/i);
    expect(answer.caveats.join(' ')).toMatch(/not that it is worth trading/i);
  });

  it('says a pool’s history is one pool’s, not the token’s', async () => {
    replies['/ohlcv/'] = {
      body: JSON.stringify({ data: { attributes: { ohlcv_list: [[1789117200, '2475.92', '2476.51', '2462.36', '2470.0', '123.4']] } } }),
    };
    const answer = await run<{ candles: { at: string; open: string }[]; note: string }>('market.ohlcv', {
      chain: 'ethereum',
      poolAddress: WETH_USDC_POOL,
    });
    expect(answer.candles).toHaveLength(1);
    expect(answer.candles[0]!.at).toMatch(/^2026-/);
    expect(answer.note).toMatch(/one pool’s history, not the token’s/i);
  });
});

describe('when the indexer misbehaves', () => {
  it('treats its 200-with-an-error envelope as a failure', async () => {
    // It answers 200 with an error body in some cases, so the status code
    // alone is not the verdict.
    replies['/pools/'] = {
      status: 200,
      body: JSON.stringify({ status: { error_code: 429, error_message: "You've exceeded the Rate Limit." } }),
    };
    await expect(run('market.snapshot', { chain: 'ethereum', poolAddress: WETH_USDC_POOL })).rejects.toThrow();
  });

  it('reports a 429 rather than treating it as an answer', async () => {
    replies['/pools/'] = { status: 429, body: '{}' };
    await expect(run('market.snapshot', { chain: 'ethereum', poolAddress: WETH_USDC_POOL })).rejects.toThrow();
  });

  it('never asks for the trades endpoint, which is 223 KB', async () => {
    replies[`/tokens/${USDC}`] = tokenAnswer;
    replies[`/tokens/${USDC}/pools`] = { body: JSON.stringify({ data: [] }) };
    await run('market.resolve_exact', { chain: 'ethereum', address: USDC });
    expect(requested.some((url) => url.includes('/trades'))).toBe(false);
  });
});
