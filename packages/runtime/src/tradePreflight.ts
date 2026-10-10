import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AssetRef, BaseUnits, TRADE_VENUE_IDS, TradeMandate, TradeSide, assetKey } from '@xbam/shared/contracts';
import { readMarket } from './marketData';
import { minOutFor, type PricedSide } from './paperTrading';
import { judgeTrade, type RiskReason } from './tradingRisk';
import { sideAgrees } from './paperPositions';

/**
 * Would this trade pass, asked before anything is written down.
 *
 * The trade-intent firewall: an agent somewhere else describes a trade and
 * the mandate it is acting under, and this reads the market for the exact
 * assets and runs **the same risk gate** a real trade passes through, with
 * the same arithmetic for the floor it would ask for. It journals nothing,
 * creates nothing and signs nothing; the answer is a verdict with every
 * reason, and the quote it was judged against.
 *
 * One assumption is stated rather than hidden: a real trade must also pass a
 * simulation, which a preflight does not run, so the gate is asked as though
 * that simulation had succeeded. The result says so.
 *
 * Signing is somebody else's step, after this, and never here.
 */

export const TradePreflightInput = z
  .object({
    venue: z.enum(TRADE_VENUE_IDS),
    side: TradeSide,
    assetIn: AssetRef,
    assetOut: AssetRef,
    /** The asset whose venue state is read: one of the two being traded. */
    subject: AssetRef,
    maxIn: BaseUnits,
    maxSlippageBps: z.number().int().min(0).max(10_000),
    maxPriceImpactBps: z.number().int().min(0).max(10_000),
    maxFeeBase: BaseUnits,
    /** The caller's own mandate, without the ids a stored one carries. */
    mandate: TradeMandate.omit({ id: true, agentId: true }),
    /** What the caller has already committed. Absent is taken as nothing, and the result says so. */
    exposure: z
      .object({ spentTodayBase: BaseUnits.or(z.literal('0')), openExposureBase: BaseUnits.or(z.literal('0')), openPositions: z.number().int().min(0) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (assetKey(v.assetIn) === assetKey(v.assetOut)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A trade is one asset for a different one.' });
    if (assetKey(v.subject) !== assetKey(v.assetIn) && assetKey(v.subject) !== assetKey(v.assetOut)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'The asset being priced has to be one of the two being traded.', path: ['subject'] });
    }
    else if (!sideAgrees(v.side, v.assetIn, v.assetOut, v.subject)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'The side does not agree with the assets: a BUY spends another asset to get the subject, a SELL spends the subject.', path: ['side'] });
    }
  });
export type TradePreflightInput = z.infer<typeof TradePreflightInput>;

export interface TradePreflight {
  verdict: 'ALLOW' | 'APPROVAL_REQUIRED' | 'DENY';
  reasons: RiskReason[];
  /** What the market said, when it said anything. */
  quote: unknown;
  /** The least that would be asked to arrive, at that quote and the slippage ceiling. */
  minOut: string | null;
  assumptions: string[];
}

export async function preflightTrade(raw: TradePreflightInput, now: Date = new Date()): Promise<TradePreflight> {
  const input = TradePreflightInput.parse(raw);
  const assumptions = ['The gate was asked as though the simulation a real trade must pass had succeeded; a preflight does not run one.'];
  if (!input.exposure) assumptions.push('No exposure was given, so nothing already spent today or already open was counted.');
  if (input.side === 'SELL') {
    assumptions.push('What is held was not checked: a preflight has no journal. A sale of more than is held is refused when it is placed.');
  }

  const counterparty = assetKey(input.assetIn) === assetKey(input.subject) ? input.assetOut : input.assetIn;
  const spending: PricedSide = assetKey(input.assetIn) === assetKey(input.subject) ? 'ASSET' : 'QUOTE';
  const read = await readMarket(input.subject, input.venue, counterparty);
  if (read.outcome !== 'OK') {
    return { verdict: 'DENY', reasons: [{ code: 'NO_MARKET', detail: read.detail }], quote: null, minOut: null, assumptions };
  }

  const minOut = minOutFor(input.maxIn, read.snapshot, input.maxSlippageBps, spending);
  const agentId = randomUUID();
  const mandateId = randomUUID();
  const verdict = judgeTrade({
    intent: {
      id: randomUUID(),
      agentId,
      mandateId,
      mode: input.mandate.mode,
      venue: input.venue,
      network: read.snapshot.network,
      side: input.side,
      assetIn: input.assetIn,
      assetOut: input.assetOut,
      maxIn: input.maxIn,
      minOut,
      maxSlippageBps: input.maxSlippageBps,
      maxPriceImpactBps: input.maxPriceImpactBps,
      maxFeeBase: input.maxFeeBase,
      quote: read.snapshot,
      expiresAt: new Date(now.getTime() + input.mandate.quoteMaxAgeMs).toISOString(),
      status: 'SIMULATED',
      idempotencyKey: `preflight-${mandateId}`,
      createdAt: now.toISOString(),
    } as never,
    mandate: { ...input.mandate, id: mandateId, agentId } as never,
    fresh: read.snapshot,
    exposure: input.exposure ?? { spentTodayBase: '0', openExposureBase: '0', openPositions: 0 },
    pausedScopes: [],
    simulated: true,
    // The instant the verdict is reached, after the read, for the reason the
    // paper engine learned: a quote fetched during this call is not from the future.
    now: new Date(),
  });

  return {
    verdict: !verdict.allowed ? 'DENY' : verdict.needsOwnerApproval ? 'APPROVAL_REQUIRED' : 'ALLOW',
    reasons: verdict.reasons,
    quote: read.snapshot,
    minOut,
    assumptions,
  };
}
