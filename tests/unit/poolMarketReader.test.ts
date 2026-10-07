import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Pricing a real pool, and the ways that goes wrong.
 *
 * The fixtures here are the shapes the live indexer actually returned on
 * 2026-10-07, including the two that make a naive reader wrong: a three-asset
 * Curve pool that is the deepest thing holding WETH and reports a pair price
 * that is a projection of a three-asset invariant, and the same token sitting
 * on the base side of one pool and the quote side of another.
 *
 * **By taking the deepest pool.** `crvUSD / WETH / CRV` reported 827,039,486
 * USD of reserve against the WETH/USDC cluster at about 96,000,000, and a
 * price off the cluster. Deepest-wins quotes it.
 *
 * **By reading the wrong side.** `WETH / USDC` and `USDC / WETH` are both in
 * one answer. Reading `base_token_price_usd` for the second one answers what
 * WETH is worth to the question "what is USDC worth".
 *
 * **By treating a missing fee as no fee.** The Curve pool reports
 * `pool_fee_percentage: null`. Charging nothing simulates a better fill than
 * any that could really happen.
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
    // Longest match wins, exactly as in the market capability tests: the token
    // pools path contains the token path, and first-match would answer a pool
    // list with a token.
    const key = Object.keys(replies)
      .filter((candidate) => url.includes(candidate))
      .sort((a, b) => b.length - a.length)[0];
    const reply = key ? replies[key]! : { status: 404, body: '{}' };
    return new Response(reply.body, { status: reply.status ?? 200, headers: new Headers({ 'content-type': 'application/json' }) });
  },
}));

const { registerGeckoUpstreams, resetBreakerForTest, resetCacheForTest, resetLimiterForTest, resetUpstreamsForTest } =
  await import('@xbam/upstream');
const {
  MAX_FEE_CANDIDATES,
  MIN_POOLS_FOR_A_MEDIAN,
  feePercentToMicroBps,
  liquidityInCounterparty,
  medianPool,
  poolViewFor,
  readMarket,
  readPoolMarket,
  registerPoolMarketReader,
  resetMarketReadersForTest,
  scaleToBaseUnits,
} = await import('@xbam/runtime');
const { TRADE_VENUES } = await import('@xbam/shared/contracts');

const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const WETH_USDC = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';
const WETH_USDT = '0x11b815efb8f581194ae79006d24e0d814b7697f6';
const USDC_WETH = '0xe0554a476a092703abdb3ef35c80e0d76d32939f';
const TRICRYPTO = '0x7f86bf177dd4f3494b841a37e810a34dd56c829b';

const wethAsset = { kind: 'ONCHAIN' as const, network: 'ethereum' as const, address: WETH, decimals: 18 };

/** One pool entry in the indexer's own shape. */
function pool(options: {
  address: string;
  name: string;
  base: string;
  quote: string;
  basePriceUsd: string;
  quotePriceUsd: string;
  basePerQuote: string;
  quotePerBase: string;
  reserveUsd?: string | null;
  dex?: string;
}) {
  return {
    id: `eth_${options.address}`,
    type: 'pool',
    attributes: {
      address: options.address,
      name: options.name,
      base_token_price_usd: options.basePriceUsd,
      quote_token_price_usd: options.quotePriceUsd,
      base_token_price_quote_token: options.basePerQuote,
      quote_token_price_base_token: options.quotePerBase,
      reserve_in_usd: options.reserveUsd === undefined ? '96675785.9177' : options.reserveUsd,
      volume_usd: { h24: '1000000' },
    },
    relationships: {
      base_token: { data: { id: `eth_${options.base}`, type: 'token' } },
      quote_token: { data: { id: `eth_${options.quote}`, type: 'token' } },
      dex: { data: { id: options.dex ?? 'uniswap_v3', type: 'dex' } },
    },
  };
}

