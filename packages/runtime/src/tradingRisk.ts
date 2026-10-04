import {
  TRADE_NO_RESIGN_STATUSES,
  TRADE_VENUES,
  assetKey,
  type AssetRef,
  type MarketSnapshot,
  type TradeIntent,
  type TradeMandate,
  type TradePauseScope,
} from '@xbam/shared/contracts';

/**
 * Whether a trade may proceed, decided without asking a model anything.
 *
 * This is the layer the whole financial design rests on. Above it a model may
 * propose; below it an adapter may sign. Here, and only here, the owner's
 * mandate is compared against what was actually proposed, and the answer is
 * arithmetic rather than judgement. Nothing in this file calls a model, reads
 * the network or signs: given an intent, a mandate and the current state, it
 * says yes or no and why.
 *
 * Every refusal carries its reasons. "Risk score 18" tells nobody anything,
 * and the question an owner asks afterwards is always "why did it not do
 * that", so the reasons are the output and the verdict is a summary of them.
 *
 * All comparisons are on BigInt over base units. There is no floating point in
 * this file, because a rounding error here is somebody's money.
 */

export interface RiskReason {
  /** Short machine-readable cause, for metrics and tests. */
  code: string;
  /** One sentence a person can act on. */
  detail: string;
}

export interface RiskVerdict {
  allowed: boolean;
  /** Present when the trade may proceed but a person must say yes first. */
  needsOwnerApproval: boolean;
  reasons: RiskReason[];
}

export interface ExposureNow {
  /** Already committed today, in the mandate's accounting units. */
  spentTodayBase: string;
  /** Currently at risk across open positions. */
  openExposureBase: string;
  openPositions: number;
}

export interface RiskInput {
  intent: TradeIntent;
  mandate: TradeMandate;
  /** The state read immediately before this decision, not the one on the intent. */
  fresh: MarketSnapshot;
  exposure: ExposureNow;
  /** Scopes currently paused. Read at execution time, never cached with the decision. */
  pausedScopes: readonly TradePauseScope[];
  /** Whether a simulation has run and succeeded for this exact intent. */
  simulated: boolean;
  now: Date;
}

const big = (v: string): bigint => BigInt(v);

/** Basis points of difference between two amounts, rounded away from zero. */
function driftBps(from: bigint, to: bigint): number {
  if (from === 0n) return to === 0n ? 0 : 10_000;
  const delta = to > from ? to - from : from - to;
  return Number((delta * 10_000n) / from);
}

function assetAllowed(asset: AssetRef, allowed: readonly AssetRef[]): boolean {
  const want = assetKey(asset);
  return allowed.some((a) => assetKey(a) === want);
}

/**
 * The deterministic gate.
 *
 * Ordered so that the cheapest and most absolute refusals come first: a pause
 * or an expired mandate is not worth doing arithmetic about. Every check that
 * fails adds a reason, and the checks keep running rather than returning on
 * the first one, because an owner fixing a mandate would rather see all three
 * problems than discover them one run at a time.
 */
