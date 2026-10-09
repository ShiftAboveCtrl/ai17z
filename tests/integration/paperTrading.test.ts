import { afterEach, describe, expect, it } from 'vitest';
import { trading } from '@xbam/database';
import { AssetRef, MarketSnapshot, type TradeMandate, type TradeVenue } from '@xbam/shared/contracts';
import {
  amountOut,
  freshnessOf,
  minOutFor,
  readMarket,
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
 * A trade taken to the signing boundary and stopped there.
 *
 * The reader is a fake, because a real one talks to a chain and that is
 * adapter work. What is being proved is not the arithmetic of any venue: it is
 * that paper runs the same intent, mandate, gate, fresh read and simulation as
 * live, never signs, and never consumes a live limit.
 */

const TOKEN = AssetRef.parse({
  kind: 'ONCHAIN',
  network: 'robinhood',
  address: '0x00000000000000000000000000000000000000aa',
  decimals: 18,
  symbol: 'FIXTURE',
});
const NATIVE = AssetRef.parse({ kind: 'NATIVE', network: 'robinhood' });

const snap = (over: Partial<MarketSnapshot> = {}): MarketSnapshot =>
  MarketSnapshot.parse({
    venue: 'PONS_V2_CURVE',
    network: 'robinhood',
    asset: TOKEN,
    quoteAsset: NATIVE,
    atBlock: '1000',
    observedAt: new Date().toISOString(),
    priceBaseUnits: '1000000000000000000',
    liquidityBase: '500000000000000000000',
    feeMicroBps: 10_000,
    phase: 'CURVE',
    source: 'fake-reader',
    ...over,
  });

/** A reader whose answers a test chooses, one per call. */
function fakeReader(answers: (MarketSnapshot | null | Error)[], venues: readonly TradeVenue[] = ['PONS_V2_CURVE']): MarketReader {
  let i = 0;
  return {
    id: 'fake',
    version: '1',
    venues,
    // The arguments are ignored on purpose: what each call answers is the
    // test's choice, and `readMarket` is what checks the answer matches the
    // question.
    async read(_asset, _venue) {
      // Coalesced because an index can be undefined under
      // noUncheckedIndexedAccess, and the contract answers null or a snapshot.
      const a = answers[Math.min(i, answers.length - 1)] ?? null;
      i += 1;
      if (a instanceof Error) throw a;
      return a;
    },
  };
}

const mandateDraft = (over: Record<string, unknown> = {}) => ({
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
  ...over,
});

async function agent(over: Record<string, unknown> = {}) {
  const fixture = await createFixture();
  await trading.putMandate({
    agentId: fixture.agentId,
    ownerId: fixture.ownerId,
    mandate: mandateDraft(over) as unknown as Omit<TradeMandate, 'id' | 'agentId'>,
  });
  return fixture;
}

const ask = (agentId: string, over: Record<string, unknown> = {}) =>
  runPaperTrade({
    agentId,
    venue: 'PONS_V2_CURVE',
    side: 'BUY',
    assetIn: NATIVE,
    assetOut: TOKEN,
    subject: TOKEN,
    maxIn: '1000000000000000000',
    maxSlippageBps: 50,
    maxPriceImpactBps: 100,
    maxFeeBase: '100000000000000000',
    ...over,
  });

describe('reading a venue keeps its four answers apart', () => {
  it('tells an unlisted asset from a read that failed', async () => {
    // Collapsing these is how "the node was down" becomes "the token does not
    // exist" and then, later, a reason to do something.
    registerMarketReader(fakeReader([null]));
    expect((await readMarket(TOKEN, 'PONS_V2_CURVE')).outcome).toBe('NOT_LISTED');

    resetMarketReadersForTest();
    registerMarketReader(fakeReader([new Error('node timed out')]));
    const failed = await readMarket(TOKEN, 'PONS_V2_CURVE');
    expect(failed.outcome).toBe('UNAVAILABLE');
    expect(failed.outcome === 'UNAVAILABLE' && failed.detail).toContain('node timed out');
  });

  it('says so when nobody can read the venue at all', async () => {
    expect((await readMarket(TOKEN, 'PUMP_CURVE')).outcome).toBe('NO_READER');
  });

  it('refuses an answer about a different asset or venue than was asked', async () => {
    const other = AssetRef.parse({ ...TOKEN, address: '0x00000000000000000000000000000000000000bb' });
    registerMarketReader(fakeReader([snap({ asset: other })]));
    expect((await readMarket(TOKEN, 'PONS_V2_CURVE')).outcome).toBe('UNAVAILABLE');

    resetMarketReadersForTest();
    registerMarketReader(fakeReader([snap({ venue: 'PONS_V1', phase: 'POOL' })]));
    expect((await readMarket(TOKEN, 'PONS_V2_CURVE')).outcome).toBe('UNAVAILABLE');
  });

  it('refuses a reader that disagrees with the venue about its own phase', async () => {
    registerMarketReader(fakeReader([snap({ phase: 'POOL' })]));
    const out = await readMarket(TOKEN, 'PONS_V2_CURVE');
    expect(out.outcome).toBe('UNAVAILABLE');
    expect(out.outcome === 'UNAVAILABLE' && out.detail).toContain('CURVE');
  });

  it('measures freshness and refuses a snapshot from the future', () => {
    const now = new Date('2026-10-04T00:00:00.000Z');
    const old = snap({ observedAt: new Date(now.getTime() - 10_000).toISOString() });
    expect(freshnessOf(old, 30_000, now).fresh).toBe(true);
    expect(freshnessOf(old, 5_000, now).fresh).toBe(false);
    const ahead = snap({ observedAt: new Date(now.getTime() + 1_000).toISOString() });
    expect(freshnessOf(ahead, 30_000, now).fresh).toBe(false);
  });
});

describe('a paper trade runs the whole path and signs nothing', () => {
  it('fills, and records the fill as simulated', async () => {
    const fixture = await agent();
    registerMarketReader(fakeReader([snap()]));
    const out = await ask(fixture.agentId);

    expect(out.outcome, out.outcome === 'REFUSED' ? out.verdict.reasons.map((r) => r.code).join(',') : '').toBe('FILLED');
    if (out.outcome !== 'FILLED') return;
    expect(out.fill.simulated).toBe(true);
    expect(out.intent.status).toBe('PAPER_FILLED');
    expect(out.intent.mode).toBe('PAPER');
    // The fee the snapshot reported was applied, and nothing arrived for free.
    expect(BigInt(out.fill.outBase)).toBeLessThan(BigInt(out.fill.inBase));
    expect(BigInt(out.fill.feeBase)).toBeGreaterThan(0n);
    // It went through simulation, which is the gate's precondition.
    expect(out.intent.simulation).not.toBeNull();
    // And what it executed against was stored, not just what it was quoted.
    expect(out.intent.executedOn).not.toBeNull();
  }, 60_000);

  it('never consumes a live limit', async () => {
    // PAPER_FILLED is ignored by the exposure sum, so paper cannot exhaust an
    // owner's daily allowance or their open-position count.
    const fixture = await agent();
    registerMarketReader(fakeReader([snap()]));
    for (let i = 0; i < 3; i += 1) await ask(fixture.agentId, { idempotencyKey: `paper-loop-${fixture.agentId}-${i}` });

    const exposure = await trading.exposureOf(fixture.agentId, new Date(Date.now() - 86_400_000));
    expect(exposure.spentTodayBase).toBe('0');
    expect(exposure.openExposureBase).toBe('0');
    expect(exposure.openPositions).toBe(0);
  }, 90_000);

  it('cannot be asked to go live', async () => {
    // There is no argument that makes this live: the mode is forced at
    // creation, so a caller passing one is ignored rather than obeyed.
    const fixture = await agent();
    registerMarketReader(fakeReader([snap()]));
    const out = await ask(fixture.agentId, { mode: 'LIVE' } as Record<string, unknown>);
    expect(out.outcome).toBe('FILLED');
    if (out.outcome !== 'FILLED') return;
    expect(out.intent.mode).toBe('PAPER');
    expect(out.intent.txIdentity, 'paper leaves no transaction identity').toBeNull();
    expect(out.intent.broadcastAt).toBeNull();
  }, 60_000);

  it('is refused by the same gate a live trade would meet', async () => {
    const fixture = await agent();
    await trading.pauseTrading({ scope: 'AGENT', target: fixture.agentId, reason: 'stop', createdBy: null });
    registerMarketReader(fakeReader([snap()]));
    const out = await ask(fixture.agentId);
    expect(out.outcome).toBe('REFUSED');
    if (out.outcome !== 'REFUSED') return;
    expect(out.verdict.reasons.map((r) => r.code)).toContain('PAUSED');
    expect(out.intent.status).toBe('RISK_REJECTED');
    // The reasons survived onto the row, not only into the return value.
    expect(out.intent.riskReasons?.map((r) => r.code)).toContain('PAUSED');
  }, 60_000);

  it('exercises the staleness rule rather than skipping it', async () => {
    // Two reads: the quote, then what it would execute against. A price that
    // ran away between them is refused exactly as it would be live.
    const fixture = await agent();
    registerMarketReader(fakeReader([snap(), snap({ priceBaseUnits: '2000000000000000000' })]));
    const out = await ask(fixture.agentId);
    expect(out.outcome).toBe('REFUSED');
    if (out.outcome !== 'REFUSED') return;
    expect(out.verdict.reasons.map((r) => r.code)).toContain('PRICE_MOVED');
  }, 60_000);

  it('stops when the venue cannot be read at all', async () => {
    const fixture = await agent();
    registerMarketReader(fakeReader([new Error('rpc down')]));
    const out = await ask(fixture.agentId);
    expect(out.outcome).toBe('NO_MARKET');
  }, 60_000);

  it('refuses an agent with no mandate', async () => {
    const fixture = await createFixture();
    registerMarketReader(fakeReader([snap()]));
    const out = await ask(fixture.agentId);
    expect(out.outcome).toBe('NO_MARKET');
    if (out.outcome !== 'NO_MARKET') return;
    expect(out.detail).toContain('no mandate');
  }, 60_000);

  it('makes one trade per decision when retried', async () => {
    const fixture = await agent();
    registerMarketReader(fakeReader([snap()]));
    const key = `once-${fixture.agentId}`;
    await ask(fixture.agentId, { idempotencyKey: key });
    await ask(fixture.agentId, { idempotencyKey: key });
    expect(await trading.listIntents(fixture.agentId)).toHaveLength(1);
  }, 60_000);
});

describe('what arrives is in the units of what arrives', () => {
  /*
   * The fill used to report spent minus fee, in the units spent, with no price
   * in it. Every fixture priced its asset at one quote unit with eighteen
   * decimals on both sides, the one market where that is right, so nothing
   * noticed until a live paper trade of a tenth of an ether for USDC
   * "received" 99,950,000,000,000,000 base units of a six-decimal coin.
   */
  const USDC = AssetRef.parse({ kind: 'ONCHAIN', network: 'ethereum', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 });
  const WETH = AssetRef.parse({ kind: 'ONCHAIN', network: 'ethereum', address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', decimals: 18 });
  // The canary's own reading: one USDC costs 399,829,160,600,000 wei of WETH.
  const usdcInWeth = MarketSnapshot.parse({
    venue: 'AMM_POOL_EVM',
    network: 'ethereum',
    asset: USDC,
    quoteAsset: WETH,
    atBlock: null,
    observedAt: new Date().toISOString(),
    priceBaseUnits: '399829160600000',
    liquidityBase: '38227457595306041184813',
    feeMicroBps: 500,
    phase: 'POOL',
    source: 'fixture from a live read',
  });

  it('turns WETH spent into USDC bought at the price', () => {
    // 0.1 WETH at about 2,501 USDC each is about 250.1 USDC.
    const out = amountOut(10n ** 17n, usdcInWeth, 'QUOTE');
    expect(out).toBe((10n ** 17n * 10n ** 6n) / 399829160600000n);
    expect(out > 250_000_000n && out < 250_200_000n).toBe(true);
  });

  it('turns USDC sold into WETH received at the same price', () => {
    // 250 USDC back into WETH is about a tenth of one.
    const out = amountOut(250_000_000n, usdcInWeth, 'ASSET');
    expect(out).toBe((250_000_000n * 399829160600000n) / 10n ** 6n);
    expect(out > 99_000_000_000_000_000n && out < 10n ** 17n).toBe(true);
  });

  it('fills a buy at a price that is not one, in the units of the token bought', async () => {
    const fixture = await agent();
    // Two native units per token: a whole native buys half a token, less fee.
    const price = snap({ priceBaseUnits: '2000000000000000000' });
    registerMarketReader(fakeReader([price, price]));
    const out = await ask(fixture.agentId);
    expect(out.outcome, out.outcome === 'REFUSED' ? out.verdict.reasons.map((r) => r.code).join(',') : '').toBe('FILLED');
    if (out.outcome !== 'FILLED') return;
    const netIn = 10n ** 18n - (10n ** 18n * 10_000n) / 1_000_000n;
    expect(BigInt(out.fill.outBase)).toBe((netIn * 10n ** 18n) / 2_000000000000000000n);
  });

  it('asks a sale for a floor in what the sale receives', () => {
    // Selling one token at two native each: at least 2 native less slippage,
    // not half a native, which is what the buy-side formula would have said.
    const quote = snap({ priceBaseUnits: '2000000000000000000' });
    expect(BigInt(minOutFor('1000000000000000000', quote, 0, 'ASSET'))).toBe(2n * 10n ** 18n);
    expect(BigInt(minOutFor('1000000000000000000', quote, 0, 'QUOTE'))).toBe(5n * 10n ** 17n);
  });
});

describe('the floor a trade asks for', () => {
  it('rounds the minimum down, so it fails safe', () => {
    // Asking for slightly less than the ceiling strictly allows is the safe
    // direction. Rounding up would let a trade through the owner did not
    // quite permit.
    const quote = snap({ priceBaseUnits: '3000000000000000000' });
    const out = BigInt(minOutFor('1000000000000000000', quote, 100));
    // One input unit buys a third of a token at this price; 1 per cent off.
    const atQuote = (10n ** 18n * 10n ** 18n) / 3_000000000000000000n;
    expect(out).toBe((atQuote * 9900n) / 10_000n);
    expect(out).toBeLessThan(atQuote);
  });

  it('never asks for nothing', () => {
    // A floor of zero is a trade with no floor at all.
    const quote = snap({ priceBaseUnits: '1' + '0'.repeat(40) });
    expect(BigInt(minOutFor('1', quote, 10_000))).toBeGreaterThan(0n);
  });
});
