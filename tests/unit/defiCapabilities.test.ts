import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Value locked, and the price question that is really two questions.
 *
 * A price from a pool and a price from an aggregator are arrived at differently,
 * and when they differ the difference **is** the finding. The temptation is to
 * pick one -- the higher, the fresher, the one that makes the sentence easier --
 * and that is exactly the thing not to do. Somebody acts on these numbers, and a
 * quiet choice between two disagreeing sources is a fabrication with a citation
 * attached.
 */

let responses: Record<string, { status: number; body: string }> = {};
const asked: string[] = [];

vi.mock('undici', () => ({
  Agent: class {
    async close() {}
  },
  async fetch(input: unknown) {
    const url = String(input);
    asked.push(url);
    const match = Object.keys(responses).find((key) => url.includes(key));
    const answer = match ? responses[match]! : { status: 404, body: '{}' };
    return new Response(answer.body, {
      status: answer.status,
      headers: new Headers({ 'content-type': 'application/json' }),
    });
  },
}));

const {
  registerDefiUpstreams,
  registerMarketUpstreams,
  resetBreakerForTest,
  resetCacheForTest,
  resetLimiterForTest,
  resetUpstreamsForTest,
  healthOf,
} = await import('@xbam/upstream');
const { registerDefiCapabilities } = await import('@xbam/runtime');
const { getCapability, resetCapabilitiesForTest } = await import('@xbam/tools');

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

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

async function invoke(id: string, input: unknown) {
  const capability = getCapability(id);
  if (!capability) throw new Error(`${id} is not registered`);
  return capability.run(capability.input.parse(input) as never, context());
}

/** A price from each source, so the comparison has something to compare. */
function priceBoth(aggregator: number, pool: number) {
  responses = {
    'coins.llama.fi': {
      status: 200,
      body: JSON.stringify({
        coins: {
          [`ethereum:${WETH}`]: { price: aggregator, symbol: 'WETH', decimals: 18, confidence: 0.99, timestamp: 1789076920 },
        },
      }),
    },
    'api.dexscreener.com': {
      status: 200,
      body: JSON.stringify({
        pairs: [
          {
            chainId: 'ethereum',
            baseToken: { address: WETH, symbol: 'WETH', name: 'Wrapped Ether' },
            quoteToken: { symbol: 'USDC' },
            priceUsd: String(pool),
            liquidity: { usd: 5_000_000 },
            volume: { h24: 1_000_000 },
          },
        ],
      }),
    },
  };
}

beforeEach(() => {
  resetUpstreamsForTest();
  resetBreakerForTest();
  resetCacheForTest();
  resetLimiterForTest();
  resetCapabilitiesForTest();
  registerDefiUpstreams();
  registerMarketUpstreams();
  registerDefiCapabilities();
  asked.length = 0;
  responses = {};
});
afterEach(() => {
  resetUpstreamsForTest();
  resetCapabilitiesForTest();
});

