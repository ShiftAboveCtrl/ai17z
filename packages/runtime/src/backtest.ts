import { z } from 'zod';

/**
 * Replaying a written-down rule against one pool's recorded history.
 *
 * A backtest answers one narrow question: had this exact rule run over these
 * exact candles, under these exact cost assumptions, what would the record
 * show. It is a simulation of a simulation, and every result says so, names
 * the history it read and the cost model it assumed, and carries the version
 * of that model, so two results can be compared only when they are
 * comparable.
 *
 * ### What it refuses to do
 *
 * **Look ahead.** A decision at candle `i` may read candles up to and
 * including `i`, and fills at the *open* of candle `i + 1`. Filling at the
 * close a decision was made from is the classic way a backtest flatters a
 * rule, because the price that triggered the decision is never a price
 * anybody could have traded at once the decision existed. The last candle
 * therefore never trades: there is no next open.
 *
 * **Invent history.** It takes the candles it is given and reports how many
 * there were, from when to when and where they came from. It never
 * interpolates a missing candle or extends a series.
 *
 * **Be a strategy.** A rule is something an owner wrote down. Nothing here
 * proposes one, ranks rules, searches parameters or says a rule is good. A
 * result is a record, and a rule that did well on a hundred candles of one
 * pool has done well on a hundred candles of one pool.
 *
 * Arithmetic is decimal strings in and out and plain numbers inside, because
 * a candle's prices arrive as decimal strings with more precision than a
 * float carries. Ratios and returns are computed in floating point and
 * rounded for display; nothing here is an amount anybody will settle.
 */

/** Bumped whenever the way a fill is assumed changes, so old and new results are never silently compared. */
export const FILL_MODEL_VERSION = 'next-open-v1';

export const Candle = z.object({
  at: z.string(),
  open: z.string(),
  high: z.string(),
  low: z.string(),
  close: z.string(),
  volume: z.string(),
});
export type Candle = z.infer<typeof Candle>;

/** What a rule may say. A closed list: each kind is a rule an owner can read in one sentence. */
export const BacktestRule = z.discriminatedUnion('kind', [
  z
    .object({
      /** Spend the same amount every so many candles, whatever the price. */
      kind: z.literal('PERIODIC_BUY'),
      spend: z.number().positive().max(1e12),
      everyCandles: z.number().int().min(1).max(100),
    })
    .strict(),
  z
    .object({
      /**
       * Buy when the close falls a given fraction below its recent average,
       * and sell everything held when the close rises a given fraction above
       * the average price paid.
       */
      kind: z.literal('DIP_AND_TARGET'),
      spend: z.number().positive().max(1e12),
      averageOf: z.number().int().min(2).max(50),
      buyBelowBps: z.number().int().min(1).max(9_000),
      sellAboveBps: z.number().int().min(1).max(100_000),
    })
    .strict(),
]);
export type BacktestRule = z.infer<typeof BacktestRule>;

export const BacktestCosts = z
  .object({
    /** The pool's own fee, in basis points of what is spent. */
    feeBps: z.number().int().min(0).max(1_000),
    /** How far against the open a fill is assumed to land, in basis points. */
    slippageBps: z.number().int().min(0).max(1_000),
  })
  .strict();
export type BacktestCosts = z.infer<typeof BacktestCosts>;

export interface BacktestTrade {
  /** The candle whose close made the decision. */
  decidedAt: string;
  /** The candle whose open it filled at. */
  filledAt: string;
  side: 'BUY' | 'SELL';
  price: number;
  quoteAmount: number;
  assetAmount: number;
  fee: number;
}

export interface BacktestResult {
  /** Always true, and in the result so a copy of it carries the word. */
  simulated: true;
  fillModel: string;
  history: { candles: number; from: string | null; to: string | null };
  rule: BacktestRule;
  costs: BacktestCosts;
  trades: BacktestTrade[];
  spent: number;
  received: number;
  fees: number;
  /** Units of the asset held at the end. */
  held: number;
  /** What was held, at the last close, plus anything received from sales, less everything spent. */
  pnl: number;
  /** pnl over what was spent, in basis points. Null when nothing was spent. */
  returnBps: number | null;
  /** The largest fall in the marked result from a previous high, against what had been spent by then, in basis points. */
  maxDrawdownBps: number;
  /** Buying with the same total at the first fill and holding, for comparison under the same costs. */
  holdReturnBps: number | null;
  turnover: number;
  /** Things somebody reading the result should know before believing it. */
  caveats: string[];
}

function n(value: string, what: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`A candle's ${what} is not a positive number.`);
  return parsed;
}

const bps = (fraction: number) => Math.round(fraction * 10_000);

