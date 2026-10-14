import { randomUUID } from 'node:crypto';
import { trading, wallets as walletsRepo } from '@xbam/database';
import type { TradeIntentRow, TradeMandateRow } from '@xbam/database';
import { errorMessage, withPatience } from '@xbam/shared';
import { assetKey, type AssetRef, type TradeSide, type TradeVenue } from '@xbam/shared/contracts';
import { JUPITER_SWAP_FAMILY, ask, type SwapQuoteQuery, type SwapQuoteResult } from '@xbam/upstream';
import { pauseState } from './killSwitch';
import { readMarket } from './marketData';
import { swapQuoteFrom } from './marketIntelCapabilities';
import { minOutFor, PAPER_PATIENCE_MS, type PricedSide } from './paperTrading';
import { sideAgrees } from './paperPositions';
import { SWAP_VALID_MS, TRADE_INTENT_KEY_PREFIX } from './walletCore';
import { approveIntent, draftIntent, reconcileIntent, rejectIntent, simulateIntent, submitIntent, walletReadiness } from './walletCore';
import { maySign } from './tradeExecution';
import { judgeTradeInput } from './tradingGate';
import { judgeTrade, type RiskVerdict } from './tradingRisk';

/**
 * A live trade on Solana, from a decision to a transaction that exists once.
 *
 * This is the paper path with the last step put back, and it adds nothing a
 * paper trade does not already go through: the same mandate, the same gate,
 * the same fresh read. Where paper stops, the trade becomes a `SOLANA_SWAP`
 * wallet intent, and from there the wallet's own rules apply unchanged
 * (`solanaSwap.ts`, `walletCore.ts`): the transaction is built by the adapter,
 * judged before anybody is asked, approved by the digest of its exact message,
 * signed once, checked after signing, broadcast once, reconciled by hash.
 *
 * Three things it adds, and why:
 *
 * - **The two records are tied.** The wallet intent's idempotency key is
 *   `trade-intent:<id>`, so one trade can never become two transactions, and
 *   the trade intent names its wallet intent. A wallet state is mirrored onto
 *   the trade, never the other way.
 * - **`maySign` is asked at the moment of sending**, with the mandate and the
 *   pause read then and not when the trade was proposed. A mandate turned back
 *   to paper, a pause, a quote gone stale or a missing signer each stop it with
 *   every reason given.
 * - **There is no autonomous path.** The wallet will not sign anything its
 *   owner did not approve by digest, so a mandate that asks for autonomy is
 *   refused here with that said, rather than quietly treated as approval mode.
 *
 * Going live is the owner's act: nothing in AI17Z makes a mandate LIVE, and
 * this module refuses to propose anything under one that is not.
 */

const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';

export type LiveProposal =
  | { outcome: 'PROPOSED'; tradeIntent: TradeIntentRow; walletIntentId: string; digest: string }
  | { outcome: 'NOT_LIVE' | 'NO_MARKET' | 'SIMULATION_FAILED'; detail: string; tradeIntent?: TradeIntentRow }
  | { outcome: 'REFUSED'; verdict: RiskVerdict; tradeIntent: TradeIntentRow };

function mintOf(asset: AssetRef): { mint: string; decimals: number; symbol: string } | null {
  if (asset.kind === 'NATIVE' && asset.network === 'solana') return { mint: WRAPPED_SOL, decimals: 9, symbol: 'SOL' };
  if (asset.kind === 'ONCHAIN' && asset.network === 'solana') {
    return { mint: asset.address, decimals: asset.decimals, symbol: asset.symbol ?? `${asset.address.slice(0, 4)}…` };
  }
  return null;
}

function walletIntentOf(row: TradeIntentRow): string | null {
  const id = (row.simulation as { walletIntentId?: unknown } | null)?.walletIntentId;
  return typeof id === 'string' ? id : null;
}

/** Why a mandate cannot carry a live trade now, or null when it can. */
function notLive(mandate: TradeMandateRow | null): string | null {
  if (!mandate) return 'This agent has no mandate, so nothing may be traded.';
  if (mandate.mode !== 'LIVE') return 'This agent trades on paper. Only its owner can make its mandate live.';
  if (mandate.approval !== 'OWNER_APPROVES_EACH') {
    return 'This mandate asks for trades without approval, and the wallet signs nothing its owner has not approved, so none is proposed.';
  }
  if (mandate.paused) return 'This mandate is paused.';
  return null;
}

/** A proposal reads the same markets as a paper trade, and is as patient with their budgets. */
export function proposeLiveSwap(input: Parameters<typeof proposeLiveSwapNow>[0]): Promise<LiveProposal> {
  return withPatience(PAPER_PATIENCE_MS, () => proposeLiveSwapNow(input));
}

