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

/** Two chains' worth of a stablecoin, in the nested shape the source uses. */
function pegged(name: string, symbol: string, pegType: string | null, circulating: number, price: number | null) {
  return { name, symbol, pegType, pegMechanism: 'fiat-backed', circulating: { [pegType ?? 'peggedUSD']: circulating }, price };
}

describe('stablecoins, and the peg it is honest about not being able to measure', () => {
  it('measures a dollar peg, in both directions', async () => {
    responses = {
      'stablecoins.llama.fi/stablecoins': {
        status: 200,
        body: JSON.stringify({
          peggedAssets: [
            pegged('Tether', 'USDT', 'peggedUSD', 180_000_000_000, 0.9994),
            pegged('Dai', 'DAI', 'peggedUSD', 5_300_000_000, 1.0021),
          ],
        }),
      },
    };
    const answer = (await invoke('defi.stablecoins', {})) as {
      stablecoins: { symbol: string; pegDeviationPercent: number | null; deviationUnmeasurable: string | null }[];
    };

    const usdt = answer.stablecoins.find((row) => row.symbol === 'USDT')!;
    const dai = answer.stablecoins.find((row) => row.symbol === 'DAI')!;
    // Below a dollar is negative and above it is positive. A deviation reported
    // as a magnitude cannot tell a depeg from a premium.
    expect(usdt.pegDeviationPercent).toBeCloseTo(-0.06, 3);
    expect(dai.pegDeviationPercent).toBeCloseTo(0.21, 3);
    expect(usdt.deviationUnmeasurable).toBeNull();
  });

  it('refuses to call a euro stablecoin depegged for trading at 1.08 dollars', async () => {
    // This is the whole reason the check exists. EURC at 1.08 is exactly on its
    // peg; measuring it against a dollar invents an eight per cent alarm about a
    // perfectly healthy asset.
    responses = {
      'stablecoins.llama.fi/stablecoins': {
        status: 200,
        body: JSON.stringify({ peggedAssets: [pegged('Euro Coin', 'EURC', 'peggedEUR', 200_000_000, 1.0832)] }),
      },
    };
    const answer = (await invoke('defi.stablecoins', {})) as {
      stablecoins: {
        symbol: string;
        priceUsd: number | null;
        circulatingUnit: string | null;
        pegDeviationPercent: number | null;
        deviationUnmeasurable: string | null;
      }[];
    };

    const eurc = answer.stablecoins[0]!;
    expect(eurc.pegDeviationPercent).toBeNull();
    // And its supply is named in euros, because 465,693,298 read as dollars
    // when it means euros is the same sixteen per cent error by another route.
    expect(eurc.circulatingUnit).toBe('peggedEUR');
    expect(eurc.deviationUnmeasurable).toMatch(/peggedEUR/);
    expect(eurc.deviationUnmeasurable).toMatch(/not the dollar/i);
    // The price is still reported. Declining to measure a deviation is not the
    // same as withholding what was observed.
    expect(eurc.priceUsd).toBe(1.0832);
  });

  it('says a dollar peg went unmeasured because there was no price, not because of its peg', async () => {
    responses = {
      'stablecoins.llama.fi/stablecoins': {
        status: 200,
        body: JSON.stringify({ peggedAssets: [pegged('Some Coin', 'SOME', 'peggedUSD', 1_000_000, null)] }),
      },
    };
    const answer = (await invoke('defi.stablecoins', {})) as {
      stablecoins: { pegDeviationPercent: number | null; deviationUnmeasurable: string | null }[];
    };
    expect(answer.stablecoins[0]!.pegDeviationPercent).toBeNull();
    expect(answer.stablecoins[0]!.deviationUnmeasurable).toMatch(/no current price/i);
  });

  it('orders by supply and can be narrowed to one', async () => {
    responses = {
      'stablecoins.llama.fi/stablecoins': {
        status: 200,
        body: JSON.stringify({
          peggedAssets: [
            pegged('Dai', 'DAI', 'peggedUSD', 5_300_000_000, 1),
            pegged('Tether', 'USDT', 'peggedUSD', 180_000_000_000, 1),
            pegged('USD Coin', 'USDC', 'peggedUSD', 74_000_000_000, 1),
          ],
        }),
      },
    };
    const top = (await invoke('defi.stablecoins', { limit: 2 })) as {
      stablecoins: { symbol: string }[];
      totalReported: number;
    };
    expect(top.stablecoins.map((row) => row.symbol)).toEqual(['USDT', 'USDC']);
    expect(top.totalReported).toBe(3);

    const one = (await invoke('defi.stablecoins', { symbol: 'dai' })) as { stablecoins: { symbol: string }[] };
    expect(one.stablecoins.map((row) => row.symbol)).toEqual(['DAI']);
  });

  it('never asks the single-asset endpoint, which is thirty-eight times larger', async () => {
    // `stablecoins.llama.fi/stablecoin/1` is 20.6 MB against 540 KB for every
    // stablecoin there is, because it carries full history. The specific
    // question costing far more than the general one is not the shape anyone
    // assumes, and is exactly the trap worth a test.
    responses = {
      'stablecoins.llama.fi/stablecoins': { status: 200, body: JSON.stringify({ peggedAssets: [] }) },
    };
    await invoke('defi.stablecoins', { symbol: 'USDT' });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/stablecoins\.llama\.fi\/stablecoins$/);
  });

  it('attributes the answer to the host that gave it', async () => {
    // `origin` is both what a person is shown and what a machine-scoped window
    // is keyed on, so a family that says api.llama.fi while fetching
    // stablecoins.llama.fi would share an allowance it never spends and credit
    // a service that never answered.
    responses = {
      'stablecoins.llama.fi/stablecoins': { status: 200, body: JSON.stringify({ peggedAssets: [] }) },
    };
    const answer = (await invoke('defi.stablecoins', {})) as { provenance: { host: string } };
    expect(answer.provenance.host).toBe('stablecoins.llama.fi');
  });
});

