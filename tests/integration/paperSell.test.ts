import { afterEach, describe, expect, it } from 'vitest';
import { trading } from '@xbam/database';
import { AssetRef, MarketSnapshot, type TradeMandate } from '@xbam/shared/contracts';
import {
  PaperTradeInput,
  TradePreflightInput,
  amountOut,
  paperPositions,
  registerMarketReader,
  resetMarketReadersForTest,
  runPaperTrade,
  type MarketReader,
} from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();
afterEach(() => resetMarketReadersForTest());

/**
 * Selling on paper, through the same engine as buying.
 *
 * At a price nowhere near one to one: 2.5 of the native asset per token. A
 * sale spends the token and receives the native asset, so what arrives is the
 * token amount after the fee times the price, and the position it came out of
 * shrinks by exactly what was sold. Paper never goes short, and the side has
 * to agree with the assets.
 */

const TOKEN = AssetRef.parse({ kind: 'ONCHAIN', network: 'robinhood', address: '0x00000000000000000000000000000000000000aa', decimals: 18, symbol: 'FIXTURE' });
const NATIVE = AssetRef.parse({ kind: 'NATIVE', network: 'robinhood' });
const PRICE = '2500000000000000000';
const ONE = 1_000_000_000_000_000_000n;

const snap = (): MarketSnapshot =>
  MarketSnapshot.parse({
    venue: 'PONS_V2_CURVE',
    network: 'robinhood',
    asset: TOKEN,
    quoteAsset: NATIVE,
    atBlock: '1000',
    observedAt: new Date().toISOString(),
    priceBaseUnits: PRICE,
    liquidityBase: '500000000000000000000',
    feeMicroBps: 10_000,
    phase: 'CURVE',
    source: 'fake-reader',
  });

const reader: MarketReader = { id: 'fake', version: '1', venues: ['PONS_V2_CURVE'], read: async () => snap() };

async function agent() {
  const fixture = await createFixture();
  await trading.putMandate({
    agentId: fixture.agentId,
    ownerId: fixture.ownerId,
    mandate: {
      mode: 'PAPER',
      approval: 'OWNER_APPROVES_EACH',
      venues: ['PONS_V2_CURVE'],
      networks: ['robinhood'],
      allowedAssets: [TOKEN],
      maxPerTrade: '10000000000000000000',
      maxPerDay: '50000000000000000000',
      maxOpenExposure: '40000000000000000000',
      maxOpenPositions: 5,
      maxSlippageBps: 100,
      maxPriceImpactBps: 200,
      minLiquidityBase: '1000000000000000000',
      maxFeeBase: '100000000000000000',
      quoteMaxAgeMs: 30_000,
      expiresAt: null,
      paused: false,
    } as unknown as Omit<TradeMandate, 'id' | 'agentId'>,
  });
  return fixture;
}

const common = { venue: 'PONS_V2_CURVE' as const, subject: TOKEN, maxSlippageBps: 50, maxPriceImpactBps: 100, maxFeeBase: '100000000000000000' };
const buy = (agentId: string, maxIn: string) => runPaperTrade({ agentId, side: 'BUY', assetIn: NATIVE, assetOut: TOKEN, maxIn, ...common });
const sell = (agentId: string, maxIn: string) => runPaperTrade({ agentId, side: 'SELL', assetIn: TOKEN, assetOut: NATIVE, maxIn, ...common });

