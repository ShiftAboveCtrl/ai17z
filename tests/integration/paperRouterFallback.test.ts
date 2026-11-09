import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trading } from '@xbam/database';
import { AssetRef, type TradeMandate } from '@xbam/shared/contracts';
import { registerMarketReader, resetMarketReadersForTest, runPaperTrade, type MarketReader } from '@xbam/runtime';
import {
  JUPITER_SWAP_FAMILY,
  defineUpstream,
  perSecond,
  registerUpstream,
  resetBreakerForTest,
  resetCacheForTest,
  resetLimiterForTest,
  resetUpstreamsForTest,
  type MarketPairs,
  type MarketQuery,
  type SwapQuoteQuery,
  type SwapQuoteResult,
} from '@xbam/upstream';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * The whole paper path on a Solana token the pool reader does not list.
 *
 * The unit tests pin the snapshot the router builds; this pins what the fill
 * does with it, against the real journal. A price that came from the router
 * has its fee inside it and no depth model behind it, so when the router does
 * not answer at the moment of the fill the trade is NO_MARKET and nothing is
 * filled, never filled from the fee-free depth model. And when it does
 * answer, the fill is the route's own amount and says so.
 */

const WSOL = 'So11111111111111111111111111111111111111112';
const SOL = AssetRef.parse({ kind: 'ONCHAIN', network: 'solana', address: WSOL, decimals: 9 });
const BONK = AssetRef.parse({ kind: 'ONCHAIN', network: 'solana', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5 });
const ORDER = JSON.parse(readFileSync(new URL('../fixtures/jupiter-swap-v2-order.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const ROUTED_POOL = '5YPxToTobawvkbn5rkWKYDhZqHf5v6LAtRLNPGiq6U2A';

/** Which router calls answer: the first `answering` do, every later one fails. */
let answering = Infinity;
let routerCalls = 0;

function router() {
  registerUpstream(
    defineUpstream<SwapQuoteQuery, SwapQuoteResult>({
      id: `${JUPITER_SWAP_FAMILY}.test`,
      family: JUPITER_SWAP_FAMILY,
      name: 'test router',
      description: 'A router that answers a set number of times.',
      origin: 'router.example',
      limit: { concurrentPerProcess: 10, windows: [perSecond(100, { scope: 'MACHINE' })] },
      timeoutMs: 1_000,
      freshMs: 0,
      rank: 1,
      cacheKey: (q) => `${q.inputMint}:${q.outputMint}:${q.amount}:${routerCalls}`,
      async fetch() {
        routerCalls += 1;
        if (routerCalls > answering) throw new Error('the router stopped answering');
        return { order: ORDER };
      },
    }),
  );
  registerUpstream(
    defineUpstream<MarketQuery, MarketPairs>({
      id: 'market_pairs.test',
      family: 'market_pairs',
      name: 'test pair index',
      description: 'One routed pool with depth in SOL.',
      origin: 'pairs.example',
      limit: { concurrentPerProcess: 10, windows: [perSecond(100, { scope: 'MACHINE' })] },
      timeoutMs: 1_000,
      freshMs: 0,
      rank: 1,
      cacheKey: (q) => JSON.stringify(q),
      async fetch() {
        return { pairs: [{ chainId: 'solana', pairAddress: ROUTED_POOL, quoteToken: { address: WSOL }, liquidity: { quote: 5_000 } }] };
      },
    }),
  );
}

const unlisted: MarketReader = { id: 'unlisted', version: '1', venues: ['AMM_POOL_SOLANA'], read: async () => null };

async function agent() {
  const fixture = await createFixture();
  await trading.putMandate({
    agentId: fixture.agentId,
    ownerId: fixture.ownerId,
    mandate: {
      mode: 'PAPER',
      approval: 'OWNER_APPROVES_EACH',
      venues: ['AMM_POOL_SOLANA'],
      networks: ['solana'],
      allowedAssets: [BONK],
      maxPerTrade: '1000000000',
      maxPerDay: '5000000000',
      maxOpenExposure: '4000000000',
      maxOpenPositions: 5,
      maxSlippageBps: 500,
      maxPriceImpactBps: 5_000,
      minLiquidityBase: '1000000000',
      maxFeeBase: '1000000000',
      quoteMaxAgeMs: 30_000,
      expiresAt: null,
      paused: false,
    } as unknown as Omit<TradeMandate, 'id' | 'agentId'>,
  });
  return fixture;
}

const buy = (agentId: string) =>
  runPaperTrade({
    agentId,
    venue: 'AMM_POOL_SOLANA',
    side: 'BUY',
    assetIn: SOL,
    assetOut: BONK,
    subject: BONK,
    maxIn: '10000000',
    maxSlippageBps: 300,
    maxPriceImpactBps: 5_000,
    maxFeeBase: '1000000000',
  });

beforeEach(() => {
  resetUpstreamsForTest();
  resetBreakerForTest();
  resetCacheForTest();
  resetLimiterForTest();
  resetMarketReadersForTest();
  answering = Infinity;
  routerCalls = 0;
  registerMarketReader(unlisted);
  router();
});
afterEach(() => {
  resetUpstreamsForTest();
  resetMarketReadersForTest();
});

describe('a paper trade priced from the router because no listed pool exists', () => {
  it('fills from the route itself and names it', async () => {
    const fixture = await agent();
    const out = await buy(fixture.agentId);
    expect(out.outcome).toBe('FILLED');
    if (out.outcome !== 'FILLED') return;
    expect(out.fill.outBase).toBe(String(ORDER.outAmount));
    expect(out.fill.impactModel).toMatch(/Jupiter route quote for this size/);
    expect(out.fill.at.source).toMatch(/^Jupiter route quote/);
    expect(await trading.paperFillsOf(fixture.agentId)).toHaveLength(1);
  });

  it('is NO_MARKET, with nothing filled, when the router answers both reads and not the fill', async () => {
    const fixture = await agent();
    // Two market reads (the quote and the fresh read at fill) answer; the route at the fill does not.
    answering = 2;
    const out = await buy(fixture.agentId);
    expect(out).toMatchObject({ outcome: 'NO_MARKET', detail: expect.stringMatching(/router did not answer at the fill/) });
    expect(routerCalls).toBeGreaterThanOrEqual(3);
    expect(await trading.paperFillsOf(fixture.agentId)).toHaveLength(0);
  });
});