export function judgeTrade(input: RiskInput): RiskVerdict {
  const { intent, mandate, fresh, exposure, pausedScopes, simulated, now } = input;
  const reasons: RiskReason[] = [];
  const deny = (code: string, detail: string) => reasons.push({ code, detail });

  // ---- Stops that no amount of arithmetic can argue with ------------------

  if (pausedScopes.length > 0) {
    deny('PAUSED', `Trading is paused at ${pausedScopes.join(', ')}.`);
  }
  if (mandate.paused) {
    deny('MANDATE_PAUSED', 'The mandate itself is paused.');
  }
  if (mandate.expiresAt && Date.parse(mandate.expiresAt) <= now.getTime()) {
    deny('MANDATE_EXPIRED', `The mandate expired at ${mandate.expiresAt}.`);
  }
  if (intent.mandateId !== mandate.id) {
    deny('WRONG_MANDATE', 'This intent was judged against a mandate it does not belong to.');
  }
  if (intent.agentId !== mandate.agentId) {
    deny('WRONG_AGENT', 'The intent and the mandate belong to different agents.');
  }
  if (TRADE_NO_RESIGN_STATUSES.includes(intent.status)) {
    // The window where something irreversible may already exist. Recovery
    // reconciles the identity it has; it never asks for a fresh signature.
    deny('ALREADY_IN_FLIGHT', `An intent at ${intent.status} is reconciled by its identity, never signed again.`);
  }
  if (Date.parse(intent.expiresAt) <= now.getTime()) {
    deny('INTENT_EXPIRED', `The intent expired at ${intent.expiresAt}.`);
  }

  // ---- What was proposed, against what was permitted ----------------------

  if (!mandate.venues.includes(intent.venue)) {
    deny('VENUE_NOT_ALLOWED', `${TRADE_VENUES[intent.venue].label} is not in the mandate.`);
  }
  if (intent.network && !mandate.networks.includes(intent.network)) {
    deny('NETWORK_NOT_ALLOWED', `${intent.network} is not in the mandate.`);
  }
  if (mandate.allowedAssets.length === 0) {
    deny('NO_ASSETS_ALLOWED', 'The mandate allows no assets yet, so nothing can be traded.');
  } else {
    const subject = intent.side === 'BUY' ? intent.assetOut : intent.assetIn;
    if (!assetAllowed(subject, mandate.allowedAssets)) {
      deny('ASSET_NOT_ALLOWED', 'The asset being traded is not in the mandate.');
    }
  }

  // ---- The quote has to still be true -------------------------------------

  if (fresh.venue !== intent.venue) {
    deny('QUOTE_WRONG_VENUE', 'The fresh state is for a different venue than the intent.');
  }
  if (assetKey(fresh.asset) !== assetKey(intent.quote.asset)) {
    deny('QUOTE_WRONG_ASSET', 'The fresh state is for a different asset than the intent was quoted on.');
  }
  if (fresh.phase !== intent.quote.phase) {
    // A curve that graduated between the quote and now is a different venue.
    deny('VENUE_PHASE_CHANGED', `The venue moved from ${intent.quote.phase} to ${fresh.phase} since the quote.`);
  }
  const quoteAgeMs = now.getTime() - Date.parse(fresh.observedAt);
  if (quoteAgeMs > mandate.quoteMaxAgeMs) {
    deny('QUOTE_STALE', `The state is ${quoteAgeMs}ms old and the mandate allows ${mandate.quoteMaxAgeMs}ms.`);
  }
  if (quoteAgeMs < 0) {
    deny('QUOTE_FROM_THE_FUTURE', 'The state claims to have been observed after now.');
  }

  const moved = driftBps(big(intent.quote.priceBaseUnits), big(fresh.priceBaseUnits));
  if (moved > intent.maxSlippageBps) {
    deny('PRICE_MOVED', `The price moved ${moved}bps since the quote and the intent allows ${intent.maxSlippageBps}bps.`);
  }

  // ---- Bounds -------------------------------------------------------------

  if (intent.maxSlippageBps > mandate.maxSlippageBps) {
    deny('SLIPPAGE_ABOVE_MANDATE', `The intent allows ${intent.maxSlippageBps}bps of slippage and the mandate allows ${mandate.maxSlippageBps}bps.`);
  }
  if (intent.maxPriceImpactBps > mandate.maxPriceImpactBps) {
    deny('IMPACT_ABOVE_MANDATE', `The intent allows ${intent.maxPriceImpactBps}bps of price impact and the mandate allows ${mandate.maxPriceImpactBps}bps.`);
  }
  if (big(intent.maxFeeBase) > big(mandate.maxFeeBase)) {
    deny('FEE_ABOVE_MANDATE', 'The intent allows a larger fee than the mandate.');
  }
  if (big(intent.maxIn) > big(mandate.maxPerTrade)) {
    deny('SIZE_ABOVE_MANDATE', 'The trade is larger than the mandate allows for one trade.');
  }
  if (big(exposure.spentTodayBase) + big(intent.maxIn) > big(mandate.maxPerDay)) {
    deny('DAILY_LIMIT', 'This trade would take the day past the mandate daily limit.');
  }
  if (big(exposure.openExposureBase) + big(intent.maxIn) > big(mandate.maxOpenExposure)) {
    deny('EXPOSURE_LIMIT', 'This trade would take open exposure past the mandate limit.');
  }
  if (exposure.openPositions >= mandate.maxOpenPositions) {
    deny('POSITION_LIMIT', `There are already ${exposure.openPositions} open positions and the mandate allows ${mandate.maxOpenPositions}.`);
  }

  // Absent is not zero. A depth nobody could read must fail this, not pass it.
  if (fresh.liquidityBase === null) {
    deny('LIQUIDITY_UNKNOWN', 'The reader could not see the venue depth, so the minimum cannot be shown to be met.');
  } else if (big(fresh.liquidityBase) < big(mandate.minLiquidityBase)) {
    deny('LIQUIDITY_TOO_LOW', 'The venue has less depth than the mandate requires.');
  }

  // ---- Simulation is not optional ----------------------------------------

  if (intent.mode === 'LIVE' && !simulated) {
    deny('NOT_SIMULATED', 'A live trade has to be simulated before it can be signed.');
  }

  // ---- The verdict --------------------------------------------------------

  const allowed = reasons.length === 0;
  // Paper never waits for anybody: it cannot move value, and making an owner
  // approve a simulation teaches them to approve without reading.
  const needsOwnerApproval = allowed && intent.mode === 'LIVE' && mandate.approval === 'OWNER_APPROVES_EACH';

  if (allowed) {
    reasons.push({
      code: 'WITHIN_MANDATE',
      detail: `Inside the mandate, on state ${quoteAgeMs}ms old, with the price ${moved}bps from the quote.`,
    });
  }

  return { allowed, needsOwnerApproval, reasons };
}
