import { describe, expect, it } from 'vitest';
import { renderEvidenceMove, safeShortAddress, MOVE_CAUSE_LINE, type MoveReport } from '@xbam/prompts';
import { evidenceMoveRequest } from '../../packages/runtime/src/research';
import { buildMoveReport, medianPriced, moveCurrent, type EarlierRead, type MoveInputs } from '../../packages/runtime/src/mintMovement';
import { pairFrom } from '../../packages/runtime/src/marketIntelCapabilities';

const mint = 'So11111111111111111111111111111111111111112';
const other = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BANNED = /\b(?:pump|pumps|pumping|dump|dumps|dumping|because|due to|driven by|whales?|manipulation|will|expected)\b/i;
const NOW = new Date('2026-11-15T12:00:00.000Z');

function rawPair(over: Record<string, unknown> = {}) {
  return {
    chainId: 'solana', dexId: 'raydium', pairAddress: 'PoolPoolPoolPoolPoolPoolPoolPoolPoolPool1',
    baseToken: { address: mint, name: 'Wrapped', symbol: 'W' }, quoteToken: { address: other, name: 'Cash', symbol: 'C' },
    priceUsd: '1.5', liquidity: { usd: 120000 }, pairCreatedAt: NOW.getTime() - 30 * 86_400_000,
    txns: { m5: { buys: 5, sells: 5 }, h1: { buys: 60, sells: 40 }, h6: { buys: 200, sells: 100 }, h24: { buys: 600, sells: 400 } },
    volume: { m5: 1000, h1: 50000, h6: 100000, h24: 300000 },
    priceChange: { m5: 1, h1: 25, h6: -10, h24: 5 }, ...over,
  };
}
const pairs = (...raw: Record<string, unknown>[]) => raw.map(r => pairFrom(rawPair(r))!);

function inputs(over: Partial<MoveInputs> = {}): MoveInputs {
  return { window: '1h', chain: 'solana', address: mint, pairs: pairs({}), pairsSource: 'market_pairs.dexscreener',
    pairsFetchedAt: NOW.toISOString(), trades: null, tradesSource: null, tradesFetchedAt: null, earlier: null, now: NOW, ...over };
}
const figure = (report: MoveReport, label: string) => report.figures.find(f => f.label === label)!;

describe('evidenceMoveRequest', () => {
  it('reads one exact mint and defaults the window to one hour', () => {
    expect(evidenceMoveRequest(`why is ${mint} moving`)).toEqual({ address: mint, chain: 'solana', window: '1h' });
    expect(evidenceMoveRequest(`@agent what happened to ${mint}?`)).toEqual({ address: mint, chain: 'solana', window: '1h' });
  });
  it('takes the window the asker named', () => {
    expect(evidenceMoveRequest(`why is ${mint} up in the last 5 minutes`)).toMatchObject({ window: '5m' });
    expect(evidenceMoveRequest(`why is ${mint} down over 6 hours`)).toMatchObject({ window: '6h' });
    expect(evidenceMoveRequest(`why is ${mint} up today`)).toMatchObject({ window: '24h' });
    expect(evidenceMoveRequest(`why is ${mint} moving in the last hour`)).toMatchObject({ window: '1h' });
  });
  it('refuses a window the source does not report instead of rounding it', () => {
    expect(evidenceMoveRequest(`why is ${mint} down in the last 3 hours`)).toEqual({ refusal: expect.stringMatching(/^I read windows of .+\.$/) });
    expect(evidenceMoveRequest(`why is ${mint} up in 30 min`)).toEqual({ refusal: expect.stringMatching(/windows of/) });
  });
  it('refuses a ticker and an unnamed EVM chain with a sentence', () => {
    for (const text of ['why is $BONK pumping', 'why is 0x1111111111111111111111111111111111111111 moving']) {
      expect(evidenceMoveRequest(text), text).toEqual({ refusal: expect.stringMatching(/^Please .+\.$/) });
    }
  });
  it('is not the ask for ordinary speech or for a plain card', () => {
    expect(evidenceMoveRequest('why is it down')).toBeNull();
    expect(evidenceMoveRequest(`check ${mint}`)).toBeNull();
    expect(evidenceMoveRequest('why is the sky up there so blue')).toBeNull();
  });
});

