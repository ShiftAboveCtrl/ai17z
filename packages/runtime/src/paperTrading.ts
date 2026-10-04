import { randomUUID } from 'node:crypto';
import { trading } from '@xbam/database';
import type { TradeIntentRow, TradeMandateRow } from '@xbam/database';
import type { AssetRef, MarketSnapshot, TradeSide, TradeVenue } from '@xbam/shared/contracts';
import { readMarket } from './marketData';
import { judgeTradeInput } from './tradingGate';
import { judgeTrade, type RiskVerdict } from './tradingRisk';

/**
 * A trade taken all the way to the signing boundary and deliberately stopped.
 *
 * Paper mode is not a different code path with the risky parts removed: that
 * would prove nothing, because the parts removed are the ones that go wrong.
 * It is the same intent, the same mandate, the same gate, the same fresh read
 * and the same simulation, against real current market data, with one thing
 * missing at the end. The point is that when live is eventually switched on,
 * the only new code between a decision and a chain is the adapter.
 *
 * Nothing here signs, and there is no branch that could. `mode` is forced to
 * PAPER when the intent is created and the terminal state is PAPER_FILLED,
 * which the exposure sum ignores, so a paper trade never consumes a live
 * limit and never appears as money committed.
 *
 * Simulated results are labelled simulated everywhere they are stored. A
 * simulated profit presented as a realised one is the single most misleading
 * thing a trading system can do, so the word is in the column, the status and
 * the shape of the return value.
 */

export interface PaperFill {
  /** Always true. Present so a caller cannot read a fill without seeing it. */
  simulated: true;
  intentId: string;
  /** What the venue said at the moment the fill was assumed. */
  at: MarketSnapshot;
  /** What was spent, in base units, at the quoted price. */
  inBase: string;
  /** What would have arrived, after the fee the snapshot reported. */
  outBase: string;
  feeBase: string;
  /** Hundredths of a basis point the fill moved against the quote. */
  slippageBps: number;
  /** Milliseconds from the quote being read to the fill being assumed. */
  latencyMs: number;
}

export type PaperOutcome =
  | { outcome: 'FILLED'; fill: PaperFill; verdict: RiskVerdict; intent: TradeIntentRow }
  /** The gate refused. The reasons are on the row as well as here. */
  | { outcome: 'REFUSED'; verdict: RiskVerdict; intent: TradeIntentRow }
  /** The venue could not be read, so there was nothing to decide from. */
  | { outcome: 'NO_MARKET'; detail: string };

/**
 * The fee a snapshot reported, applied to an amount.
 *
 * `feeMicroBps` is hundredths of a basis point, so 1_000_000 is all of it.
 * Integer arithmetic throughout: the division happens last and truncates,
 * which under-reports what arrives rather than over-reporting it. Erring
 * towards a worse fill is the right direction for a simulation somebody may
 * decide to trust.
 */
function afterFee(amount: bigint, feeMicroBps: number | null): { out: bigint; fee: bigint } {
  if (!feeMicroBps) return { out: amount, fee: 0n };
  const fee = (amount * BigInt(feeMicroBps)) / 1_000_000n;
  return { out: amount - fee, fee };
}

/**
 * Run one paper trade.
 *
 * Reads the venue twice on purpose. The first read is what the decision is
 * made from and is stored on the intent as its quote; the second is what the
 * trade would actually have executed against, and the gate compares them.
 * That is the same two-read shape a live trade has to have, so paper exercises
 * the staleness rule rather than skipping it.
 */