/** The real cluster, measured. Three pools so a median means something. */
function wethPools() {
  return [
    pool({
      address: WETH_USDC,
      name: 'WETH / USDC 0.05%',
      base: WETH,
      quote: USDC,
      basePriceUsd: '2550.32',
      quotePriceUsd: '0.999623759102041',
      basePerQuote: '2550.247206358',
      quotePerBase: '0.0003921188493',
      reserveUsd: '96657234.5929',
    }),
    pool({
      address: WETH_USDT,
      name: 'WETH / USDT 0.3%',
      base: WETH,
      quote: USDT,
      basePriceUsd: '2550.34',
      quotePriceUsd: '0.996783734332861',
      basePerQuote: '2558.569037753',
      quotePerBase: '0.0003908',
      reserveUsd: '98217658.3869',
    }),
    // The same token on the other side of the pair. Reading the base price
    // here answers what USDC is worth to a question about WETH.
    pool({
      address: USDC_WETH,
      name: 'USDC / WETH 0.3%',
      base: USDC,
      quote: WETH,
      basePriceUsd: '0.9967042191',
      quotePriceUsd: '2549.06',
      basePerQuote: '0.0003923383967',
      quotePerBase: '2549.0612',
      reserveUsd: '45033595.2348',
    }),
  ];
}

/** The deepest pool holding WETH, and not one a pair trade fills against. */
function tricrypto() {
  return pool({
    address: TRICRYPTO,
    name: 'crvUSD / WETH / CRV',
    base: '0xf939e0a03fb07f59a73314e73794be0e57ac1b4e',
    quote: WETH,
    basePriceUsd: '0.9967555309',
    quotePriceUsd: '4000.00',
    basePerQuote: '0.0003906317038',
    quotePerBase: '4000.00',
    reserveUsd: '827039486.8765',
    dex: 'curve',
  });
}

/** One token record, in the shape `include=base_token,quote_token` returns. */
const included = (address: string, symbol: string, decimals: number) => ({
  id: `eth_${address}`,
  type: 'token',
  attributes: { address, symbol, name: symbol, decimals },
});

const poolAnswer = (address: string, fee: string | null) => ({
  body: JSON.stringify({ data: { id: `eth_${address}`, type: 'pool', attributes: { address, pool_fee_percentage: fee } } }),
});

beforeEach(() => {
  resetUpstreamsForTest();
  resetBreakerForTest();
  resetCacheForTest();
  resetLimiterForTest();
  resetMarketReadersForTest();
  registerGeckoUpstreams();
  replies = {};
  requested = [];
});
afterEach(() => {
  resetUpstreamsForTest();
  resetMarketReadersForTest();
});

describe('reading the right side of a pair', () => {
  it('prices the token that was asked about, whichever side of the pool it is on', () => {
    const [wethUsdc, , usdcWeth] = wethPools();
    const onBase = poolViewFor(wethUsdc, WETH);
    const onQuote = poolViewFor(usdcWeth, WETH);
    expect(onBase?.priceUsd).toBeCloseTo(2550.32, 2);
    expect(onBase?.counterpartyAddress).toBe(USDC);
    // The same token, on the quote side, is still worth about 2549 and not
    // about one dollar. This is the assertion the whole file exists for.
    expect(onQuote?.priceUsd).toBeCloseTo(2549.06, 2);
    expect(onQuote?.counterpartyAddress).toBe(USDC);
  });

  it('drops a pool the asset is not in at all', () => {
    const other = pool({
      address: '0x1111111111111111111111111111111111111111',
      name: 'USDC / USDT',
      base: USDC,
      quote: USDT,
      basePriceUsd: '1',
      quotePriceUsd: '1',
      basePerQuote: '1',
      quotePerBase: '1',
    });
    expect(poolViewFor(other, WETH)).toBeNull();
  });

  it('refuses a price that is not a positive finite number', () => {
    for (const bad of ['0', '-5', 'NaN', '']) {
      const broken = pool({
        address: WETH_USDC,
        name: 'WETH / USDC',
        base: WETH,
        quote: USDC,
        basePriceUsd: bad,
        quotePriceUsd: '1',
        basePerQuote: '1',
        quotePerBase: '1',
      });
      expect(poolViewFor(broken, WETH), bad).toBeNull();
    }
  });
});

describe('the median, not the deepest', () => {
  it('does not let one very deep outlier be the quote', () => {
    const views = [...wethPools(), tricrypto()]
      .map((entry) => poolViewFor(entry, WETH))
      .filter((v): v is NonNullable<typeof v> => v !== null);
    const chosen = medianPool(views);
    // The outlier has eight times the reserve of anything else and would win
    // any depth comparison. It cannot win a median.
    expect(chosen?.address).not.toBe(TRICRYPTO);
    expect(chosen?.priceUsd).toBeLessThan(2600);
  });

  it('takes a pool that exists rather than the mean of two', () => {
    const views = wethPools()
      .map((entry) => poolViewFor(entry, WETH))
      .filter((v): v is NonNullable<typeof v> => v !== null);
    const chosen = medianPool(views);
    expect(views.map((v) => v.address)).toContain(chosen?.address);
  });

  it('has nothing to say about an empty population', () => {
    expect(medianPool([])).toBeNull();
  });
});

