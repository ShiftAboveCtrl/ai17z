import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What a trader reads first, and the ways it goes wrong.
 *
 * **By choosing for them.** Several tokens are called BONK. A search lists
 * them all, says so, and opens none.
 *
 * **By turning silence into zero.** A holder count the index did not report
 * is not a token with no holders.
 *
 * **By trusting a token's own links.** Whoever made the token typed them; a
 * `javascript:` address must not reach a page as something to click.
 *
 * **By showing the wrong side of a swap.** A sell's price is its "from" side.
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
    const key = Object.keys(replies)
      .filter((candidate) => url.includes(candidate))
      .sort((a, b) => b.length - a.length)[0];
    const reply = key ? replies[key]! : { status: 404, body: '{}' };
    return new Response(reply.body, { status: reply.status ?? 200, headers: new Headers({ 'content-type': 'application/json' }) });
  },
}));

const {
  registerGeckoUpstreams,
  registerJupiterSwapUpstreams,
  registerJupiterUpstreams,
  registerMarketUpstreams,
  resetBreakerForTest,
  resetCacheForTest,
  resetLimiterForTest,
  resetUpstreamsForTest,
} = await import('@xbam/upstream');
const { registerMarketIntelCapabilities, safeLink, swapQuoteFrom } = await import('@xbam/runtime');
const { readFileSync } = await import('node:fs');
const { getCapability, resetCapabilitiesForTest } = await import('@xbam/tools');

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

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const FAKE_BONK = '0x1111111111111111111111111111111111111111';
const SOL = 'So11111111111111111111111111111111111111112';

function pair(over: Record<string, unknown> = {}) {
  return {
    chainId: 'solana',
    dexId: 'orca',
    url: 'https://dexscreener.com/solana/pool1',
    pairAddress: '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9',
    baseToken: { address: BONK, name: 'Bonk', symbol: 'BONK' },
    quoteToken: { address: SOL, name: 'Wrapped SOL', symbol: 'SOL' },
    priceNative: '0.00000003095',
    priceUsd: '0.000003410',
    txns: { m5: { buys: 6, sells: 1 }, h1: { buys: 72, sells: 72 }, h6: { buys: 416, sells: 516 }, h24: { buys: 2930, sells: 3135 } },
    volume: { h24: 168836.71, h6: 33568.9, h1: 4687.85, m5: 398.99 },
    priceChange: { m5: -0.08, h1: -0.39, h6: 0.23, h24: 1.84 },
    liquidity: { usd: 368709.22 },
    fdv: 303107733,
    marketCap: 300146218,
    pairCreatedAt: 1671980424000,
    info: {
      websites: [{ url: 'https://www.bonkcoin.com', label: 'Website' }, { url: 'javascript:alert(1)', label: 'Website' }],
      socials: [{ url: 'https://twitter.com/bonk_inu', type: 'twitter' }, { url: 'data:text/html,hi', type: 'telegram' }],
    },
    ...over,
  };
}

beforeEach(() => {
  resetUpstreamsForTest();
  resetBreakerForTest();
  resetCacheForTest();
  resetLimiterForTest();
  resetCapabilitiesForTest();
  registerGeckoUpstreams();
  registerJupiterUpstreams();
  registerJupiterSwapUpstreams();
  registerMarketUpstreams();
  registerMarketIntelCapabilities();
  replies = {};
  requested = [];
});
afterEach(() => {
  resetUpstreamsForTest();
  resetCapabilitiesForTest();
});

describe('searching', () => {
  it('lists every token that answers to a symbol, says it is ambiguous, and chooses none', async () => {
    replies['/search?q=BONK'] = {
      body: JSON.stringify({
        pairs: [
          pair(),
          pair({ pairAddress: 'pool2', liquidity: { usd: 1000 } }),
          pair({ chainId: 'base', pairAddress: '0x2222222222222222222222222222222222222222', baseToken: { address: FAKE_BONK, name: 'Bonk', symbol: 'BONK' }, liquidity: { usd: 900_000 } }),
        ],
      }),
    };
    const answer = await run<{ ambiguous: boolean; candidates: { chain: string; tokenAddress: string; pairAddress: string; pairsFound: number }[] }>('market.search', { query: 'BONK' });
    expect(answer.ambiguous).toBe(true);
    expect(answer.candidates.map((c) => `${c.chain}:${c.tokenAddress}`)).toEqual([`base:${FAKE_BONK}`, `solana:${BONK}`]);
    // Two Solana pairs for one token are one candidate, priced from the deeper pair.
    const solana = answer.candidates.find((c) => c.chain === 'solana')!;
    expect(solana.pairAddress).toBe('5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9');
    expect(solana.pairsFound).toBe(2);
  });

  it('asks for an exact address by address, not as a search term', async () => {
    replies[`/tokens/${BONK}`] = { body: JSON.stringify({ pairs: [pair()] }) };
    const answer = await run<{ ambiguous: boolean; candidates: unknown[] }>('market.search', { query: BONK });
    expect(answer.candidates).toHaveLength(1);
    expect(requested.some((u) => u.includes(`/tokens/${BONK}`))).toBe(true);
    expect(requested.some((u) => u.includes('/search?'))).toBe(false);
  });
});

