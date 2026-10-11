import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routedOut } from '@xbam/runtime';
import {
  JUPITER_SWAP_FAMILY,
  defineUpstream,
  perSecond,
  registerUpstream,
  resetBreakerForTest,
  resetCacheForTest,
  resetLimiterForTest,
  resetUpstreamsForTest,
  type SwapQuoteQuery,
  type SwapQuoteResult,
} from '@xbam/upstream';

/**
 * A paper fill priced from the route a live swap would be quoted, when both
 * sides are Solana tokens. What is pinned: nothing is asked when it is not a
 * Solana swap; the route's own amount out is what the fill records, with the
 * venues named; and a router that cannot answer is a gap the fill reports,
 * never a failed trade.
 */

const SOL = { kind: 'ONCHAIN' as const, network: 'solana' as const, address: 'So11111111111111111111111111111111111111112', decimals: 9 };
const BONK = { kind: 'ONCHAIN' as const, network: 'solana' as const, address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5 };
const WETH = { kind: 'ONCHAIN' as const, network: 'ethereum' as const, address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 };
const ORDER = JSON.parse(readFileSync(new URL('../fixtures/jupiter-swap-v2-order.json', import.meta.url), 'utf8')) as Record<string, unknown>;

let asked: SwapQuoteQuery[] = [];

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
      async fetch(q) {
        asked.push(q);
        return { order: answer() };
      },
    }),
  );
}

beforeEach(() => {
  resetUpstreamsForTest();
  resetBreakerForTest();
  resetCacheForTest();
  resetLimiterForTest();
  asked = [];
});
afterEach(() => resetUpstreamsForTest());

describe('a routed paper fill', () => {
  it('asks nothing when it is not a Solana swap', async () => {
    router(() => ORDER);
    expect(await routedOut(WETH, SOL, '10000000', 100)).toEqual({ gap: null });
    expect(asked).toHaveLength(0);
  });

  it('records what the route would deliver for exactly this size, and where it would go', async () => {
    router(() => ORDER);
    const routed = await routedOut(SOL, BONK, '10000000', 300);
    expect(routed).toMatchObject({ out: BigInt(ORDER.outAmount as string) });
    expect('model' in routed && routed.model).toMatch(/Jupiter route quote for this size through .*Meteora/);
    expect(asked).toEqual([{ inputMint: SOL.address, outputMint: BONK.address, amount: '10000000', slippageBps: 300 }]);
  });

  it('reports a gap rather than failing when there is no router, or its answer is not this swap', async () => {
    expect(await routedOut(SOL, BONK, '10000000', 300)).toMatchObject({ gap: expect.stringMatching(/Nothing is registered/) });
    router(() => ({ ...ORDER, inAmount: '99' }));
    expect(await routedOut(SOL, BONK, '10000000', 300)).toEqual({ gap: 'the router answered with something that is not a quote for this swap' });
  });
});