describe('a paper sale', () => {
  it('spends the token and receives the native asset at the price, after the fee', async () => {
    registerMarketReader(reader);
    const { agentId } = await agent();
    // 5 native at 2.5 per token buys 1.98 tokens after the 1% fee.
    const bought = await buy(agentId, (5n * ONE).toString());
    expect(bought.outcome).toBe('FILLED');
    if (bought.outcome !== 'FILLED') return;
    expect(bought.fill.outBase).toBe('1980000000000000000');

    // Selling one token: 0.99 after the fee, times 2.5, is 2.475 native.
    const sold = await sell(agentId, ONE.toString());
    expect(sold.outcome, sold.outcome === 'REFUSED' ? sold.verdict.reasons.map((r) => r.code).join() : '').toBe('FILLED');
    if (sold.outcome !== 'FILLED') return;
    expect(sold.fill.inBase).toBe(ONE.toString());
    expect(sold.fill.outBase).toBe('2475000000000000000');
    expect(sold.fill.outBase).toBe(amountOut((ONE * 99n) / 100n, snap(), 'ASSET').toString());
    expect(sold.intent.side).toBe('SELL');
  });

  it('leaves the position smaller by exactly what was sold, with the profit in the quote units', async () => {
    registerMarketReader(reader);
    const { agentId } = await agent();
    await buy(agentId, (5n * ONE).toString());
    await sell(agentId, ONE.toString());
    const [p] = paperPositions(await trading.paperFillsOf(agentId));
    expect(p).toMatchObject({ quantityBase: '980000000000000000', buys: 1, sells: 1, simulated: true });
    // Cost of one token out of 1.98 bought for 5: 2.525252... truncated.
    expect(BigInt(p!.costBase) + 2525252525252525252n).toBe(5n * ONE);
    expect(p!.realizedBase).toBe((2475000000000000000n - 2525252525252525252n).toString());
  });

  it('never goes short: selling more than is held is refused and recorded', async () => {
    registerMarketReader(reader);
    const { agentId } = await agent();
    const nothing = await sell(agentId, ONE.toString());
    expect(nothing.outcome).toBe('REFUSED');
    if (nothing.outcome !== 'REFUSED') return;
    expect(nothing.verdict.reasons.map((r) => r.code)).toContain('SELLS_MORE_THAN_HELD');
    expect(nothing.intent.status).toBe('RISK_REJECTED');

    await buy(agentId, (5n * ONE).toString());
    const tooMuch = await sell(agentId, (2n * ONE).toString());
    expect(tooMuch.outcome).toBe('REFUSED');
    expect(paperPositions(await trading.paperFillsOf(agentId))[0]!.quantityBase).toBe('1980000000000000000');
  });

  it('lets only one of two simultaneous sales of the whole holding through', async () => {
    registerMarketReader(reader);
    const { agentId } = await agent();
    await buy(agentId, (5n * ONE).toString());
    const results = await Promise.all([sell(agentId, '1980000000000000000'), sell(agentId, '1980000000000000000')]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['FILLED', 'REFUSED']);
    expect(paperPositions(await trading.paperFillsOf(agentId))[0]!.quantityBase).toBe('0');
  });

  it('is refused by the engine when its side disagrees with its assets', async () => {
    registerMarketReader(reader);
    const { agentId } = await agent();
    await expect(runPaperTrade({ agentId, side: 'SELL', assetIn: NATIVE, assetOut: TOKEN, maxIn: ONE.toString(), ...common })).rejects.toThrow(/SELL spends the asset being priced/);
    await expect(runPaperTrade({ agentId, side: 'BUY', assetIn: TOKEN, assetOut: NATIVE, maxIn: ONE.toString(), ...common })).rejects.toThrow(/BUY spends another asset/);
  });
});

describe('the input schemas', () => {
  const trade = { venue: 'PONS_V2_CURVE', maxIn: '1', maxSlippageBps: 50, maxPriceImpactBps: 100, maxFeeBase: '1', subject: TOKEN };

  it('accept a SELL that spends the subject and a BUY that receives it', () => {
    expect(PaperTradeInput.safeParse({ ...trade, side: 'SELL', assetIn: TOKEN, assetOut: NATIVE }).success).toBe(true);
    expect(PaperTradeInput.safeParse({ ...trade, side: 'BUY', assetIn: NATIVE, assetOut: TOKEN }).success).toBe(true);
  });

  it('refuse a side that disagrees with the assets, for a paper trade and a preflight alike', () => {
    const wrong = PaperTradeInput.safeParse({ ...trade, side: 'SELL', assetIn: NATIVE, assetOut: TOKEN });
    expect(wrong.success).toBe(false);
    expect(JSON.stringify(wrong.error?.issues)).toContain('side');
    const mandate = { mode: 'PAPER', approval: 'OWNER_APPROVES_EACH', venues: ['PONS_V2_CURVE'], networks: ['robinhood'], allowedAssets: [TOKEN], maxPerTrade: '1', maxPerDay: '1', maxOpenExposure: '1', maxOpenPositions: 1, maxSlippageBps: 1, maxPriceImpactBps: 1, minLiquidityBase: '1', maxFeeBase: '1', quoteMaxAgeMs: 1000, expiresAt: null, paused: false };
    expect(TradePreflightInput.safeParse({ ...trade, side: 'BUY', assetIn: TOKEN, assetOut: NATIVE, mandate }).success).toBe(false);
  });
});