describe('where stablecoin supply sits', () => {
  it('unwraps the nested total and orders by it', async () => {
    responses = {
      'stablecoins.llama.fi/stablecoinchains': {
        status: 200,
        body: JSON.stringify([
          { name: 'Tron', totalCirculatingUSD: { peggedUSD: 81_000_000_000 } },
          { name: 'Ethereum', totalCirculatingUSD: { peggedUSD: 148_000_000_000 } },
          { name: 'Solana', totalCirculatingUSD: { peggedUSD: 13_000_000_000 } },
        ]),
      },
    };
    const answer = (await invoke('defi.stablecoin_supply_by_chain', { limit: 2 })) as {
      chains: { name: string; circulatingUsd: number }[];
      totalReported: number;
    };
    expect(answer.chains.map((row) => row.name)).toEqual(['Ethereum', 'Tron']);
    expect(answer.chains[0]!.circulatingUsd).toBe(148_000_000_000);
    expect(answer.totalReported).toBe(3);
  });
});

/** A daily series ending today, oldest first, exactly as the source sends it. */
function series(values: readonly number[]) {
  const day = 86_400;
  const end = 1_789_000_000;
  return values.map((tvl, index) => ({ date: end - (values.length - 1 - index) * day, tvl }));
}

describe('how a chain has moved', () => {
  it('trims the window, computes the change across it, and says how much more there is', async () => {
    responses = {
      'api.llama.fi/v2/historicalChainTvl': { status: 200, body: JSON.stringify(series([10, 20, 30, 40, 50])) },
    };
    const answer = (await invoke('defi.chain_tvl_history', { chain: 'Ethereum', days: 3 })) as {
      points: { tvlUsd: number }[];
      first: { tvlUsd: number } | null;
      last: { tvlUsd: number } | null;
      changePercent: number | null;
      totalDaysAvailable: number;
    };

    // The last three, not the first three: a window is the recent end of a
    // series, and taking the other end answers a question about 2017.
    expect(answer.points.map((point) => point.tvlUsd)).toEqual([30, 40, 50]);
    // The change is across the window that was asked for, not across everything
    // the source holds.
    expect(answer.changePercent).toBeCloseTo(66.667, 2);
    expect(answer.first!.tvlUsd).toBe(30);
    expect(answer.last!.tvlUsd).toBe(50);
    // And the rest is acknowledged rather than hidden.
    expect(answer.totalDaysAvailable).toBe(5);
  });

  it('turns the epoch seconds into a date a person can read', async () => {
    responses = {
      'api.llama.fi/v2/historicalChainTvl': { status: 200, body: JSON.stringify(series([10, 20])) },
    };
    const answer = (await invoke('defi.chain_tvl_history', { chain: 'Ethereum', days: 2 })) as {
      points: { at: string }[];
    };
    expect(answer.points[1]!.at).toBe(new Date(1_789_000_000 * 1000).toISOString());
  });

  it('declines to state a change from a baseline of nothing', async () => {
    // The first day a chain is measured is often zero, and dividing by it
    // produces an infinite growth figure that reads like a discovery.
    responses = {
      'api.llama.fi/v2/historicalChainTvl': { status: 200, body: JSON.stringify(series([0, 5_000_000])) },
    };
    const answer = (await invoke('defi.chain_tvl_history', { chain: 'Newchain', days: 2 })) as {
      changePercent: number | null;
      points: unknown[];
    };
    expect(answer.changePercent).toBeNull();
    // The points still come back. Not stating a ratio is not refusing to answer.
    expect(answer.points).toHaveLength(2);
  });

  it('treats a chain nobody has as the question being wrong, and names it', async () => {
    // Live, an unknown chain is a 404 carrying nginx's own HTML page. The
    // general classifier reads that as NOT_FOUND and leaves the breaker alone,
    // which is right; what it cannot do is say what was not found, and
    // "It has no such thing (404)" is not an answer to give somebody who asked
    // about a chain by name.
    responses = {};
    await expect(invoke('defi.chain_tvl_history', { chain: 'Nowhere', days: 7 })).rejects.toThrow(
      /no history for a chain called "Nowhere"/,
    );
    expect(healthOf('defi_chain_history.defillama').failures).toBe(0);
  });
});
