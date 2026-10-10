import { assetKey, type AssetRef, type TradeSide } from '@xbam/shared';

/**
 * What a paper journal holds, worked out from its fills.
 *
 * A position is one asset held against one quote asset: bought with USDC is
 * a USDC position, and its cost and profit are in USDC base units. Holding
 * the same token against two quote assets is two positions, because adding a
 * cost in USDC to a cost in WETH is a number with no unit.
 *
 * Average cost, in integers throughout. A sale takes the average cost of what
 * it sold out of the position and books the difference between that and what
 * the sale brought in as realised profit. Division truncates and the
 * remainder stays in the position's cost, so cost is never lost or invented
 * by rounding: what was paid in always equals cost still held plus cost sold.
 *
 * Simulated throughout. These are the consequences of paper fills, not of
 * anything that happened on a chain.
 */

/** One fill as the journal records it. */
export interface PaperFillRecord {
  intentId: string;
  side: TradeSide;
  assetIn: AssetRef;
  assetOut: AssetRef;
  /** What was spent, in the base units of assetIn. */
  inBase: string;
  /** What arrived, in the base units of assetOut. */
  outBase: string;
  at: string;
}

export interface PaperPosition {
  asset: AssetRef;
  quote: AssetRef;
  /** Held now, in the asset's base units. */
  quantityBase: string;
  /** What what is held now cost, in the quote's base units. */
  costBase: string;
  /** Profit or loss already booked by sales, in the quote's base units. May be negative. */
  realizedBase: string;
  buys: number;
  sells: number;
  simulated: true;
}

interface Ledger {
  asset: AssetRef;
  quote: AssetRef;
  qty: bigint;
  cost: bigint;
  realized: bigint;
  buys: number;
  sells: number;
}

/**
 * Positions from fills, oldest first. A sale of more than a position holds
 * sells what it holds and books the rest as nothing: the journal should never
 * contain one, because a paper sale beyond holdings is refused before it
 * fills, but a ledger that went negative would report a short nobody took.
 */
export function paperPositions(fills: readonly PaperFillRecord[]): PaperPosition[] {
  const ledgers = new Map<string, Ledger>();
  const sorted = [...fills].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const fill of sorted) {
    const buying = fill.side === 'BUY';
    const asset = buying ? fill.assetOut : fill.assetIn;
    const quote = buying ? fill.assetIn : fill.assetOut;
    const key = `${assetKey(asset)}|${assetKey(quote)}`;
    const ledger = ledgers.get(key) ?? { asset, quote, qty: 0n, cost: 0n, realized: 0n, buys: 0, sells: 0 };
    const spent = BigInt(fill.inBase);
    const received = BigInt(fill.outBase);
    if (buying) {
      ledger.qty += received;
      ledger.cost += spent;
      ledger.buys += 1;
    } else {
      const sold = spent > ledger.qty ? ledger.qty : spent;
      const costOfSold = ledger.qty === 0n ? 0n : (ledger.cost * sold) / ledger.qty;
      // A sale that sold only part of what it spent is credited only for that part.
      const proceeds = spent === 0n ? 0n : (received * sold) / spent;
      ledger.qty -= sold;
      ledger.cost -= costOfSold;
      ledger.realized += proceeds - costOfSold;
      ledger.sells += 1;
    }
    ledgers.set(key, ledger);
  }
  return [...ledgers.values()].map((l) => ({
    asset: l.asset,
    quote: l.quote,
    quantityBase: l.qty.toString(),
    costBase: l.cost.toString(),
    realizedBase: l.realized.toString(),
    buys: l.buys,
    sells: l.sells,
    simulated: true as const,
  }));
}

/** How much of an asset the journal holds against a quote, in base units. */
export function heldAgainst(positions: readonly PaperPosition[], asset: AssetRef, quote: AssetRef): bigint {
  const found = positions.find((p) => assetKey(p.asset) === assetKey(asset) && assetKey(p.quote) === assetKey(quote));
  return found ? BigInt(found.quantityBase) : 0n;
}

/**
 * Whether a trade's side agrees with its assets. A buy spends the other asset
 * to get the priced one; a sell spends the priced one. A request that says
 * SELL while spending the quote asset would be priced as a buy, so it is
 * refused rather than guessed at.
 */
export function sideAgrees(side: TradeSide, assetIn: AssetRef, assetOut: AssetRef, subject: AssetRef): boolean {
  const subjectKey = assetKey(subject);
  if (assetKey(assetIn) === assetKey(assetOut)) return false;
  return side === 'BUY' ? assetKey(assetOut) === subjectKey : assetKey(assetIn) === subjectKey;
}
