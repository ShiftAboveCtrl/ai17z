import { trading } from '@xbam/database';
import type { TradeIntentRow, TradeMandateRow } from '@xbam/database';
import { TradeIntent, TradeMandate, type MarketSnapshot, type TradePauseScope } from '@xbam/shared/contracts';
import { judgeTrade, type RiskVerdict } from './tradingRisk';

/**
 * The gate, asked about a trade that is already written down.
 *
 * `judgeTrade` is pure on purpose: it takes an intent, a mandate and the
 * current state, and does arithmetic. This is the part that goes and gets
 * those things, and it is separate so that the arithmetic stays testable
 * without a database and the loading stays testable against one.
 *
 * Two of the inputs are deliberately read here rather than passed in by a
 * caller. The pause scopes are read at the moment of asking, because a pause
 * earns its keep precisely when something was approved earlier and must not
 * go now. Exposure is read the same way, because a limit computed when the
 * trade was proposed is a limit against a world that has moved.
 */

/** Midnight UTC, which is the day a daily limit means. */
function startOfDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Turn stored rows back into the vocabulary, and refuse if they do not parse.
 *
 * A row that cannot be parsed into a `TradeIntent` is not a trade to be judged
 * leniently: it is a row somebody changed underneath the schema, and the
 * answer is to decline rather than to guess what was meant.
 */
export function asIntent(row: TradeIntentRow): TradeIntent {
  return TradeIntent.parse({
    id: row.id,
    agentId: row.agentId,
    mandateId: row.mandateId,
    mode: row.mode,
    venue: row.venue,
    network: row.network,
    side: row.side,
    assetIn: row.assetIn,
    assetOut: row.assetOut,
    maxIn: row.maxIn,
    minOut: row.minOut,
    maxSlippageBps: row.maxSlippageBps,
    maxPriceImpactBps: row.maxPriceImpactBps,
    maxFeeBase: row.maxFeeBase,
    quote: row.quote,
    expiresAt: row.expiresAt,
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
  });
}

export function asMandate(row: TradeMandateRow): TradeMandate {
  return TradeMandate.parse({
    id: row.id,
    agentId: row.agentId,
    mode: row.mode,
    approval: row.approval,
    venues: row.venues,
    networks: row.networks,
    allowedAssets: row.allowedAssets,
    maxPerTrade: row.maxPerTrade,
    maxPerDay: row.maxPerDay,
    maxOpenExposure: row.maxOpenExposure,
    maxOpenPositions: row.maxOpenPositions,
    maxSlippageBps: row.maxSlippageBps,
    maxPriceImpactBps: row.maxPriceImpactBps,
    minLiquidityBase: row.minLiquidityBase,
    maxFeeBase: row.maxFeeBase,
    quoteMaxAgeMs: row.quoteMaxAgeMs,
    expiresAt: row.expiresAt,
    paused: row.paused,
  });
}

export interface StoredTradeQuestion {
  intentRow: TradeIntentRow;
  mandateRow: TradeMandateRow;
  /** State read now, not the snapshot the intent was decided from. */
  fresh: MarketSnapshot;
  simulated?: boolean;
  runtimeId?: string | null;
  now?: Date;
}

/**
 * Everything `judgeTrade` needs about a stored trade, gathered now.
 *
 * Exposed separately from `judgeStoredTrade` so a caller that already has the
 * verdict can show an owner exactly what it was computed against.
 */
export async function judgeTradeInput(q: StoredTradeQuestion) {
  const now = q.now ?? new Date();
  const intent = asIntent(q.intentRow);
  const mandate = asMandate(q.mandateRow);
  const [pausedScopes, exposure] = await Promise.all([
    trading.activePauseScopes({
      agentId: q.intentRow.agentId,
      venue: q.intentRow.venue,
      walletId: q.intentRow.walletId,
      runtimeId: q.runtimeId ?? null,
    }) as Promise<TradePauseScope[]>,
    trading.exposureOf(q.intentRow.agentId, startOfDay(now)),
  ]);
  // The intent being judged is not exposure it has already taken, so its own
  // row is removed from the totals before its size is tested against them.
  const mine = BigInt(q.intentRow.maxIn);
  const counted = ['APPROVED', 'SIMULATED', 'SIGNED', 'SUBMITTED', 'UNKNOWN', 'CONFIRMED'].includes(q.intentRow.status);
  /*
    `spentTodayBase` is a trailing total from the start of today and
    `exposureOf` adds a row to it only when the row was created today. So an
    intent drafted yesterday and judged today must not be subtracted from it:
    doing that understated today's spend by exactly this trade's size and let
    an agent past its daily limit. The open-exposure figure has no such
    window, which is why the two lines are not the same.
  */
  const countedToday = Date.parse(q.intentRow.createdAt) >= startOfDay(now).getTime();
  const withoutMe = counted && q.intentRow.mode === 'LIVE'
    ? {
        spentTodayBase: countedToday
          ? (BigInt(exposure.spentTodayBase) - mine).toString()
          : exposure.spentTodayBase,
        openExposureBase:
          q.intentRow.status === 'CONFIRMED'
            ? exposure.openExposureBase
            : (BigInt(exposure.openExposureBase) - mine).toString(),
        openPositions: q.intentRow.status === 'CONFIRMED' ? exposure.openPositions : exposure.openPositions - 1,
      }
    : exposure;

  return {
    intent,
    mandate,
    fresh: q.fresh,
    exposure: withoutMe,
    pausedScopes,
    simulated: q.simulated ?? q.intentRow.simulation !== null,
    now,
  };
}

/**
 * Ask the gate about a stored trade, and record what it said.
 *
 * The reasons are written onto the row on a refusal, because "why did it not
 * do that" is asked days later and the answer has to have survived.
 */
export async function judgeStoredTrade(q: StoredTradeQuestion): Promise<RiskVerdict> {
  const verdict = judgeTrade(await judgeTradeInput(q));
  if (!verdict.allowed && q.intentRow.status === 'DRAFTED') {
    await trading.transitionIntent(q.intentRow.id, 'DRAFTED', 'RISK_REJECTED', { riskReasons: verdict.reasons });
  }
  return verdict;
}