describe('buildMoveReport and renderEvidenceMove', () => {
  it('shows then, now and change with source and time, and the pool depth beside the percent', () => {
    const report = buildMoveReport(inputs());
    const text = renderEvidenceMove(report);
    expect(figure(report, 'Price')).toMatchObject({ now: 1.5, changePct: 25 });
    expect(figure(report, 'Price').then).toBeCloseTo(1.2, 6);
    expect(text).toMatch(/Price: then 1\.2 USD \| now 1\.5 USD \| change \+25\.0% \| pool depth 120000 USD \[market_pairs\.dexscreener; fetched 2026-11-15T12:00:00\.000Z; then derived from the source's own 1h change figure\]/);
    // (long - this) / (ratio - 1): (100000 - 50000) / 5 = 10000 an hour before, so +400%.
    expect(text).toMatch(/Volume 1h: then 10000 USD \| now 50000 USD \| change \+400\.0%/);
    expect(text).toContain('Trades 1h: then 40 trades | now 100 trades | change +150.0%');
    expect(text).toContain(MOVE_CAUSE_LINE);
    expect(text).toContain('not a verdict, reads can be wrong');
  });

  it('says "no earlier reading" and omits the change, never 0%, when there is no "then"', () => {
    const report = buildMoveReport(inputs());
    const liquidity = figure(report, 'Liquidity');
    expect(liquidity).toMatchObject({ then: null, now: 120000, changePct: null });
    const text = renderEvidenceMove(report);
    expect(text).toContain('Liquidity: then no earlier reading | now 120000 USD | change omitted');
    expect(text).not.toMatch(/Liquidity:.*0(\.0)?%/);
  });

  it('has no earlier volume for the 24h window and no price then when the source sent no change figure', () => {
    const wide = buildMoveReport(inputs({ window: '24h' }));
    expect(figure(wide, 'Volume 24h')).toMatchObject({ then: null, changePct: null });
    const none = buildMoveReport(inputs({ pairs: pairs({ priceChange: { m5: null, h1: null, h6: null, h24: null } }) }));
    expect(figure(none, 'Price')).toMatchObject({ then: null, changePct: null });
    expect(renderEvidenceMove(none)).toContain('Price: then no earlier reading');
  });

  it('uses a stored reading from this installation for the same pool and source, and not one from another pool or source', () => {
    const earlier: EarlierRead = { readAt: '2026-11-15T11:00:00.000Z', poolAddress: 'PoolPoolPoolPoolPoolPoolPoolPoolPoolPool1',
      source: 'market_pairs.dexscreener', liquidityUsd: 100000, volume: { m5: null, h1: 20000, h6: null, h24: null } };
    const report = buildMoveReport(inputs({ earlier }));
    expect(figure(report, 'Liquidity')).toMatchObject({ then: 100000, changePct: 20 });
    expect(figure(report, 'Volume 1h')).toMatchObject({ then: 20000, changePct: 150 });
    expect(renderEvidenceMove(report)).toContain('then an earlier reading at 2026-11-15T11:00:00.000Z');
    for (const wrong of [{ ...earlier, poolAddress: 'someOtherPool' }, { ...earlier, source: 'market_pairs.other' }]) {
      expect(figure(buildMoveReport(inputs({ earlier: wrong })), 'Liquidity').then).toBeNull();
    }
  });

  it('keeps a zero "then" as a measurement but shows no percent for it', () => {
    const earlier: EarlierRead = { readAt: '2026-11-15T11:00:00.000Z', poolAddress: 'PoolPoolPoolPoolPoolPoolPoolPoolPoolPool1',
      source: 'market_pairs.dexscreener', liquidityUsd: 0, volume: { m5: null, h1: null, h6: null, h24: null } };
    expect(figure(buildMoveReport(inputs({ earlier })), 'Liquidity')).toMatchObject({ then: 0, changePct: null });
  });

  it('prints an absent figure as unavailable, never zero', () => {
    const report = buildMoveReport(inputs({ pairs: pairs({ volume: { m5: null, h1: null, h6: null, h24: null }, txns: {} }) }));
    const text = renderEvidenceMove(report);
    expect(text).toContain('Volume 1h: then no earlier reading | now unavailable | change omitted');
    expect(text).toContain('Trades 1h: then no earlier reading | now unavailable | change omitted');
  });

  it('chooses the pool nearest the median price, never the deepest', () => {
    const thin = { pairAddress: 'ThinPoolThinPoolThinPoolThinPool111', priceUsd: '1.5', liquidity: { usd: 20000 } };
    const deepWrong = { pairAddress: 'DeepWrongDeepWrongDeepWrongDeep11', priceUsd: '5000', liquidity: { usd: 9_000_000 } };
    const alsoMid = { pairAddress: 'MidPoolMidPoolMidPoolMidPoolMid1111', priceUsd: '1.49', liquidity: { usd: 50000 } };
    const chosen = medianPriced(pairs(thin, deepWrong, alsoMid));
    expect(chosen?.pairAddress).not.toBe('DeepWrongDeepWrongDeepWrongDeep11');
    expect(buildMoveReport(inputs({ pairs: pairs(thin, deepWrong, alsoMid) })).pool).toMatchObject({ pools: 3 });
  });

  it('reports a new pool created inside the window, and none when there is none', () => {
    const fresh = { pairAddress: 'FreshPoolFreshPoolFreshPoolFresh111', pairCreatedAt: NOW.getTime() - 10 * 60_000, dexId: 'orca' };
    const withNew = buildMoveReport(inputs({ pairs: pairs({}, fresh) }));
    expect(withNew.newPools).toMatchObject({ count: 1, pools: 2 });
    expect(renderEvidenceMove(withNew)).toMatch(/New pools for this mint: 1 created in the window: Fres….+ \(orca\) at 2026-11-15T11:50:00\.000Z/);
    expect(renderEvidenceMove(buildMoveReport(inputs()))).toContain('New pools for this mint: none among 1 pools read');
  });

  it('counts swap sizes inside the window and says when the latest swaps did not reach back to its start', () => {
    const at = (minutesAgo: number, usd: number | null, i: number) => ({ at: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
      side: 'buy' as const, volumeUsd: usd, priceUsd: 1, tokenAmount: '1', wallet: null, txHash: `tx${i}`, block: null });
    const trades = [at(5, 50, 1), at(10, 500, 2), at(20, 5000, 3), at(30, null, 4), at(90, 10, 5)];
    const report = buildMoveReport(inputs({ trades, tradesSource: 'geckoterminal', tradesFetchedAt: NOW.toISOString() }));
    expect(report.sizeBands).toMatchObject({ small: 1, mid: 1, large: 1, unsized: 1, swaps: 4, coversWindow: true });
    const hundred = Array.from({ length: 100 }, (_, i) => at(1 + i * 0.1, 50, i));
    expect(buildMoveReport(inputs({ trades: hundred, tradesSource: 'g', tradesFetchedAt: NOW.toISOString() })).sizeBands?.coversWindow).toBe(false);
    expect(renderEvidenceMove(buildMoveReport(inputs()))).toContain('Swap sizes: unavailable');
  });

  it('flags a thin pool beside the percents', () => {
    const text = renderEvidenceMove(buildMoveReport(inputs({ pairs: pairs({ liquidity: { usd: 800 } }) })));
    expect(text).toContain('thin pool: a small trade moves these percents a long way');
    expect(text).toMatch(/pool depth 800 USD/);
  });

  it('says evidence was not found, with no figure, when no pool prices the mint', () => {
    const report = buildMoveReport(inputs({ pairs: [] }));
    expect(report.pool).toBeNull();
    expect(renderEvidenceMove(report)).toContain('evidence not found: no market pool was read for this mint');
  });

  it('never prints a banned word, from the template or from a dex name', () => {
    const lively = { dexId: 'pumpswap', pairAddress: 'PumpPoolPumpPoolPumpPoolPumpPool1111' };
    for (const input of [inputs(), inputs({ pairs: pairs(lively) }), inputs({ pairs: [] }), inputs({ window: '24h' })]) {
      const text = renderEvidenceMove(buildMoveReport(input));
      expect(text).not.toMatch(BANNED);
      expect(text).not.toMatch(/[–—]| - | -- /);
    }
    expect(renderEvidenceMove(buildMoveReport(inputs({ pairs: pairs(lively) })))).not.toContain('pumpswap');
  });

  it('never lets a shortened address spell a banned word', () => {
    expect(safeShortAddress('9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump')).not.toMatch(/pump/i);
    expect(safeShortAddress(mint)).toBe('So11…1112');
  });

  it('is current only while every reading is inside five minutes', () => {
    const report = buildMoveReport(inputs());
    expect(moveCurrent(report, NOW.getTime() + 60_000)).toBe(true);
    expect(moveCurrent(report, NOW.getTime() + 6 * 60_000)).toBe(false);
    expect(moveCurrent({ ...report, fetchedAt: null }, NOW.getTime())).toBe(false);
  });
});

describe('a move ask naming two mints', () => {
  it('is left to the compare path rather than refused', () => {
    expect(evidenceMoveRequest(`why is ${mint} vs ${other} moving on solana`)).toBeNull();
    expect(evidenceMoveRequest(`why is ${mint} moving on solana`)).toMatchObject({ address: mint, window: '1h' });
  });
});