/**
 * Runs a rule over candles, oldest first.
 *
 * Candles arriving newest first, which is how the market source sends them,
 * are sorted here rather than trusted: a series replayed backwards is a
 * backtest of a market that never existed.
 */
export function runBacktest(input: { candles: Candle[]; rule: BacktestRule; costs: BacktestCosts }): BacktestResult {
  const rule = BacktestRule.parse(input.rule);
  const costs = BacktestCosts.parse(input.costs);
  const candles = [...input.candles].map((c) => Candle.parse(c)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const caveats: string[] = [
    'Simulated against recorded candles. No order was placed and nothing was signed.',
    'Fills are assumed at the next candle open, moved against you by the stated slippage, less the stated fee. Real fills depend on depth this history does not record.',
  ];
  if (candles.length < 10) caveats.push(`Only ${candles.length} candles: far too few to say anything about a rule.`);

  const trades: BacktestTrade[] = [];
  let spent = 0;
  let received = 0;
  let fees = 0;
  let held = 0;
  let costBasis = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let turnover = 0;

  const buy = (decided: Candle, fill: Candle) => {
    const open = n(fill.open, 'open');
    const price = open * (1 + costs.slippageBps / 10_000);
    const fee = (rule.spend * costs.feeBps) / 10_000;
    const asset = (rule.spend - fee) / price;
    trades.push({ decidedAt: decided.at, filledAt: fill.at, side: 'BUY', price, quoteAmount: rule.spend, assetAmount: asset, fee });
    spent += rule.spend;
    fees += fee;
    held += asset;
    costBasis += rule.spend;
    turnover += rule.spend;
  };
  const sellAll = (decided: Candle, fill: Candle) => {
    const open = n(fill.open, 'open');
    const price = open * (1 - costs.slippageBps / 10_000);
    const gross = held * price;
    const fee = (gross * costs.feeBps) / 10_000;
    trades.push({ decidedAt: decided.at, filledAt: fill.at, side: 'SELL', price, quoteAmount: gross - fee, assetAmount: held, fee });
    received += gross - fee;
    fees += fee;
    turnover += gross;
    held = 0;
    costBasis = 0;
  };

  for (let i = 0; i < candles.length; i += 1) {
    const now = candles[i]!;
    const close = n(now.close, 'close');
    // Marked at this close, from what is known at this close. Drawdown is on
    // the marked result against what had been put in so far, because a rule
    // that keeps buying grows its holding whatever the price does, and a
    // drawdown on the holding's value would read that growth as gains.
    const marked = held * close + received - spent;
    if (marked > peak) peak = marked;
    if (spent > 0) maxDrawdown = Math.max(maxDrawdown, (peak - marked) / spent);

    const next = candles[i + 1];
    // No next open, no fill: the last candle can decide nothing.
    if (next === undefined) break;

    if (rule.kind === 'PERIODIC_BUY') {
      if (i % rule.everyCandles === 0) buy(now, next);
      continue;
    }

    // DIP_AND_TARGET reads only the candles up to and including this one.
    if (i + 1 < rule.averageOf) continue;
    const window = candles.slice(i + 1 - rule.averageOf, i + 1);
    const average = window.reduce((sum, c) => sum + n(c.close, 'close'), 0) / window.length;
    if (held > 0) {
      const averagePaid = costBasis / held;
      if (close >= averagePaid * (1 + rule.sellAboveBps / 10_000)) {
        sellAll(now, next);
        continue;
      }
    }
    if (close <= average * (1 - rule.buyBelowBps / 10_000)) buy(now, next);
  }

  const last = candles.at(-1);
  const lastClose = last ? n(last.close, 'close') : 0;
  const pnl = held * lastClose + received - spent;

  // The comparison: the same total, spent at the first fill this rule made,
  // held to the last close, under the same fee and slippage.
  let holdReturnBps: number | null = null;
  const firstBuy = trades.find((t) => t.side === 'BUY');
  if (firstBuy && spent > 0) {
    const fee = (spent * costs.feeBps) / 10_000;
    const asset = (spent - fee) / firstBuy.price;
    holdReturnBps = bps((asset * lastClose - spent) / spent);
  }
  if (trades.length === 0) caveats.push('The rule never traded on this history, so there is nothing to measure.');

  return {
    simulated: true,
    fillModel: FILL_MODEL_VERSION,
    history: { candles: candles.length, from: candles[0]?.at ?? null, to: last?.at ?? null },
    rule,
    costs,
    trades,
    spent,
    received,
    fees,
    held,
    pnl,
    returnBps: spent > 0 ? bps(pnl / spent) : null,
    maxDrawdownBps: bps(maxDrawdown),
    holdReturnBps,
    turnover,
    caveats,
  };
}