describe('one pair', () => {
  it('reads every window, keeps only http links, and leaves a missing number missing', async () => {
    replies['/pairs/solana/5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9'] = { body: JSON.stringify({ pairs: [pair({ fdv: undefined })] }) };
    const answer = await run<{ found: boolean; pair: { fdv: number | null; marketCap: number; windows: { h1: { buys: number } }; links: { kind: string; url: string }[]; pairCreatedAt: string } }>(
      'market.pair_detail',
      { chain: 'solana', pairAddress: '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9' },
    );
    expect(answer.found).toBe(true);
    expect(answer.pair.fdv).toBeNull();
    expect(answer.pair.marketCap).toBe(300146218);
    expect(answer.pair.windows.h1.buys).toBe(72);
    expect(answer.pair.links).toEqual([
      { kind: 'website', url: 'https://www.bonkcoin.com/' },
      { kind: 'twitter', url: 'https://twitter.com/bonk_inu' },
    ]);
    expect(answer.pair.pairCreatedAt).toBe('2022-12-25T15:00:24.000Z');
  });

  it('refuses a name where an address belongs', async () => {
    const capability = getCapability('market.pair_detail')!;
    expect(capability.input.safeParse({ chain: 'solana', pairAddress: 'BONK' }).success).toBe(false);
  });

  it('never turns a script address into a link', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.example', 'ftp://x.example']) expect(safeLink(bad)).toBeNull();
    expect(safeLink('https://ok.example/path')).toBe('https://ok.example/path');
  });
});

describe('the tape', () => {
  it('prices a sell from its from side, newest first', async () => {
    const trade = (kind: 'buy' | 'sell', at: string, hash: string) => ({
      attributes: {
        block_number: 1,
        block_timestamp: at,
        tx_hash: hash,
        tx_from_address: 'Hp6n1g1WqDXHyHEKMSojSKFHiFWuf2igmtSaSRHcAX23',
        kind,
        from_token_amount: kind === 'buy' ? '0.01' : '1000',
        to_token_amount: kind === 'buy' ? '367729.9' : '0.01',
        price_from_in_usd: kind === 'buy' ? '110' : '0.0000034',
        price_to_in_usd: kind === 'buy' ? '0.0000034' : '110',
        volume_in_usd: '1.25',
      },
    });
    replies['/pools/5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9/trades'] = {
      body: JSON.stringify({ data: [trade('buy', '2026-10-10T22:15:00Z', 'a'), trade('sell', '2026-10-10T22:16:00Z', 'b')] }),
    };
    const answer = await run<{ trades: { side: string; priceUsd: number; tokenAmount: string; txHash: string }[] }>('market.recent_trades', {
      chain: 'solana',
      poolAddress: '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9',
    });
    expect(answer.trades.map((t) => t.txHash)).toEqual(['b', 'a']);
    expect(answer.trades[0]).toMatchObject({ side: 'sell', priceUsd: 0.0000034, tokenAmount: '1000' });
    expect(answer.trades[1]).toMatchObject({ side: 'buy', priceUsd: 0.0000034, tokenAmount: '367729.9' });
  });
});

describe('a Solana token', () => {
  const record = {
    id: BONK,
    name: 'Bonk',
    symbol: 'Bonk',
    decimals: 5,
    dev: '9AhKqLR67hwapvG8SA2JFXaCshXc9nALJjpKaHZrsbkw',
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    launchpad: 'pump.fun',
    firstPool: { id: 'x', createdAt: '2023-05-11T17:09:10Z' },
    audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: false, topHoldersPercentage: 30.5, devBalancePercentage: 0.1, devMints: 10 },
    stats1h: { priceChange: -0.6, numBuys: 336, numSells: 396, numTraders: 214 },
    isVerified: true,
    tags: ['verified', 'meme'],
    usdPrice: 0.0000034,
    website: 'javascript:alert(1)',
    twitter: 'https://x.com/bonk',
    icon: 'https://arweave.net/hQiPZOsRZXGXBJd_82PhVdlM_hACsT_q6wqwf5cSY7I',
    priceBlockId: 455417028,
    updatedAt: '2026-10-10T22:17:32Z',
  };

  it('reads concentration, authorities and launch history, and keeps an unreported holder count unreported', async () => {
    replies[`/tokens/v2/search?query=${BONK}`] = { body: JSON.stringify([{ ...record, id: '11111111111111111111111111111111' }, record]) };
    const answer = await run<{ found: boolean; token: Record<string, unknown> }>('token.solana_profile', { mint: BONK });
    expect(answer.found).toBe(true);
    expect(answer.token).toMatchObject({
      mint: BONK,
      holderCount: null,
      topHoldersPct: 30.5,
      developerLaunches: 10,
      developerMigrations: null,
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: false,
      token2022: false,
      launchpad: 'pump.fun',
      flaggedByIndex: false,
      website: null,
      twitter: 'https://x.com/bonk',
      icon: 'https://arweave.net/hQiPZOsRZXGXBJd_82PhVdlM_hACsT_q6wqwf5cSY7I',
      priceBlock: 455417028,
    });
  });

  it('carries the token’s picture only as a web address', async () => {
    replies[`/tokens/v2/search?query=${BONK}`] = { body: JSON.stringify([{ ...record, icon: 'javascript:alert(1)' }]) };
    const answer = await run<{ token: { icon: string | null } }>('token.solana_profile', { mint: BONK });
    expect(answer.token.icon).toBeNull();
  });

  it('lists only the categories and windows it knows, through a fixed path', async () => {
    replies['/tokens/v2/toptraded/6h'] = { body: JSON.stringify([record]) };
    const answer = await run<{ tokens: { mint: string }[] }>('market.discover_solana', { list: 'traded', interval: '6h', limit: 10 });
    expect(answer.tokens.map((t) => t.mint)).toEqual([BONK]);
    expect(requested.at(-1)).toContain('/tokens/v2/toptraded/6h?limit=10');
    expect(getCapability('market.discover_solana')!.input.safeParse({ list: '../admin' }).success).toBe(false);
  });
});