export async function runPaperTrade(input: {
  agentId: string;
  venue: TradeVenue;
  side: TradeSide;
  assetIn: AssetRef;
  assetOut: AssetRef;
  /** The asset whose venue state is read. For a buy, what is being bought. */
  subject: AssetRef;
  maxIn: string;
  /** Owner's own ceiling for this trade, inside the mandate's. */
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  maxFeeBase: string;
  idempotencyKey?: string;
  now?: Date;
}): Promise<PaperOutcome> {
  const now = input.now ?? new Date();
  const mandate = await trading.liveMandate(input.agentId);
  if (!mandate) return { outcome: 'NO_MARKET', detail: 'This agent has no mandate, so nothing may be traded even on paper.' };

  const quoted = await readMarket(input.subject, input.venue);
  if (quoted.outcome !== 'OK') return { outcome: 'NO_MARKET', detail: quoted.detail };

  // Written down before anything else happens, so a crash here leaves a record
  // of a decision rather than nothing. Paper has no irreversible step, but the
  // ordering is the same as live on purpose: this is the path being proved.
  const { row } = await trading.createIntent({
    agentId: input.agentId,
    mandateId: mandate.id,
    walletId: null,
    // Forced, not taken from a caller. There is no argument that makes this live.
    mode: 'PAPER',
    venue: input.venue,
    network: quoted.snapshot.network,
    side: input.side,
    assetIn: input.assetIn,
    assetOut: input.assetOut,
    maxIn: input.maxIn,
    minOut: minOutFor(input.maxIn, quoted.snapshot, input.maxSlippageBps),
    maxSlippageBps: input.maxSlippageBps,
    maxPriceImpactBps: input.maxPriceImpactBps,
    maxFeeBase: input.maxFeeBase,
    quote: quoted.snapshot,
    expiresAt: new Date(now.getTime() + mandate.quoteMaxAgeMs).toISOString(),
    idempotencyKey: input.idempotencyKey ?? `paper-${input.agentId}-${randomUUID()}`,
  });

  // A simulation, recorded the same way a live one would be, so the gate's
  // mandatory-simulation check is satisfied by having actually done it.
  const simulated = await trading.transitionIntent(row.id, 'DRAFTED', 'SIMULATED', {
    simulation: { simulated: true, pricedAt: quoted.snapshot.observedAt, priceBaseUnits: quoted.snapshot.priceBaseUnits },
  });
  const onRow = simulated ?? row;

  // The second read: what it would have executed against.
  const atFill = await readMarket(input.subject, input.venue);
  if (atFill.outcome !== 'OK') {
    await trading.transitionIntent(onRow.id, 'SIMULATED', 'FAILED', { error: atFill.detail });
    return { outcome: 'NO_MARKET', detail: atFill.detail };
  }

  const verdict = judgeTrade(
    await judgeTradeInput({ intentRow: onRow, mandateRow: mandate as TradeMandateRow, fresh: atFill.snapshot, now }),
  );
  if (!verdict.allowed) {
    const refused = await trading.transitionIntent(onRow.id, 'SIMULATED', 'RISK_REJECTED', { riskReasons: verdict.reasons });
    return { outcome: 'REFUSED', verdict, intent: refused ?? onRow };
  }

  const spent = BigInt(input.maxIn);
  const { out, fee } = afterFee(spent, atFill.snapshot.feeMicroBps);
  const quotePrice = BigInt(onRow.quote.priceBaseUnits);
  const fillPrice = BigInt(atFill.snapshot.priceBaseUnits);
  const moved = quotePrice === 0n ? 0 : Number(((fillPrice > quotePrice ? fillPrice - quotePrice : quotePrice - fillPrice) * 10_000n) / quotePrice);

  const fill: PaperFill = {
    simulated: true,
    intentId: onRow.id,
    at: atFill.snapshot,
    inBase: spent.toString(),
    outBase: out.toString(),
    feeBase: fee.toString(),
    slippageBps: moved,
    latencyMs: Date.parse(atFill.snapshot.observedAt) - Date.parse(onRow.quote.observedAt),
  };

  const filled = await trading.transitionIntent(onRow.id, 'SIMULATED', 'PAPER_FILLED', {
    executedOn: atFill.snapshot,
    postcondition: { ...fill },
  });
  return { outcome: 'FILLED', fill, verdict, intent: filled ?? onRow };
}

/**
 * The least that may arrive, from a quote and a slippage ceiling.
 *
 * Integer arithmetic, and the truncation is deliberate: a `minOut` rounded
 * down asks for slightly less than the ceiling strictly allows, which fails
 * safe. Rounding the other way would let a trade through that the owner's
 * ceiling did not quite permit.
 */
export function minOutFor(maxIn: string, quote: MarketSnapshot, maxSlippageBps: number): string {
  const inBase = BigInt(maxIn);
  const price = BigInt(quote.priceBaseUnits);
  if (price === 0n) return '1';
  // One whole unit of the asset costs `price` quote base units, so this is
  // how many base units of the asset the input buys at the quote.
  const atQuote = (inBase * 10n ** BigInt(decimalsOf(quote.asset))) / price;
  const worst = (atQuote * BigInt(10_000 - maxSlippageBps)) / 10_000n;
  // Never zero: a minOut of nothing is a trade with no floor at all.
  return (worst > 0n ? worst : 1n).toString();
}

function decimalsOf(asset: AssetRef): number {
  if (asset.kind === 'ONCHAIN') return asset.decimals;
  if (asset.kind === 'NATIVE') return 18;
  return 0;
}