async function proposeLiveSwapNow(input: {
  agentId: string;
  ownerId: string;
  venue: TradeVenue;
  side: TradeSide;
  assetIn: AssetRef;
  assetOut: AssetRef;
  subject: AssetRef;
  maxIn: string;
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  maxFeeBase: string;
  idempotencyKey?: string;
}): Promise<LiveProposal> {
  // Checked before anything is written, so a bad key cannot leave half a trade behind.
  if (input.idempotencyKey !== undefined && (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200)) {
    throw new Error('An idempotency key is between eight and two hundred characters.');
  }
  if (!sideAgrees(input.side, input.assetIn, input.assetOut, input.subject)) {
    throw new Error('The side does not agree with which asset is spent, so nothing is proposed.');
  }
  const mandate = await trading.liveMandate(input.agentId);
  const why = notLive(mandate);
  if (why) return { outcome: 'NOT_LIVE', detail: why };
  if ((await pauseState()).paused) return { outcome: 'NOT_LIVE', detail: 'Everything is paused, so nothing is proposed.' };
  const from = mintOf(input.assetIn);
  const to = mintOf(input.assetOut);
  if (!from || !to || from.mint === to.mint) return { outcome: 'NO_MARKET', detail: 'A live swap here is between two different Solana tokens.' };

  const counterparty = assetKey(input.assetIn) === assetKey(input.subject) ? input.assetOut : input.assetIn;
  const spending: PricedSide = assetKey(input.assetIn) === assetKey(input.subject) ? 'ASSET' : 'QUOTE';
  const quoted = await readMarket(input.subject, input.venue, counterparty);
  if (quoted.outcome !== 'OK') return { outcome: 'NO_MARKET', detail: quoted.detail };

  // The route a live swap would take, for exactly this amount, never from a cache.
  const query: SwapQuoteQuery = { inputMint: from.mint, outputMint: to.mint, amount: input.maxIn, slippageBps: input.maxSlippageBps };
  let routeFloor: bigint;
  try {
    const answer = await ask<SwapQuoteQuery, SwapQuoteResult>(JUPITER_SWAP_FAMILY, query);
    const quote = swapQuoteFrom(answer.value.order, query, answer.provenance.fetchedAt);
    if (!quote) return { outcome: 'NO_MARKET', detail: 'The router answered with something that is not a quote for this swap.' };
    routeFloor = BigInt(quote.minOut);
  } catch (error) {
    return { outcome: 'NO_MARKET', detail: `No route could be quoted: ${errorMessage(error).slice(0, 160)}` };
  }
  // The stricter of the two floors: what the route promises, and what the owner's slippage allows from the venue's price.
  const ownersFloor = BigInt(minOutFor(input.maxIn, quoted.snapshot, input.maxSlippageBps, spending));
  const minOut = (routeFloor > ownersFloor ? routeFloor : ownersFloor).toString();

  const { row, created } = await trading.createIntent({
    agentId: input.agentId,
    mandateId: mandate!.id,
    walletId: null,
    mode: 'LIVE',
    venue: input.venue,
    network: 'solana',
    side: input.side,
    assetIn: input.assetIn,
    assetOut: input.assetOut,
    maxIn: input.maxIn,
    minOut,
    maxSlippageBps: input.maxSlippageBps,
    maxPriceImpactBps: input.maxPriceImpactBps,
    maxFeeBase: input.maxFeeBase,
    quote: quoted.snapshot,
    expiresAt: new Date(Date.now() + mandate!.quoteMaxAgeMs).toISOString(),
    idempotencyKey: input.idempotencyKey ?? `live-${input.agentId}-${randomUUID()}`,
  });
  if (!created) {
    const walletIntentId = walletIntentOf(row);
    const wallet = walletIntentId ? await walletsRepo.getIntent(walletIntentId) : null;
    return wallet?.digest
      ? { outcome: 'PROPOSED', tradeIntent: row, walletIntentId: wallet.id, digest: wallet.digest }
      : { outcome: 'NOT_LIVE', detail: `This trade was already proposed and is ${row.status}.`, tradeIntent: row };
  }

  // The wallet intent, one per trade by its key, simulated by the adapter and judged by solanaSwap.ts.
  const { intent: drafted } = await draftIntent({
    agentId: input.agentId,
    ownerId: input.ownerId,
    idempotencyKey: `${TRADE_INTENT_KEY_PREFIX}${row.id}`,
    params: {
      kind: 'SOLANA_SWAP',
      network: 'solana',
      inputMint: from.mint,
      outputMint: to.mint,
      amountIn: input.maxIn,
      minOut,
      maxSlippageBps: Math.max(1, Math.min(1_000, input.maxSlippageBps)),
      inputDecimals: from.decimals,
      outputDecimals: to.decimals,
      inputSymbol: from.symbol,
      outputSymbol: to.symbol,
    },
  });
  const simulated = await simulateIntent(drafted.id, input.ownerId);
  if (simulated.status !== 'AWAITING_APPROVAL' || !simulated.digest) {
    const failed = await trading.transitionIntent(row.id, 'DRAFTED', 'FAILED', {
      simulation: { walletIntentId: drafted.id },
      error: simulated.error ?? 'The swap did not simulate.',
    });
    return { outcome: 'SIMULATION_FAILED', detail: simulated.error ?? 'The swap did not simulate.', tradeIntent: failed ?? row };
  }
  const onRow =
    (await trading.transitionIntent(row.id, 'DRAFTED', 'SIMULATED', {
      simulation: { walletIntentId: drafted.id, digest: simulated.digest, simulatedAt: new Date().toISOString() },
    })) ?? row;

  // The gate, on a second fresh read, exactly as paper asks it.
  const fresh = await readMarket(input.subject, input.venue, counterparty);
  if (fresh.outcome !== 'OK') {
    await rejectIntent(drafted.id, input.ownerId).catch(() => undefined);
    const failed = await trading.transitionIntent(onRow.id, 'SIMULATED', 'FAILED', { error: fresh.detail });
    return { outcome: 'NO_MARKET', detail: fresh.detail, tradeIntent: failed ?? onRow };
  }
  const verdict = judgeTrade(await judgeTradeInput({ intentRow: onRow, mandateRow: mandate!, fresh: fresh.snapshot, now: new Date() }));
  if (!verdict.allowed || !verdict.needsOwnerApproval) {
    await rejectIntent(drafted.id, input.ownerId).catch(() => undefined);
    const refused = await trading.transitionIntent(onRow.id, 'SIMULATED', 'RISK_REJECTED', { riskReasons: verdict.reasons });
    return { outcome: 'REFUSED', verdict, tradeIntent: refused ?? onRow };
  }
  const waiting = (await trading.transitionIntent(onRow.id, 'SIMULATED', 'AWAITING_APPROVAL', { riskReasons: verdict.reasons })) ?? onRow;
  return { outcome: 'PROPOSED', tradeIntent: waiting, walletIntentId: drafted.id, digest: simulated.digest };
}

