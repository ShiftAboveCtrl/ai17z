import { beforeAll, describe, expect, it } from 'vitest';
import { trading } from '@xbam/database';
import { freshnessOf, readMarket, registerPoolMarketReader, resetMarketReadersForTest, runPaperTrade } from '@xbam/runtime';
import { registerGeckoUpstreams, resetUpstreamsForTest } from '@xbam/upstream';
import { MarketSnapshot, type AssetRef, type TradeMandate } from '@xbam/shared/contracts';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * The pool reader against the real indexer, over the real network.
 *
 * This is the only file that may be cited as evidence that AI17Z can price a
 * real market. Every other test in the suite feeds it recorded payloads, which
 * proves the arithmetic and says nothing about whether the source still
 * answers in the shape the arithmetic expects. A schema change at the other
 * end breaks pricing and passes every unit test.
 *
 * Off unless asked, by `AI17Z_LIVE_MARKET=1`. A third party's free API should
 * not be called on every push by every contributor, and a test that depends on
 * somebody else's uptime is a red build that means nothing. It skips loudly
 * rather than passing: a skip is not a pass.
 *
 * Nothing here can move value. It reads, and the venue it reads has no
 * executor in this repository.
 */

const live = process.env.AI17Z_LIVE_MARKET === '1';
const describeLive = live ? describe : describe.skip;

/**
 * Wrapped Ether on Ethereum, which is the safest possible subject: deep,
 * old, on many pools, and its price is a number anybody can check against a
 * dozen independent sources while reading the output of this test.
 */
const WETH: AssetRef = {
  kind: 'ONCHAIN',
  network: 'ethereum',
  address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  decimals: 18,
  symbol: 'WETH',
};

/**
 * What the price is wanted in, pinned rather than left to the venue.
 *
 * This argument exists because of this test. Unpinned, the representative pool
 * for WETH was a WETH/WBTC pool, so the reader answered 0.0306: a true price,
 * in Bitcoin, to a question that was about dollars. The fixtures could not
 * have found that, because a fixture contains the pools somebody thought of.
 */
const USDC: AssetRef = {
  kind: 'ONCHAIN',
  network: 'ethereum',
  address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  decimals: 6,
  symbol: 'USDC',
};

beforeAll(() => {
  if (!live) {
    // Said out loud, because a silent skip in a long run is indistinguishable
    // from a test that ran.
    console.warn('poolMarketLive: skipped. Set AI17Z_LIVE_MARKET=1 to prove the reader against the live indexer.');
    return;
  }
  resetUpstreamsForTest();
  resetMarketReadersForTest();
  registerGeckoUpstreams();
  registerPoolMarketReader();
});

describeLive('the pool reader, live', () => {
  it('prices a real token on a real pool, and the answer is checkable', async () => {
    const outcome = await readMarket(WETH, 'AMM_POOL_EVM', USDC);
    expect(outcome.outcome, JSON.stringify(outcome)).toBe('OK');
    if (outcome.outcome !== 'OK') return;

    const snapshot = outcome.snapshot;
    // Parsed again rather than trusted: `readMarket` already does this, and a
    // second parse here is what makes this file evidence on its own.
    expect(MarketSnapshot.safeParse(snapshot).success).toBe(true);

    const quoteDecimals = snapshot.quoteAsset.kind === 'ONCHAIN' ? snapshot.quoteAsset.decimals : 0;
    const whole = Number(BigInt(snapshot.priceBaseUnits)) / 10 ** quoteDecimals;

    // Priced in what was asked for, which is what makes the number below
    // comparable to anything.
    expect(snapshot.quoteAsset).toMatchObject({ kind: 'ONCHAIN', address: USDC.address, decimals: 6 });

    // Printed so a person reading the run can check it against any price
    // source they like. An assertion nobody can sanity-check is not proof.
    console.log(
      `WETH priced at ${whole} per whole unit of ${snapshot.quoteAsset.kind === 'ONCHAIN' ? (snapshot.quoteAsset.symbol ?? snapshot.quoteAsset.address) : 'quote'}`,
      { source: snapshot.source, fee: snapshot.feeMicroBps, liquidity: snapshot.liquidityBase },
    );

    // A deliberately wide band. The point is not to pin a price, which moves:
    // it is to catch the failures that are orders of magnitude out, which is
    // what every way of getting this wrong actually produces. Reading the
    // wrong side of the pair gives about 0.0004; a decimals mistake gives a
    // factor of a million.
    expect(whole).toBeGreaterThan(100);
    expect(whole).toBeLessThan(100_000);

    // The fee is present, because a pool that would not say is not quoted.
    expect(snapshot.feeMicroBps).not.toBeNull();
    expect(snapshot.feeMicroBps!).toBeGreaterThan(0);
    // Depth was read, so the risk gate's minimum can actually be met.
    expect(snapshot.liquidityBase).not.toBeNull();
    // Which pool, on which dex, out of how many.
    expect(snapshot.source).toMatch(/median of [0-9]+/);
    // Observed now, not at some remembered time.
    expect(freshnessOf(snapshot, 120_000).fresh).toBe(true);
  }, 60_000);

  it('says a token nothing trades is not listed, rather than failing', async () => {
    // A syntactically valid address that is not a token. The indexer answers,
    // and what it answers is that it has no pools. That is an answer.
    const nothing: AssetRef = {
      kind: 'ONCHAIN',
      network: 'ethereum',
      address: '0x000000000000000000000000000000000000dEaD',
      decimals: 18,
    };
    const outcome = await readMarket(nothing, 'AMM_POOL_EVM', USDC);
    // NOT_LISTED or UNAVAILABLE are both honest here, depending on whether the
    // indexer answers an empty list or a 404, and which it does is its choice
    // rather than ours. What must never happen is a price.
    expect(['NOT_LISTED', 'UNAVAILABLE']).toContain(outcome.outcome);
  }, 60_000);
});