/*
 * What a swap would get. The fixture is a real Swap API V2 order for 0.01 SOL
 * into BONK, recorded with no taker, so it carries no transaction.
 */
describe('a swap quote', () => {
  const ORDER = readFileSync(new URL('../fixtures/jupiter-swap-v2-order.json', import.meta.url), 'utf8');
  const asked = { inputMint: SOL, outputMint: BONK, amount: '10000000', slippageBps: 100 };

  it('reads the route, the floor and the impact exactly, without a float in an amount', async () => {
    replies['/swap/v2/order?'] = { body: ORDER };
    const answer = await run<{ found: boolean; quote: { inAmount: string; outAmount: string; minOut: string; priceImpactPercent: number; route: { venue: string }[]; guaranteed: boolean } }>('market.swap_quote', asked);
    const order = JSON.parse(ORDER) as { outAmount: string; otherAmountThreshold: string };
    expect(answer.found).toBe(true);
    expect(answer.quote.inAmount).toBe('10000000');
    expect(answer.quote.outAmount).toBe(order.outAmount);
    expect(answer.quote.minOut).toBe(order.otherAmountThreshold);
    expect(answer.quote.route.map((r) => r.venue)).toContain('Meteora');
    expect(answer.quote.priceImpactPercent).toBeLessThan(0);
    // Nothing was asked of the router that would let it build a transaction.
    const url = requested.find((u) => u.includes('/swap/v2/order?'))!;
    expect(url).not.toContain('taker');
    expect(url).toContain(`inputMint=${SOL}`);
  });

  it('asks the router again every time, because an old quote is a wrong price', async () => {
    replies['/swap/v2/order?'] = { body: ORDER };
    await run('market.swap_quote', asked);
    await run('market.swap_quote', asked);
    expect(requested.filter((u) => u.includes('/swap/v2/order?'))).toHaveLength(2);
  });

  it('takes the floor from the route and never from the slippage it asked for', () => {
    // A market maker's firm quote applies no slippage; the floor is what it promised.
    const firm = { inputMint: SOL, outputMint: BONK, inAmount: '10000000', outAmount: '1092591', otherAmountThreshold: '1092591', slippageBps: 0, guaranteedPrice: true };
    const quote = swapQuoteFrom(firm, asked, '2026-10-11T00:00:00Z')!;
    expect(quote.minOut).toBe('1092591');
    expect(quote.appliedSlippageBps).toBe(0);
    expect(quote.requestedSlippageBps).toBe(100);
    expect(quote.guaranteed).toBe(true);
  });

  it('refuses an answer that is not a quote for exactly this swap', () => {
    const base = JSON.parse(ORDER) as Record<string, unknown>;
    const at = '2026-10-11T00:00:00Z';
    expect(swapQuoteFrom({ ...base, outputMint: SOL }, asked, at)).toBeNull();
    expect(swapQuoteFrom({ ...base, inAmount: '20000000' }, asked, at)).toBeNull();
    expect(swapQuoteFrom({ ...base, outAmount: '1.5' }, asked, at)).toBeNull();
    expect(swapQuoteFrom({ ...base, otherAmountThreshold: '99999999999999' }, asked, at)).toBeNull();
    expect(swapQuoteFrom({ ...base, outAmount: '0', otherAmountThreshold: '0' }, asked, at)).toBeNull();
  });

  it('says there is no route rather than inventing one', async () => {
    replies['/swap/v2/order?'] = { body: JSON.stringify({ errorCode: 1, errorMessage: 'No routes found' }) };
    await expect(run('market.swap_quote', asked)).rejects.toThrow(/no route/i);
  });

  it('refuses a symbol, a decimal amount and a swap into itself before asking anybody', async () => {
    const capability = getCapability('market.swap_quote')!;
    expect(capability.input.safeParse({ ...asked, outputMint: 'BONK' }).success).toBe(false);
    expect(capability.input.safeParse({ ...asked, amount: '0.01' }).success).toBe(false);
    expect(capability.input.safeParse({ ...asked, outputMint: SOL }).success).toBe(false);
    expect(requested).toHaveLength(0);
  });
});
