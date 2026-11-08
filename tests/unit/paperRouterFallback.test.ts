import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROUTER_SOURCE, marketOrRoute, registerMarketReader, resetMarketReadersForTest, routerSnapshot } from '@xbam/runtime';
import type { MarketSnapshot } from '@xbam/shared/contracts';
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

/**
 * A paper trade on a Solana token whose pools the pool reader does not list.
 *
 * Studio's model-led agent made one TAKE in 389 opportunities and it never
 * filled: the pool reader said "does not list this asset" and the engine
 * stopped there, while the router had priced the same token for the agent's
 * readiness check. What is pinned: only NOT_LISTED falls through to the
 * router; the snapshot is the router's price for exactly this trade, with the
 * fee inside it and the source saying so; depth comes only from pools the
 * route really uses and stays null when none can be read; and when the router
 * cannot answer either, both reasons are kept.
 */

const SOL = { kind: 'ONCHAIN' as const, network: 'solana' as const, address: 'So11111111111111111111111111111111111111112', decimals: 9 };
const BONK = { kind: 'ONCHAIN' as const, network: 'solana' as const, address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5 };
const ORDER = JSON.parse(readFileSync(new URL('../fixtures/jupiter-swap-v2-order.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const ROUTED_POOL = '5YPxToTobawvkbn5rkWKYDhZqHf5v6LAtRLNPGiq6U2A';

let routerAsked = 0;
let pairsAsked = 0;

function router(answer: () => Record<string, unknown>) {
  registerUpstream(
    defineUpstream<SwapQuoteQuery, SwapQuoteResult>({
      id: `${JUPITER_SWAP_FAMILY}.test`,
      family: JUPITER_SWAP_FAMILY,
      name: 'test router',
      description: 'A router that answers what it is told to.',
      origin: 'router.example',
      limit: { concurrentPerProcess: 10, windows: [perSecond(100, { scope: 'MACHINE' })] },
      timeoutMs: 1_000,
      freshMs: 0,
      rank: 1,
      cacheKey: (q) => `${q.inputMint}:${q.outputMint}:${q.amount}`,
      async fetch() {
        routerAsked += 1;
        return { order: answer() };
      },
    }),
  );
}

function pairIndex(pairs: unknown[]) {
  registerUpstream(
    defineUpstream<MarketQuery, MarketPairs>({
      id: 'market_pairs.test',
      family: 'market_pairs',
      name: 'test pair index',
      description: 'Pairs as the test wrote them.',
      origin: 'pairs.example',
      limit: { concurrentPerProcess: 10, windows: [perSecond(100, { scope: 'MACHINE' })] },
      timeoutMs: 1_000,
      freshMs: 0,
      rank: 1,
      cacheKey: (q) => JSON.stringify(q),
      async fetch() {
        pairsAsked += 1;
        return { pairs };
      },
    }),
  );
}

/** A pool reader that lists nothing, throws, or answers with a pool of its own. */
function poolReader(answer: 'none' | 'throws' | MarketSnapshot) {
  registerMarketReader({
    id: 'test-pools',
    version: '1',
    venues: ['AMM_POOL_SOLANA'],
    async read() {
      if (answer === 'throws') throw new Error('the pool reader is busy');
      return answer === 'none' ? null : answer;
    },
  } as Parameters<typeof registerMarketReader>[0]);
}

const pair = (pairAddress: string, liquidityQuote: number, quoteAddress = SOL.address) => ({
  chainId: 'solana',
  pairAddress,
  baseToken: { address: BONK.address },
  quoteToken: { address: quoteAddress },
  liquidity: { usd: 1, base: 1, quote: liquidityQuote },
});

const buy = () => marketOrRoute(BONK, 'AMM_POOL_SOLANA', SOL, SOL, BONK, '10000000', 300, 'QUOTE');

beforeEach(() => {
  resetUpstreamsForTest();
  resetBreakerForTest();
  resetCacheForTest();
  resetLimiterForTest();
  resetMarketReadersForTest();
  routerAsked = 0;
  pairsAsked = 0;
});
afterEach(() => {
  resetUpstreamsForTest();
  resetMarketReadersForTest();
});

describe('a paper trade on a token the pool reader does not list', () => {
  it('is priced from the router quote for exactly this trade, with depth from the pools the route uses', async () => {
    poolReader('none');
    router(() => ORDER);
    pairIndex([pair(ROUTED_POOL, 1234.5), pair('SomeOtherPoolTheRouteDoesNotUse11111111111', 999_999)]);
    const read = await buy();
    expect(read.outcome).toBe('OK');
    const snapshot = (read as { snapshot: MarketSnapshot }).snapshot;
    // Spent per whole token received: 10000000 lamports for outAmount at 5 decimals.
    expect(snapshot.priceBaseUnits).toBe(((10_000_000n * 10n ** 5n) / BigInt(ORDER.outAmount as string)).toString());
    expect(snapshot.liquidityBase).toBe((1234.5 * 1e9).toString());
    expect(snapshot.feeMicroBps).toBe(0);
    expect(snapshot.source.startsWith(ROUTER_SOURCE)).toBe(true);
    expect(snapshot.source).toMatch(/fees inside the price/);
    expect(snapshot).toMatchObject({ venue: 'AMM_POOL_SOLANA', phase: 'POOL', atBlock: null, asset: BONK, quoteAsset: SOL });
  });

  it('leaves depth unknown when no pool the route uses is in the index, so the gate refuses rather than passes it', async () => {
    poolReader('none');
    router(() => ORDER);
    pairIndex([pair('SomeOtherPoolTheRouteDoesNotUse11111111111', 999_999), pair(ROUTED_POOL, 50, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')]);
    const read = await buy();
    expect(read.outcome).toBe('OK');
    expect((read as { snapshot: MarketSnapshot }).snapshot.liquidityBase).toBeNull();
  });

  it('keeps both reasons when the router cannot price it either', async () => {
    poolReader('none');
    const read = await buy();
    expect(read).toMatchObject({ outcome: 'NOT_LISTED', detail: expect.stringMatching(/does not list this asset\. The router could not price it either: .*Nothing is registered/) });
  });

  it('never asks the router when the pool reader failed rather than said it lists nothing', async () => {
    poolReader('throws');
    router(() => ORDER);
    expect(await buy()).toMatchObject({ outcome: 'UNAVAILABLE' });
    expect(routerAsked).toBe(0);
  });

  it('never asks the router when the pool reader lists a pool', async () => {
    const listed: MarketSnapshot = {
      venue: 'AMM_POOL_SOLANA',
      network: 'solana',
      asset: BONK,
      quoteAsset: SOL,
      atBlock: '1',
      observedAt: new Date().toISOString(),
      priceBaseUnits: '1000',
      liquidityBase: '1000000000000',
      feeMicroBps: 2_500,
      phase: 'POOL',
      source: 'a listed pool',
    };
    poolReader(listed);
    router(() => ORDER);
    expect(await buy()).toEqual({ outcome: 'OK', snapshot: listed });
    expect(routerAsked).toBe(0);
    expect(pairsAsked).toBe(0);
  });

  it('refuses a router snapshot for anything that is not a swap between two Solana tokens', async () => {
    const WETH = { kind: 'ONCHAIN' as const, network: 'ethereum' as const, address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 };
    router(() => ORDER);
    expect(await routerSnapshot(WETH, SOL, SOL, WETH, '10000000', 300, 'QUOTE', 'AMM_POOL_SOLANA')).toEqual({ gap: 'it is not a swap between two Solana tokens' });
    expect(routerAsked).toBe(0);
  });
});
