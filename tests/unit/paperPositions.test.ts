import { describe, expect, it } from 'vitest';
import { heldAgainst, paperPositions, sideAgrees, type PaperFillRecord } from '@xbam/runtime';
import type { AssetRef } from '@xbam/shared';

/**
 * Positions from paper fills, with WETH (18 decimals) bought and sold for USDC
 * (6 decimals) at prices that are nowhere near one to one, because a bug that
 * survives a 1:1 price is the bug this exists to catch: the first paper
 * engine reported a fill in the wrong asset's units and every 1:1 fixture
 * agreed with it.
 */
const USDC: AssetRef = { kind: 'ONCHAIN', network: 'ethereum', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 };
const WETH: AssetRef = { kind: 'ONCHAIN', network: 'ethereum', address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', decimals: 18 };
const WETH_UPPER: AssetRef = { kind: 'ONCHAIN', network: 'ethereum', address: '0xC02AAA39B223FE8D0A0E5C4F27EAD9083C756CC2', decimals: 18 };

let n = 0;
const fill = (side: 'BUY' | 'SELL', inBase: string, outBase: string): PaperFillRecord => ({
  intentId: `i${(n += 1)}`,
  side,
  assetIn: side === 'BUY' ? USDC : WETH,
  assetOut: side === 'BUY' ? WETH : USDC,
  inBase,
  outBase,
  at: new Date(Date.UTC(2026, 9, 9, 12, n)).toISOString(),
});

describe('paper positions', () => {
  it('buys at two prices and averages the cost', () => {
    // 248.76 USDC for 0.1 WETH, then 255.00 USDC for 0.1 WETH.
    const [p] = paperPositions([fill('BUY', '248760000', '100000000000000000'), fill('BUY', '255000000', '100000000000000000')]);
    expect(p).toMatchObject({ quantityBase: '200000000000000000', costBase: '503760000', realizedBase: '0', buys: 2, sells: 0, simulated: true });
  });

  it('sells half at a higher price and books the profit in the quote units', () => {
    const [p] = paperPositions([
      fill('BUY', '248760000', '100000000000000000'),
      fill('BUY', '255000000', '100000000000000000'),
      // 0.1 WETH sold for 270.10 USDC; average cost of 0.1 WETH is 251.88.
      fill('SELL', '100000000000000000', '270100000'),
    ]);
    expect(p).toMatchObject({ quantityBase: '100000000000000000', costBase: '251880000', realizedBase: '18220000', sells: 1 });
  });

  it('books a loss as a negative number', () => {
    const [p] = paperPositions([fill('BUY', '250000000', '100000000000000000'), fill('SELL', '100000000000000000', '240000000')]);
    expect(p).toMatchObject({ quantityBase: '0', costBase: '0', realizedBase: '-10000000' });
  });

  it('never loses or invents cost to rounding', () => {
    // Three buys whose average does not divide evenly, then sales of odd sizes.
    const fills = [
      fill('BUY', '100000001', '33333333333333333'),
      fill('BUY', '100000003', '33333333333333334'),
      fill('BUY', '99999999', '33333333333333333'),
      fill('SELL', '7777777777777777', '23456789'),
      fill('SELL', '11111111111111111', '33333333'),
    ];
    const [p] = paperPositions(fills);
    const paid = 100000001n + 100000003n + 99999999n;
    const proceeds = 23456789n + 33333333n;
    // What was paid equals cost still held plus cost of what was sold, and
    // realised profit is proceeds minus that sold cost, exactly.
    const soldCost = paid - BigInt(p!.costBase);
    expect(BigInt(p!.realizedBase)).toBe(proceeds - soldCost);
    expect(BigInt(p!.quantityBase)).toBe(100000000000000000n - 7777777777777777n - 11111111111111111n);
  });

  it('never goes short: a sale beyond holdings sells only what is held', () => {
    const [p] = paperPositions([fill('BUY', '250000000', '100000000000000000'), fill('SELL', '200000000000000000', '520000000')]);
    expect(p).toMatchObject({ quantityBase: '0', costBase: '0', realizedBase: '10000000' });
  });

  it('keeps an asset held against two quote assets as two positions', () => {
    const viaNative = { ...fill('BUY', '100000000000000000', '100000000000000000'), assetIn: { kind: 'NATIVE', network: 'ethereum' } as AssetRef };
    const positions = paperPositions([fill('BUY', '250000000', '100000000000000000'), viaNative]);
    expect(positions).toHaveLength(2);
    expect(heldAgainst(positions, WETH, USDC)).toBe(100000000000000000n);
    expect(heldAgainst(positions, WETH_UPPER, USDC)).toBe(100000000000000000n);
    expect(heldAgainst(positions, USDC, WETH)).toBe(0n);
  });

  it('orders fills by time, whatever order they arrive in', () => {
    const buy = fill('BUY', '250000000', '100000000000000000');
    const sell = fill('SELL', '100000000000000000', '260000000');
    expect(paperPositions([sell, buy])).toEqual(paperPositions([buy, sell]));
  });
});

describe('a side that agrees with its assets', () => {
  it('buys the priced asset by spending the other, and sells it by spending it', () => {
    expect(sideAgrees('BUY', USDC, WETH, WETH)).toBe(true);
    expect(sideAgrees('SELL', WETH, USDC, WETH)).toBe(true);
  });

  it('refuses a SELL that spends the quote asset, a BUY that spends the priced one, and a swap of an asset for itself', () => {
    expect(sideAgrees('SELL', USDC, WETH, WETH)).toBe(false);
    expect(sideAgrees('BUY', WETH, USDC, WETH)).toBe(false);
    expect(sideAgrees('BUY', WETH, WETH_UPPER, WETH)).toBe(false);
  });
});
