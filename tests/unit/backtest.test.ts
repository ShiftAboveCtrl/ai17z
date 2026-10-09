import { describe, expect, it } from 'vitest';
import { FILL_MODEL_VERSION, runBacktest, type Candle } from '@xbam/runtime';

/**
 * Backtests: a written-down rule replayed over recorded candles.
 *
 * The property everything else rests on is that no decision can see the
 * future. Each test here that is about prices is built so that peeking would
 * give a different number.
 */

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 1);

/** Candles with distinct opens and closes, so a fill at the wrong one gives a different answer. */
function candles(closes: number[], openOf: (i: number, close: number) => number = (i, close) => close * 1.01): Candle[] {
  return closes.map((close, i) => ({
    at: new Date(T0 + i * HOUR).toISOString(),
    open: String(openOf(i, close)),
    high: String(close * 1.02),
    low: String(close * 0.98),
    close: String(close),
    volume: '1000',
  }));
}

const NO_COSTS = { feeBps: 0, slippageBps: 0 };

describe('no decision sees the future', () => {
  it('fills at the next open, never at the close that triggered it', () => {
    const series = candles([100, 200, 300], (i) => [101, 202, 303][i]!);
    const result = runBacktest({ candles: series, rule: { kind: 'PERIODIC_BUY', spend: 100, everyCandles: 1 }, costs: NO_COSTS });
    // Decided at candle 0's close of 100, filled at candle 1's open of 202.
    expect(result.trades[0]).toMatchObject({ decidedAt: series[0]!.at, filledAt: series[1]!.at, price: 202 });
    expect(result.trades[1]).toMatchObject({ price: 303 });
  });

  it('never trades on the last candle, which has no next open', () => {
    const result = runBacktest({ candles: candles([100, 100, 100]), rule: { kind: 'PERIODIC_BUY', spend: 10, everyCandles: 1 }, costs: NO_COSTS });
    expect(result.trades).toHaveLength(2);
  });

  it('computes a moving average from candles up to the decision, not after it', () => {
    // A crash on the last candle must not make an earlier candle look like a dip.
    const series = candles([100, 100, 100, 100, 100, 10]);
    const result = runBacktest({
      candles: series,
      rule: { kind: 'DIP_AND_TARGET', spend: 100, averageOf: 3, buyBelowBps: 500, sellAboveBps: 1_000 },
      costs: NO_COSTS,
    });
    expect(result.trades).toHaveLength(0);
  });

  it('replays candles oldest first however they arrive', () => {
    const series = candles([100, 110, 120, 130]);
    const forward = runBacktest({ candles: series, rule: { kind: 'PERIODIC_BUY', spend: 100, everyCandles: 1 }, costs: NO_COSTS });
    const shuffled = runBacktest({ candles: [...series].reverse(), rule: { kind: 'PERIODIC_BUY', spend: 100, everyCandles: 1 }, costs: NO_COSTS });
    expect(shuffled.trades).toEqual(forward.trades);
    expect(shuffled.history.from).toBe(series[0]!.at);
  });
});

describe('what a rule did', () => {
  it('buys on schedule and marks what it holds at the last close', () => {
    const series = candles([100, 100, 100, 100, 200], (_, close) => close);
    const result = runBacktest({ candles: series, rule: { kind: 'PERIODIC_BUY', spend: 100, everyCandles: 2 }, costs: NO_COSTS });
    // Decides at candles 0 and 2, fills at the opens of 1 and 3, both 100.
    expect(result.trades).toHaveLength(2);
    expect(result.spent).toBe(200);
    expect(result.held).toBeCloseTo(2);
    // Two units at 200 is 400, against 200 spent.
    expect(result.pnl).toBeCloseTo(200);
    expect(result.returnBps).toBe(10_000);
  });

  it('buys a dip below the average and sells at the target above the price paid', () => {
    const closes = [100, 100, 100, 90, 90, 120, 120];
    const series = candles(closes, (_, close) => close);
    const result = runBacktest({
      candles: series,
      rule: { kind: 'DIP_AND_TARGET', spend: 90, averageOf: 3, buyBelowBps: 500, sellAboveBps: 2_000 },
      costs: NO_COSTS,
    });
    // The dip at candle 3 buys at candle 4's open of 90; 120 is past the target of 108.
    expect(result.trades.map((t) => t.side)).toEqual(['BUY', 'SELL']);
    expect(result.held).toBe(0);
    expect(result.received).toBeGreaterThan(result.spent);
  });

  it('charges the stated fee and slippage, which can only lower the result', () => {
    const series = candles([100, 100, 100, 120], (_, close) => close);
    const rule = { kind: 'PERIODIC_BUY' as const, spend: 100, everyCandles: 1 };
    const free = runBacktest({ candles: series, rule, costs: NO_COSTS });
    const costly = runBacktest({ candles: series, rule, costs: { feeBps: 30, slippageBps: 50 } });
    expect(costly.pnl).toBeLessThan(free.pnl);
    expect(costly.fees).toBeCloseTo(0.9);
  });

  it('measures a fall in the marked result against what had been put in', () => {
    const series = candles([100, 100, 50, 50], (_, close) => close);
    const result = runBacktest({ candles: series, rule: { kind: 'PERIODIC_BUY', spend: 100, everyCandles: 3 }, costs: NO_COSTS });
    // One unit bought at 100, marked at 50: half of what was spent.
    expect(result.maxDrawdownBps).toBe(5_000);
  });

  it('compares with holding the same total from the first fill', () => {
    const series = candles([100, 100, 150, 150, 200], (_, close) => close);
    const result = runBacktest({ candles: series, rule: { kind: 'PERIODIC_BUY', spend: 100, everyCandles: 1 }, costs: NO_COSTS });
    // Holding 400 spent at 100 from the first fill, marked at 200, doubles.
    expect(result.holdReturnBps).toBe(10_000);
    expect(result.returnBps!).toBeLessThan(result.holdReturnBps!);
  });
});

describe('what a result says about itself', () => {
  it('is labelled simulated, names its fill model and its history', () => {
    const series = candles([100, 101, 102]);
    const result = runBacktest({ candles: series, rule: { kind: 'PERIODIC_BUY', spend: 1, everyCandles: 1 }, costs: NO_COSTS });
    expect(result.simulated).toBe(true);
    expect(result.fillModel).toBe(FILL_MODEL_VERSION);
    expect(result.history).toEqual({ candles: 3, from: series[0]!.at, to: series[2]!.at });
    expect(result.caveats.join(' ')).toMatch(/too few/);
  });

  it('says so when the rule never traded', () => {
    const result = runBacktest({
      candles: candles(Array.from({ length: 20 }, () => 100)),
      rule: { kind: 'DIP_AND_TARGET', spend: 1, averageOf: 5, buyBelowBps: 500, sellAboveBps: 500 },
      costs: NO_COSTS,
    });
    expect(result.returnBps).toBeNull();
    expect(result.caveats.join(' ')).toMatch(/never traded/);
  });

  it('refuses a candle with a price that is not a positive number', () => {
    const series = candles([100, 100]);
    series[1] = { ...series[1]!, open: '0' };
    expect(() => runBacktest({ candles: series, rule: { kind: 'PERIODIC_BUY', spend: 1, everyCandles: 1 }, costs: NO_COSTS })).toThrow(/not a positive number/);
  });
});