describe('two sources that are allowed to disagree', () => {
  it('says they agree when they do, and by how little', async () => {
    priceBoth(2461.63, 2460.12);
    const answer = (await invoke('market.price_check', { chain: 'ethereum', address: WETH })) as {
      agree: boolean;
      differencePercent: number;
      sources: { name: string; priceUsd: number; confidence: number | null }[];
      summary: string;
    };

    expect(answer.agree).toBe(true);
    expect(answer.sources).toHaveLength(2);
    expect(answer.differencePercent).toBeLessThan(1);
    // The confidence the source reported travels with it: a price at 0.7 and one
    // at 0.99 are different claims.
    expect(answer.sources.find((s) => s.name === 'aggregator')!.confidence).toBe(0.99);
  });

  it('reports a disagreement and refuses to resolve it', async () => {
    // Twenty per cent apart. Picking either would be inventing a number with a
    // citation attached.
    priceBoth(2500, 2000);
    const answer = (await invoke('market.price_check', { chain: 'ethereum', address: WETH })) as {
      agree: boolean;
      differencePercent: number;
      sources: { priceUsd: number }[];
      summary: string;
    };

    expect(answer.agree).toBe(false);
    expect(answer.differencePercent).toBeGreaterThan(15);
    // Both numbers survive into the answer. Neither is presented as the price.
    expect(answer.sources.map((s) => s.priceUsd).sort()).toEqual([2000, 2500]);
    expect(answer.summary).toMatch(/disagree/i);
    expect(answer.summary).toMatch(/Neither has been preferred/i);
  });

  it('says so when only one source could answer, rather than implying agreement', async () => {
    responses = {
      'coins.llama.fi': {
        status: 200,
        body: JSON.stringify({ coins: { [`ethereum:${WETH}`]: { price: 2461, confidence: 0.9 } } }),
      },
      'api.dexscreener.com': { status: 200, body: JSON.stringify({ pairs: [] }) },
    };
    const answer = (await invoke('market.price_check', { chain: 'ethereum', address: WETH })) as {
      agree: boolean | null;
      differencePercent: number | null;
      sources: unknown[];
      summary: string;
    };

    expect(answer.agree).toBeNull();
    expect(answer.differencePercent).toBeNull();
    expect(answer.sources).toHaveLength(1);
    expect(answer.summary).toMatch(/nothing to check it against/i);
  });

  it('says neither could, rather than returning nothing', async () => {
    responses = {
      'coins.llama.fi': { status: 200, body: JSON.stringify({ coins: {} }) },
      'api.dexscreener.com': { status: 200, body: JSON.stringify({ pairs: [] }) },
    };
    const answer = (await invoke('market.price_check', { chain: 'ethereum', address: WETH })) as {
      agree: boolean | null;
      sources: unknown[];
      summary: string;
    };
    expect(answer.agree).toBeNull();
    expect(answer.sources).toHaveLength(0);
    expect(answer.summary).toMatch(/Neither source/i);
  });

  it('refuses a ticker, because a price needs an exact contract', async () => {
    await expect(invoke('market.price_check', { chain: 'ethereum', address: 'WETH' })).rejects.toThrow();
  });
});

describe('value locked', () => {
  it('reads a protocol in dollars', async () => {
    responses = { 'api.llama.fi/tvl': { status: 200, body: '18017451732.454136' } };
    const answer = (await invoke('defi.protocol_tvl', { protocol: 'Aave' })) as {
      protocol: string;
      tvlUsd: number;
      provenance: { host: string };
    };
    expect(answer.protocol).toBe('aave');
    expect(answer.tvlUsd).toBeCloseTo(18_017_451_732, 0);
    expect(answer.provenance.host).toBe('api.llama.fi');
  });

  it('treats an unknown protocol as the question being wrong, not the service', async () => {
    // A slug nobody has must not cool off a source that is working perfectly.
    responses = { 'api.llama.fi/tvl': { status: 400, body: 'Protocol not found' } };
    await expect(invoke('defi.protocol_tvl', { protocol: 'not-a-protocol' })).rejects.toThrow(/NOT_FOUND/);
    expect(healthOf('defi_tvl.defillama').failures).toBe(0);
  });

  it('puts one chain in proportion to the rest', async () => {
    responses = {
      'api.llama.fi/v2/chains': {
        status: 200,
        body: JSON.stringify([
          { name: 'Ethereum', tvl: 49_440_000_000, tokenSymbol: 'ETH' },
          { name: 'Solana', tvl: 5_790_000_000, tokenSymbol: 'SOL' },
          { name: 'Base', tvl: 5_550_000_000, tokenSymbol: null },
        ]),
      },
    };
    const answer = (await invoke('defi.chain_tvl', { limit: 2 })) as {
      chains: { name: string }[];
      totalReported: number;
    };
    // Largest first, so "big" and "small" mean something.
    expect(answer.chains.map((c) => c.name)).toEqual(['Ethereum', 'Solana']);
    expect(answer.totalReported).toBe(3);
  });
});

describe('what it asks for', () => {
  it('never asks for the endpoint that returns ten megabytes', async () => {
    // `api.llama.fi/protocol/aave` is the obvious one and it returns the whole
    // historical series in answer to "how much is in Aave".
    responses = { 'api.llama.fi/tvl': { status: 200, body: '1' } };
    await invoke('defi.protocol_tvl', { protocol: 'aave' });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/\/tvl\//);
    expect(asked[0]).not.toMatch(/\/protocol\//);
  });
});
