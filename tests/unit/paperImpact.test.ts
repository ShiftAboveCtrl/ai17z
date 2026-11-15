import { describe, expect, it } from 'vitest';
import { DOCUMENTED_FEE_CEILINGS, curveStatusForQuote, feePercentToMicroBps, withImpact } from '@xbam/runtime';
import type { MarketSnapshot } from '@xbam/shared/contracts';
import { LIVE_CURVE_BASE64 } from '../support/curveFixtures';

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

  it('resolves a curve-phase token to a bonding curve status instead of only saying it is not modelled', async () => {
    const curve = { ...snapshot(String(200n * 10n ** 9n)), phase: 'CURVE' as const };
    // The fill itself stays unmodelled for a curve; the status says where the curve stands.
    expect(withImpact(500n, 10n, curve, 'QUOTE').model).toBe('not modelled for a bonding curve');
    const status = await curveStatusForQuote(curve, {
      read: async () => ({ exists: true, owner: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', data: new Uint8Array(Buffer.from(LIVE_CURVE_BASE64, 'base64')), slot: 1, source: 's', fetchedAt: 'now' }),
    });
    expect(status).toMatchObject({ phase: 'CURVE', recognized: true, platform: 'Pump' });
    expect(status!.statement).toBe('Bonding curve: 59.5% [collected: 23.58 SOL; target: 85 SOL; source: solana.read_bonding_curve]');
    // A curve that is not on a launchpad this knows is said so in words, never as 0%.
    const unknown = await curveStatusForQuote(curve, { read: async () => ({ exists: false, owner: null, data: null, slot: 1, source: 's', fetchedAt: 'now' }) });
    expect(unknown!.statement).toBe('not on a recognized bonding curve');
  });

  it('does not model what it cannot, and says so', () => {
    const r = withImpact(500n, 10n, snapshot(null), 'QUOTE');
    expect(r).toEqual({ out: 500n, bps: 0, model: 'no depth reported, so no impact modelled' });
  });

  it('charges memecoin pools the published ceiling', () => {
    expect(feePercentToMicroBps(DOCUMENTED_FEE_CEILINGS['pumpswap']!.percent)).toBe(12_500);
    expect(feePercentToMicroBps(DOCUMENTED_FEE_CEILINGS['pump-fun']!.percent)).toBe(12_500);
    // Raydium publishes tiers up to 4% and the indexer does not say which product a pool is, so the ceiling is the highest.
    expect(feePercentToMicroBps(DOCUMENTED_FEE_CEILINGS['raydium']!.percent)).toBe(40_000);
    expect(feePercentToMicroBps(DOCUMENTED_FEE_CEILINGS['raydium-clmm']!.percent)).toBe(40_000);
    // A dynamic fee with no published cap has no ceiling to take.
    expect(DOCUMENTED_FEE_CEILINGS['orca']).toBeUndefined();
    expect(DOCUMENTED_FEE_CEILINGS['meteora']).toBeUndefined();
  });
});