/**
 * Simulates a waiting trade again, for the owner who is looking at it now. A
 * Solana transaction names a blockhash the network forgets in about a minute,
 * so a trade prepared while nobody watched is stale by the time somebody
 * does; this builds and judges the exact transaction afresh, and the owner
 * approves the digest it returns. Nothing about the trade's floor changes: a
 * route that now promises less than it is refused, not loosened.
 */
export async function refreshLiveSwap(tradeIntentId: string, ownerId: string): Promise<{ ok: true; tradeIntent: TradeIntentRow; digest: string } | { ok: false; why: string }> {
  const row = await trading.getIntent(tradeIntentId);
  const walletIntentId = row ? walletIntentOf(row) : null;
  if (!row || !walletIntentId || row.status !== 'AWAITING_APPROVAL') return { ok: false, why: 'That trade is not waiting for approval.' };
  let simulated;
  try {
    simulated = await simulateIntent(walletIntentId, ownerId);
  } catch (error) {
    return { ok: false, why: errorMessage(error) };
  }
  if (simulated.status !== 'AWAITING_APPROVAL' || !simulated.digest) {
    await trading.transitionIntent(row.id, 'AWAITING_APPROVAL', 'FAILED', { error: simulated.error ?? 'The swap no longer simulates.' });
    return { ok: false, why: simulated.error ?? 'The swap no longer simulates.' };
  }
  const updated = await trading.transitionIntent(row.id, 'AWAITING_APPROVAL', 'AWAITING_APPROVAL', {
    simulation: { walletIntentId, digest: simulated.digest, simulatedAt: new Date().toISOString() },
  });
  if (!updated) return { ok: false, why: 'That trade changed while it was being simulated. Look again.' };
  return { ok: true, tradeIntent: updated, digest: simulated.digest };
}