describeLive('a paper trade against a real market', () => {
  /**
   * The whole point of the reader, and the thing no fixture can show.
   *
   * A mandate wide enough to let one WETH-for-USDC trade through and nothing
   * wider, then the ordinary engine: two reads of a live pool, a simulation, a
   * risk verdict, and a fill assumed at what the pool actually said. Nothing
   * signs, the mode is forced to PAPER inside the engine, and the venue this
   * runs on has no executor anywhere in this repository.
   *
   * The ceilings are in USDC base units because USDC is what is being spent,
   * and six decimals is what the chain says it has. Ten dollars is deliberately
   * small: it is a simulation, and a number somebody can check by eye is worth
   * more here than a round one.
   */
  it('prices, simulates and fills, with every number coming from the pool', async () => {
    const fixture = await createFixture();
    await trading.putMandate({
      agentId: fixture.agentId,
      ownerId: fixture.ownerId,
      mandate: {
        mode: 'PAPER',
        approval: 'OWNER_APPROVES_EACH',
        venues: ['AMM_POOL_EVM'],
        networks: ['ethereum'],
        allowedAssets: [WETH, USDC],
        maxPerTrade: '10000000',
        maxPerDay: '50000000',
        maxOpenExposure: '40000000',
        maxOpenPositions: 5,
        maxSlippageBps: 200,
        maxPriceImpactBps: 300,
        // A thousand USDC of depth, which the real pool has many times over.
        // Set low enough to be about the trade rather than about the pool.
        minLiquidityBase: '1000000000',
        maxFeeBase: '1000000',
        // Two reads of a live API take a second or two, and the gate compares
        // them. Generous enough not to be about the network.
        quoteMaxAgeMs: 120_000,
        expiresAt: null,
        paused: false,
      } as unknown as Omit<TradeMandate, 'id' | 'agentId'>,
    });

    const outcome = await runPaperTrade({
      agentId: fixture.agentId,
      venue: 'AMM_POOL_EVM',
      side: 'BUY',
      assetIn: USDC,
      assetOut: WETH,
      subject: WETH,
      // Ten USDC.
      maxIn: '10000000',
      maxSlippageBps: 100,
      maxPriceImpactBps: 200,
      maxFeeBase: '1000000',
    });

    console.log('live paper trade', JSON.stringify(outcome, null, 1));
    expect(outcome.outcome, 'outcome' in outcome ? JSON.stringify(outcome) : '').toBe('FILLED');
    if (outcome.outcome !== 'FILLED') return;

    // Simulated, said in the shape of the answer and not only in a comment.
    expect(outcome.fill.simulated).toBe(true);
    expect(outcome.intent.mode).toBe('PAPER');
    expect(outcome.intent.status).toBe('PAPER_FILLED');

    // The quote is the pool's, not a fixture's: it names the pool it came from.
    expect(outcome.fill.at.source).toMatch(/^pool\.geckoterminal /);
    expect(outcome.fill.at.quoteAsset).toMatchObject({ address: USDC.address });

    // Ten USDC in, and the 0.05 or 0.3 per cent the pool charges out of it. The
    // fee is a real reading rather than a zero standing in for one: that is the
    // FEE_UNKNOWN rule, and a pool that would not say is never quoted.
    expect(outcome.fill.inBase).toBe('10000000');
    expect(BigInt(outcome.fill.feeBase)).toBeGreaterThan(0n);
    expect(BigInt(outcome.fill.outBase)).toBeLessThan(10_000_000n);
    expect(BigInt(outcome.fill.outBase) + BigInt(outcome.fill.feeBase)).toBe(10_000_000n);

    // A floor worked out from a live price, in WETH base units. Ten dollars of
    // ether at any plausible price is well inside these, and a wrong-unit quote
    // would be outside them by orders of magnitude.
    const floor = BigInt(outcome.intent.minOut);
    expect(floor).toBeGreaterThan(10n ** 14n);
    expect(floor).toBeLessThan(10n ** 17n);

    // It went through the gate rather than round it.
    expect(outcome.verdict.allowed).toBe(true);
    expect(outcome.verdict.reasons.map((r) => r.code)).toContain('WITHIN_MANDATE');
    // Paper never waits for an owner: approving a simulation teaches somebody
    // to approve without reading.
    expect(outcome.verdict.needsOwnerApproval).toBe(false);
  }, 120_000);
});