describe('exact arithmetic', () => {
  it('scales a price to base units without going through a float', () => {
    // 2550.247206358 at six decimals is 2550.247206, so 2550247206 of USDC's
    // smallest unit. A float round trip loses the last digits at eighteen.
    expect(scaleToBaseUnits('2550.247206358', 6)).toBe('2550247206');
    expect(scaleToBaseUnits('0.0003921188493', 18)).toBe('392118849300000');
    expect(scaleToBaseUnits('1', 18)).toBe('1000000000000000000');
    expect(scaleToBaseUnits('0.5', 0)).toBe('0');
  });

  it('truncates rather than rounding, so the error never flatters the fill', () => {
    expect(scaleToBaseUnits('1.999999', 2)).toBe('199');
  });

  it('refuses something that is not a decimal number', () => {
    for (const bad of ['', '-1', '1e9', 'abc', '1.2.3']) expect(scaleToBaseUnits(bad, 6), bad).toBeNull();
  });

  it('turns a fee percentage into hundredths of a basis point', () => {
    expect(feePercentToMicroBps('0.05')).toBe(500);
    expect(feePercentToMicroBps('0.3')).toBe(3000);
    expect(feePercentToMicroBps('100')).toBe(1_000_000);
    expect(feePercentToMicroBps('-1')).toBeNull();
    expect(feePercentToMicroBps('101')).toBeNull();
    expect(feePercentToMicroBps('nonsense')).toBeNull();
  });

  it('turns a reserve in dollars into counterparty base units, and absent stays absent', () => {
    // About 96.7 million dollars of reserve at a dollar a unit is about 96.7
    // million USDC, which at six decimals has fourteen digits.
    const liquidity = liquidityInCounterparty('96657234.5929', '0.999623759102041', 6);
    expect(liquidity).not.toBeNull();
    expect(BigInt(liquidity!)).toBeGreaterThan(96_000_000_000_000n);
    expect(liquidityInCounterparty(null, '1', 6)).toBeNull();
    expect(liquidityInCounterparty('100', null, 6)).toBeNull();
    // A counterparty worth nothing cannot be divided by.
    expect(liquidityInCounterparty('100', '0', 6)).toBeNull();
  });
});