/** The owner says no, or Studio says its agent no longer wants it. Nothing was signed, and now nothing can be. */
export async function withdrawLiveSwap(tradeIntentId: string, ownerId: string, why: string): Promise<TradeIntentRow | null> {
  const row = await trading.getIntent(tradeIntentId);
  const walletIntentId = row ? walletIntentOf(row) : null;
  if (!row || !['DRAFTED', 'SIMULATED', 'AWAITING_APPROVAL'].includes(row.status)) return row;
  if (walletIntentId) await rejectIntent(walletIntentId, ownerId).catch(() => undefined);
  return trading.transitionIntent(row.id, ['DRAFTED', 'SIMULATED', 'AWAITING_APPROVAL'], 'CANCELLED', { error: why });
}

/** The owner approves the trade by approving the digest of its exact transaction. */
export async function approveLiveSwap(tradeIntentId: string, ownerId: string, digest: string): Promise<TradeIntentRow> {
  const row = await trading.getIntent(tradeIntentId);
  const walletIntentId = row ? walletIntentOf(row) : null;
  if (!row || row.status !== 'AWAITING_APPROVAL' || !walletIntentId) throw new Error('That trade is not waiting for approval.');
  await approveIntent(walletIntentId, ownerId, digest, { viaTrade: true });
  const approved = await trading.transitionIntent(row.id, 'AWAITING_APPROVAL', 'APPROVED', { approvedBy: ownerId });
  if (!approved) throw new Error('That trade was already decided.');
  return approved;
}

/**
 * Sends one approved live trade, once. Every rule in `maySign` is asked now,
 * against the mandate and pause as they are now; a refusal sends nothing and
 * says every reason.
 */
export async function submitLiveSwap(
  tradeIntentId: string,
  ownerId: string,
  now = Date.now(),
): Promise<{ sent: true; tradeIntent: TradeIntentRow } | { sent: false; why: readonly string[] }> {
  const row = await trading.getIntent(tradeIntentId);
  const walletIntentId = row ? walletIntentOf(row) : null;
  if (!row || !walletIntentId) return { sent: false, why: ['There is no such live trade.'] };
  const [mandate, paused, wallet] = await Promise.all([trading.liveMandate(row.agentId), pauseState(), walletsRepo.getIntent(walletIntentId)]);
  const simulatedAt = Date.parse(String((row.simulation as { simulatedAt?: unknown } | null)?.simulatedAt ?? ''));
  const verdict = maySign({
    status: row.status,
    mode: mandate?.mode ?? 'PAPER',
    approval: mandate?.approval ?? 'OWNER_APPROVES_EACH',
    ownerApproved: row.approvedBy !== null && wallet?.status === 'APPROVED',
    paused: paused.paused || mandate?.paused === true || mandate === null,
    quoteFresh: Number.isFinite(simulatedAt) && now - simulatedAt <= Math.min(SWAP_VALID_MS, mandate?.quoteMaxAgeMs ?? 0),
    signerAvailable: walletReadiness().ready,
  });
  if (!verdict.sign) return { sent: false, why: verdict.why };

  let out;
  try {
    out = await submitIntent(walletIntentId, ownerId, now, { viaTrade: true });
  } catch (error) {
    return { sent: false, why: [errorMessage(error)] };
  }
  const mirrored = await mirror(row, out.status, out.txHash ?? null, out.error ?? null);
  return { sent: true, tradeIntent: mirrored };
}

/** Asks the chain about a sent trade, by its hash, and carries the answer onto the trade. Never resends. */
export async function reconcileLiveSwap(tradeIntentId: string, ownerId: string): Promise<TradeIntentRow> {
  const row = await trading.getIntent(tradeIntentId);
  const walletIntentId = row ? walletIntentOf(row) : null;
  if (!row || !walletIntentId) throw new Error('There is no such live trade.');
  const wallet = await reconcileIntent(walletIntentId, ownerId);
  return mirror(row, wallet.status, wallet.txHash ?? null, wallet.error ?? null);
}

/** A wallet state carried onto its trade. The wallet is the record of what happened on chain. */
async function mirror(row: TradeIntentRow, walletStatus: string, txHash: string | null, error: string | null): Promise<TradeIntentRow> {
  const to =
    walletStatus === 'SUBMITTED' ? 'SUBMITTED'
    : walletStatus === 'UNKNOWN' ? 'UNKNOWN'
    : walletStatus === 'CONFIRMED' ? 'CONFIRMED'
    : walletStatus === 'FAILED' ? 'FAILED'
    : walletStatus === 'EXPIRED' ? 'EXPIRED'
    : null;
  if (!to || to === row.status) return row;
  const next = await trading.transitionIntent(row.id, ['APPROVED', 'SUBMITTED', 'UNKNOWN'], to, {
    receipt: txHash ? { txHash, network: 'solana' } : null,
    error,
  });
  return next ?? row;
}
