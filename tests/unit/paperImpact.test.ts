import { describe, expect, it } from 'vitest';
import { DOCUMENTED_FEE_CEILINGS, feePercentToMicroBps, withImpact } from '@xbam/runtime';
import type { MarketSnapshot } from '@xbam/shared/contracts';

/**
 * A paper fill that knows the market is not infinitely deep. What is pinned:
 * a trade the size of the pool's quote side gets about half what the mid
 * price promises; a small trade gets almost all of it; a pool with no
 * reported depth is not modelled and says so; selling is modelled the same
 * way from the other side; and the documented fee for memecoin pools is the
 * published ceiling, never less.
 */

const SOL = { kind: 'ONCHAIN' as const, network: 'solana' as const, address: 'So11111111111111111111111111111111111111112', decimals: 9 };
const MEME = { kind: 'ONCHAIN' as const, network: 'solana' as const, address: 'MemeMint11111111111111111111111111111111111', decimals: 6 };

function snapshot(liquidityBase: string | null): MarketSnapshot {
  return {
    venue: 'AMM_POOL_SOLANA', network: 'solana', asset: MEME, quoteAsset: SOL, atBlock: null, observedAt: new Date().toISOString(),
    // 0.001 SOL per whole token.
    priceBaseUnits: '1000000', liquidityBase, feeMicroBps: 12_500, phase: 'POOL', source: 'test',
  };
}

describe('price impact in a paper fill', () => {
  // 200 SOL of reported depth: 100 SOL on the quote side.
  const deep = snapshot(String(200n * 10n ** 9n));

  it('gives about half the mid amount for a trade the size of the quote side', () => {
    const spend = 100n * 10n ** 9n;
    const atMid = 100_000n * 10n ** 6n;
    const r = withImpact(atMid, spend, deep, 'QUOTE');
    expect(r.bps).toBe(5000);
    expect(r.out).toBe(atMid / 2n);
    expect(r.model).toMatch(/constant product/);
  });

  it('barely moves for a small trade', () => {
    const spend = 10n ** 8n; // 0.1 SOL
    const r = withImpact(100n * 10n ** 6n, spend, deep, 'QUOTE');
    expect(r.bps).toBeLessThanOrEqual(10);
  });

  it('models a sale from the other side of the pool', () => {
    // Selling tokens worth 100 SOL at the mid price into the same pool.
    const r = withImpact(100n * 10n ** 9n, 100_000n * 10n ** 6n, deep, 'ASSET');
    expect(r.bps).toBe(5000);
  });

  it('does not apply a pool formula to a bonding curve', () => {
    const curve = { ...snapshot(String(200n * 10n ** 9n)), phase: 'CURVE' as const };
    expect(withImpact(500n, 10n, curve, 'QUOTE')).toEqual({ out: 500n, bps: 0, model: 'not modelled for a bonding curve' });
  });

  it('does not model what it cannot, and says so', () => {
    const r = withImpact(500n, 10n, snapshot(null), 'QUOTE');
    expect(r).toEqual({ out: 500n, bps: 0, model: 'no depth reported, so no impact modelled' });
  });

  it('charges memecoin pools the published ceiling', () => {
    expect(feePercentToMicroBps(DOCUMENTED_FEE_CEILINGS['pumpswap']!.percent)).toBe(12_500);
    expect(feePercentToMicroBps(DOCUMENTED_FEE_CEILINGS['pump-fun']!.percent)).toBe(12_500);
    expect(DOCUMENTED_FEE_CEILINGS['raydium']).toBeUndefined();
  });
});