describe('reading a venue end to end', () => {
  function installFixtures(pools: unknown[], fee: string | null = '0.05') {
    // The tokens travel with the pools, exactly as the live answer does when
    // asked with `include`. A fixture that answered them separately would be
    // testing a request shape the reader no longer makes.
    replies[`/tokens/${WETH}/pools`] = {
      body: JSON.stringify({
        data: pools,
        included: [included(WETH, 'WETH', 18), included(USDC, 'USDC', 6), included(USDT, 'USDT', 6)],
      }),
    };
    replies[`/pools/${WETH_USDC}`] = poolAnswer(WETH_USDC, fee);
    replies[`/pools/${WETH_USDT}`] = poolAnswer(WETH_USDT, fee);
    replies[`/pools/${USDC_WETH}`] = poolAnswer(USDC_WETH, fee);
  }

  it('answers a snapshot the contract accepts, through readMarket', async () => {
    installFixtures(wethPools());
    registerPoolMarketReader();

    const outcome = await readMarket(wethAsset, 'AMM_POOL_EVM');
    expect(outcome.outcome, 'outcome' in outcome ? JSON.stringify(outcome) : '').toBe('OK');
    if (outcome.outcome !== 'OK') return;
    const snapshot = outcome.snapshot;
    expect(snapshot.venue).toBe('AMM_POOL_EVM');
    expect(snapshot.phase).toBe(TRADE_VENUES.AMM_POOL_EVM.phase);
    expect(snapshot.feeMicroBps).toBe(500);
    expect(snapshot.quoteAsset).toMatchObject({ kind: 'ONCHAIN', decimals: 6 });
    // One whole WETH is worth a few thousand of a six-decimal stablecoin, so
    // the integer is in the billions of base units. A wrong scaling is off by
    // orders of magnitude and this catches it.
    expect(BigInt(snapshot.priceBaseUnits)).toBeGreaterThan(1_000_000_000n);
    expect(BigInt(snapshot.priceBaseUnits)).toBeLessThan(100_000_000_000n);
    expect(snapshot.liquidityBase).not.toBeNull();
    // Null rather than invented: the indexer reports no block for a pool.
    expect(snapshot.atBlock).toBeNull();
    expect(snapshot.source).toContain('median of 3');
  });

  it('steps past a pool with no fee to the next-nearest that has one', async () => {
    installFixtures(wethPools());
    // Whichever pool the median lands on, make that one refuse to say what it
    // charges. Found by running the live test twice: a fee-less pool at the
    // median was costing the whole asset its price rather than losing its own
    // place.
    const views = wethPools()
      .map((entry) => poolViewFor(entry, WETH))
      .filter((v): v is NonNullable<typeof v> => v !== null);
    const middle = medianPool(views)!;
    replies[`/pools/${middle.address}`] = poolAnswer(middle.address, null);
    registerPoolMarketReader();

    const outcome = await readMarket(wethAsset, 'AMM_POOL_EVM');
    expect(outcome.outcome, JSON.stringify(outcome)).toBe('OK');
    if (outcome.outcome !== 'OK') return;
    expect(outcome.snapshot.source).not.toContain(middle.address);
    expect(outcome.snapshot.feeMicroBps).not.toBeNull();
  });

  it('gives up after a bounded number of fee-less candidates', async () => {
    installFixtures(wethPools(), null);
    registerPoolMarketReader();
    expect((await readMarket(wethAsset, 'AMM_POOL_EVM')).outcome).toBe('NOT_LISTED');
    // Three pools asked and no more, plus the pool list. A token nothing can
    // quote must not cost one request per pool.
    expect(requested.length).toBeLessThanOrEqual(1 + MAX_FEE_CANDIDATES);
  });

  it('will not quote a pool that does not say what it charges', async () => {
    installFixtures(wethPools(), null);
    registerPoolMarketReader();

    // An answer, not a failure: the indexer replied and this is what it has.
    const outcome = await readMarket(wethAsset, 'AMM_POOL_EVM');
    expect(outcome.outcome).toBe('NOT_LISTED');
  });

  it('will not price a token with too few pools to cross-check', async () => {
    installFixtures(wethPools().slice(0, MIN_POOLS_FOR_A_MEDIAN - 1));
    registerPoolMarketReader();
    expect((await readMarket(wethAsset, 'AMM_POOL_EVM')).outcome).toBe('NOT_LISTED');
  });

  it('says nothing is listed when the indexer has no pools at all', async () => {
    installFixtures([]);
    registerPoolMarketReader();
    expect((await readMarket(wethAsset, 'AMM_POOL_EVM')).outcome).toBe('NOT_LISTED');
  });

  it('reports a refusal from the indexer as a failed read, never as an absent token', async () => {
    replies[`/tokens/${WETH}/pools`] = { status: 500, body: '{}' };
    registerPoolMarketReader();
    const outcome = await readMarket(wethAsset, 'AMM_POOL_EVM');
    // The distinction the whole contract rests on. "We could not ask" recorded
    // as "it does not trade" is how a reader becomes a reason to do something.
    expect(outcome.outcome).toBe('UNAVAILABLE');
  });

  it('refuses a native coin rather than guessing a wrapped contract', async () => {
    registerPoolMarketReader();
    const outcome = await readMarket({ kind: 'NATIVE', network: 'ethereum' }, 'AMM_POOL_EVM');
    expect(outcome.outcome).toBe('UNAVAILABLE');
    if (outcome.outcome !== 'UNAVAILABLE') return;
    expect(outcome.detail).toMatch(/will not guess/);
    // Nothing was asked of the indexer, because there was nothing to ask about.
    expect(requested).toHaveLength(0);
  });

  it('refuses a broker instrument, which does not trade in a pool', async () => {
    registerPoolMarketReader();
    const outcome = await readMarket({ kind: 'BROKER_INSTRUMENT', venue: 'ROBINHOOD', symbol: 'AAPL' }, 'AMM_POOL_EVM');
    expect(outcome.outcome).toBe('UNAVAILABLE');
  });

  it('refuses a network this reader and that venue do not share', async () => {
    registerPoolMarketReader();
    // A Solana mint on the EVM venue. Shaped like a mint, wrong family.
    const outcome = await readPoolMarket(
      { kind: 'ONCHAIN', network: 'solana', address: 'So11111111111111111111111111111111111111112', decimals: 9 },
      'AMM_POOL_EVM',
    ).then(
      () => 'answered',
      (error: Error) => error.message,
    );
    expect(outcome).toMatch(/does not execute on Solana/);
  });

  it('prices in the asset asked for, and refuses to substitute another', async () => {
    installFixtures(wethPools());
    registerPoolMarketReader();

    const usdc = { kind: 'ONCHAIN' as const, network: 'ethereum' as const, address: USDC, decimals: 6 };
    const inUsdc = await readMarket(wethAsset, 'AMM_POOL_EVM', usdc);
    expect(inUsdc.outcome, JSON.stringify(inUsdc)).toBe('OK');
    if (inUsdc.outcome === 'OK') expect(inUsdc.snapshot.quoteAsset).toMatchObject({ address: USDC });

    // The live failure this exists for, in miniature: WETH has a real price in
    // WBTC, and answering it to a question about USDC is a true number about a
    // different trade. There is no WBTC pool in the fixtures, so the honest
    // answer is that this cannot be priced that way.
    const wbtc = { kind: 'ONCHAIN' as const, network: 'ethereum' as const, address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', decimals: 8 };
    expect((await readMarket(wethAsset, 'AMM_POOL_EVM', wbtc)).outcome).toBe('NOT_LISTED');
  });

  it('prices against a pinned counterparty even where there is only one such pool', async () => {
    // Pinned, the population is no longer choosing a counterparty, so one pool
    // is a thin answer rather than an unsafe one. Depth is the gate's job.
    installFixtures(wethPools());
    registerPoolMarketReader();
    const usdt = { kind: 'ONCHAIN' as const, network: 'ethereum' as const, address: USDT, decimals: 6 };
    const outcome = await readMarket(wethAsset, 'AMM_POOL_EVM', usdt);
    expect(outcome.outcome).toBe('OK');
    if (outcome.outcome === 'OK') expect(outcome.snapshot.source).toContain('median of 1');
  });

  it('refuses a subject whose decimals are not what the chain says', async () => {
    installFixtures(wethPools());
    registerPoolMarketReader();
    // WETH has eighteen. Told six, every amount in the trade would be a
    // million times the wrong size, and nothing else in sight would look odd.
    const outcome = await readMarket({ ...wethAsset, decimals: 6 }, 'AMM_POOL_EVM');
    expect(outcome.outcome).toBe('UNAVAILABLE');
    if (outcome.outcome !== 'UNAVAILABLE') return;
    expect(outcome.detail).toMatch(/has 18 decimals .* and was given as 6/);
  });

  it('refuses a quote asset that is not a contract, or is on another chain', async () => {
    installFixtures(wethPools());
    registerPoolMarketReader();
    const native = await readMarket(wethAsset, 'AMM_POOL_EVM', { kind: 'NATIVE', network: 'ethereum' });
    expect(native.outcome).toBe('UNAVAILABLE');
    const elsewhere = await readMarket(wethAsset, 'AMM_POOL_EVM', {
      kind: 'ONCHAIN',
      network: 'bnb',
      address: USDC,
      decimals: 18,
    });
    expect(elsewhere.outcome).toBe('UNAVAILABLE');
  });

  it('leaves Pons and Pump unread: this reader does not claim their venues', async () => {
    registerPoolMarketReader();
    for (const venue of ['PONS_V1', 'PONS_V2_CURVE', 'PONS_V2_GRADUATED', 'PUMP_CURVE', 'PUMP_SWAP', 'ROBINHOOD'] as const) {
      expect((await readMarket(wethAsset, venue)).outcome, venue).toBe('NO_READER');
    }
  });

  it('spends two requests: the pools with their tokens, and the chosen pool', async () => {
    installFixtures(wethPools());
    registerPoolMarketReader();
    await readMarket(wethAsset, 'AMM_POOL_EVM');
    // The measured budget is four requests in ten seconds and it refuses
    // rather than waits, so this count is a working constraint rather than a
    // tidiness one: at five, one read could not complete at all.
    expect(requested).toHaveLength(2);
    expect(requested[0]).toContain('include=base_token');
  });
});
