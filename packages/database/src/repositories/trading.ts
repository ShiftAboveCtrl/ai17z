/**
 * Mandates, trade intents and the stops. The rules live in
 * `packages/runtime/src/tradingRisk.ts`; this keeps the rows.
 *
 * Two things about this file are load-bearing rather than stylistic.
 *
 * Every state change is a conditional update: the `WHERE` names the statuses
 * the row is allowed to be in, so a caller that raced somebody else gets null
 * back instead of moving a trade twice. That is the same compare-and-swap
 * `wallets.transitionIntent` uses, and for the same reason.
 *
 * `recordBroadcast` writes the transaction identity *before* anything is
 * handed to a network, and the unique index behind it means one identity
 * belongs to one intent. After a crash, recovery has something to ask about
 * rather than a reason to send again.
 *
 * No secret is in any of these tables. A wallet is referenced by id.
 */
import type {
  AssetRef,
  MarketSnapshot,
  TradeIntentStatus,
  TradeMandate,
  TradeMode,
  TradePauseScope,
  TradeSide,
  TradeVenue,
} from '@xbam/shared/contracts';
import { getPool, query, queryOne } from '../pool';
import { mapRow, mapRows } from '../mapper';

export interface TradeMandateRow {
  id: string;
  agentId: string;
  ownerId: string | null;
  mode: TradeMode;
  approval: 'OWNER_APPROVES_EACH' | 'AUTONOMOUS_WITHIN_MANDATE';
  venues: TradeVenue[];
  networks: string[];
  allowedAssets: AssetRef[];
  maxPerTrade: string;
  maxPerDay: string;
  maxOpenExposure: string;
  maxOpenPositions: number;
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  minLiquidityBase: string;
  maxFeeBase: string;
  quoteMaxAgeMs: number;
  expiresAt: string | null;
  paused: boolean;
  createdAt: string;
  updatedAt: string;
  retiredAt: string | null;
}

export interface TradeIntentRow {
  id: string;
  agentId: string;
  mandateId: string;
  walletId: string | null;
  mode: TradeMode;
  venue: TradeVenue;
  network: string | null;
  side: TradeSide;
  assetIn: AssetRef;
  assetOut: AssetRef;
  maxIn: string;
  minOut: string;
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  maxFeeBase: string;
  quote: MarketSnapshot;
  executedOn: MarketSnapshot | null;
  expiresAt: string;
  status: TradeIntentStatus;
  riskReasons: { code: string; detail: string }[] | null;
  simulation: Record<string, unknown> | null;
  approvedBy: string | null;
  approvedAt: string | null;
  idempotencyKey: string;
  txIdentity: string | null;
  broadcastAt: string | null;
  receipt: Record<string, unknown> | null;
  postcondition: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TradePauseRow {
  id: string;
  scope: TradePauseScope;
  target: string | null;
  reason: string;
  createdBy: string | null;
  createdAt: string;
  liftedAt: string | null;
  liftedBy: string | null;
}

// ---------------------------------------------------------------------------
// Mandates
// ---------------------------------------------------------------------------

/**
 * Write a mandate, retiring whatever the agent had.
 *
 * Superseded rather than edited, so "what was it allowed to do at the time"
 * still has an answer after an owner changes their mind. The defaults in the
 * schema are paper, owner-approved and unpaused, and nothing here overrides
 * them silently: a caller that wants live has to say so.
 */
export async function putMandate(input: {
  agentId: string;
  ownerId: string | null;
  mandate: Omit<TradeMandate, 'id' | 'agentId'>;
}): Promise<TradeMandateRow> {
  const m = input.mandate;
  await query(`UPDATE trade_mandates SET retired_at = now() WHERE agent_id = $1 AND retired_at IS NULL`, [input.agentId]);
  return mapRow<TradeMandateRow>(
    await queryOne(
      `INSERT INTO trade_mandates (
         agent_id, owner_id, mode, approval, venues, networks, allowed_assets,
         max_per_trade, max_per_day, max_open_exposure, max_open_positions,
         max_slippage_bps, max_price_impact_bps, min_liquidity_base, max_fee_base,
         quote_max_age_ms, expires_at, paused
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        input.agentId,
        input.ownerId,
        m.mode,
        m.approval,
        JSON.stringify(m.venues),
        JSON.stringify(m.networks),
        JSON.stringify(m.allowedAssets),
        m.maxPerTrade,
        m.maxPerDay,
        m.maxOpenExposure,
        m.maxOpenPositions,
        m.maxSlippageBps,
        m.maxPriceImpactBps,
        m.minLiquidityBase,
        m.maxFeeBase,
        m.quoteMaxAgeMs,
        m.expiresAt,
        m.paused,
      ],
    ),
  ) as TradeMandateRow;
}

export async function liveMandate(agentId: string): Promise<TradeMandateRow | null> {
  return mapRow<TradeMandateRow>(
    await queryOne(`SELECT * FROM trade_mandates WHERE agent_id = $1 AND retired_at IS NULL`, [agentId]),
  );
}

export async function getMandate(id: string): Promise<TradeMandateRow | null> {
  return mapRow<TradeMandateRow>(await queryOne(`SELECT * FROM trade_mandates WHERE id = $1`, [id]));
}

/** Pause or unpause a mandate. Separate from the pause table: this is the owner's own switch. */
export async function setMandatePaused(id: string, paused: boolean): Promise<TradeMandateRow | null> {
  return mapRow<TradeMandateRow>(
    await queryOne(`UPDATE trade_mandates SET paused = $2, updated_at = now() WHERE id = $1 RETURNING *`, [id, paused]),
  );
}

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

/**
 * Record a proposed trade.
 *
 * The idempotency key is unique, so a retry of the same decision finds the
 * first row rather than making a second trade. The caller gets the existing
 * row back and can tell it was not the one that created it.
 */
export async function createIntent(input: {
  agentId: string;
  mandateId: string;
  walletId: string | null;
  mode: TradeMode;
  venue: TradeVenue;
  network: string | null;
  side: TradeSide;
  assetIn: AssetRef;
  assetOut: AssetRef;
  maxIn: string;
  minOut: string;
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  maxFeeBase: string;
  quote: MarketSnapshot;
  expiresAt: string;
  idempotencyKey: string;
}): Promise<{ row: TradeIntentRow; created: boolean }> {
  const existing = await queryOne(`SELECT * FROM trade_intents WHERE idempotency_key = $1`, [input.idempotencyKey]);
  if (existing) return { row: mapRow<TradeIntentRow>(existing) as TradeIntentRow, created: false };

  const row = mapRow<TradeIntentRow>(
    await queryOne(
      `INSERT INTO trade_intents (
         agent_id, mandate_id, wallet_id, mode, venue, network, side,
         asset_in, asset_out, max_in, min_out, max_slippage_bps, max_price_impact_bps,
         max_fee_base, quote, expires_at, status, idempotency_key
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15::jsonb,$16,'DRAFTED',$17)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        input.agentId,
        input.mandateId,
        input.walletId,
        input.mode,
        input.venue,
        input.network,
        input.side,
        JSON.stringify(input.assetIn),
        JSON.stringify(input.assetOut),
        input.maxIn,
        input.minOut,
        input.maxSlippageBps,
        input.maxPriceImpactBps,
        input.maxFeeBase,
        JSON.stringify(input.quote),
        input.expiresAt,
        input.idempotencyKey,
      ],
    ),
  );
  // Somebody else won the race between the select and the insert. Their row is
  // the one that counts.
  if (!row) {
    const theirs = await queryOne(`SELECT * FROM trade_intents WHERE idempotency_key = $1`, [input.idempotencyKey]);
    return { row: mapRow<TradeIntentRow>(theirs) as TradeIntentRow, created: false };
  }
  return { row, created: true };
}

export async function getIntent(id: string): Promise<TradeIntentRow | null> {
  return mapRow<TradeIntentRow>(await queryOne(`SELECT * FROM trade_intents WHERE id = $1`, [id]));
}

export async function intentByKey(key: string): Promise<TradeIntentRow | null> {
  return mapRow<TradeIntentRow>(await queryOne(`SELECT * FROM trade_intents WHERE idempotency_key = $1`, [key]));
}

export async function listIntents(agentId: string, limit = 50): Promise<TradeIntentRow[]> {
  return mapRows<TradeIntentRow>(
    await query(`SELECT * FROM trade_intents WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2`, [agentId, limit]),
  );
}

/**
 * Move an intent, only from a status it is allowed to be in.
 *
 * Returns null when the row was not in one of `from`, which is how a caller
 * learns it raced somebody rather than discovering it later by having moved
 * the same trade twice.
 */
export async function transitionIntent(
  id: string,
  from: TradeIntentStatus | readonly TradeIntentStatus[],
  to: TradeIntentStatus,
  set: Partial<{
    riskReasons: { code: string; detail: string }[] | null;
    simulation: Record<string, unknown> | null;
    executedOn: MarketSnapshot | null;
    approvedBy: string | null;
    receipt: Record<string, unknown> | null;
    postcondition: Record<string, unknown> | null;
    error: string | null;
  }> = {},
): Promise<TradeIntentRow | null> {
  const froms = Array.isArray(from) ? [...from] : [from];
  return mapRow<TradeIntentRow>(
    await queryOne(
      `UPDATE trade_intents SET
         status = $3,
         risk_reasons = CASE WHEN $4::boolean THEN $5::jsonb ELSE risk_reasons END,
         simulation = CASE WHEN $6::boolean THEN $7::jsonb ELSE simulation END,
         executed_on = CASE WHEN $8::boolean THEN $9::jsonb ELSE executed_on END,
         approved_by = CASE WHEN $10::boolean THEN $11 ELSE approved_by END,
         approved_at = CASE WHEN $10::boolean AND $11 IS NOT NULL THEN now() ELSE approved_at END,
         receipt = CASE WHEN $12::boolean THEN $13::jsonb ELSE receipt END,
         postcondition = CASE WHEN $14::boolean THEN $15::jsonb ELSE postcondition END,
         error = CASE WHEN $16::boolean THEN $17 ELSE error END,
         updated_at = now()
       WHERE id = $1 AND status = ANY($2::text[])
       RETURNING *`,
      [
        id,
        froms,
        to,
        'riskReasons' in set,
        set.riskReasons === undefined ? null : JSON.stringify(set.riskReasons),
        'simulation' in set,
        set.simulation === undefined ? null : JSON.stringify(set.simulation),
        'executedOn' in set,
        set.executedOn === undefined ? null : JSON.stringify(set.executedOn),
        'approvedBy' in set,
        set.approvedBy ?? null,
        'receipt' in set,
        set.receipt === undefined ? null : JSON.stringify(set.receipt),
        'postcondition' in set,
        set.postcondition === undefined ? null : JSON.stringify(set.postcondition),
        'error' in set,
        set.error ?? null,
      ],
    ),
  );
}

/**
 * Write the transaction identity before it is handed to a network.
 *
 * This is the row that makes recovery possible, so it goes in first and the
 * unique index refuses to let one identity belong to two intents. The
 * transition to SUBMITTED is part of the same statement: there is no window
 * where an identity exists on a row that still claims to be unsent.
 */
export async function recordBroadcast(
  id: string,
  txIdentity: string,
  from: readonly TradeIntentStatus[] = ['SIGNED'],
): Promise<TradeIntentRow | null> {
  return mapRow<TradeIntentRow>(
    await queryOne(
      `UPDATE trade_intents SET
         tx_identity = $3,
         broadcast_at = now(),
         status = 'SUBMITTED',
         updated_at = now()
       WHERE id = $1 AND status = ANY($2::text[]) AND tx_identity IS NULL
       RETURNING *`,
      [id, [...from], txIdentity],
    ),
  );
}

/**
 * The intents that may have left something behind, for the recovery sweep.
 *
 * Ordered oldest first, because the one that has been unresolved longest is
 * the one most worth asking the chain about.
 */
export async function intentsNeedingReconciliation(limit = 100): Promise<TradeIntentRow[]> {
  return mapRows<TradeIntentRow>(
    await query(
      `SELECT * FROM trade_intents
         WHERE status IN ('SIGNED', 'SUBMITTED', 'UNKNOWN')
         ORDER BY coalesce(broadcast_at, updated_at) ASC
         LIMIT $1`,
      [limit],
    ),
  );
}

/**
 * What an agent currently has committed, for the risk engine's limits.
 *
 * Summed in TypeScript over BigInt rather than in SQL, because these are
 * exact base-unit strings and handing them to a numeric type is how a
 * rounding error gets into a limit check.
 */
export async function exposureOf(agentId: string, since: Date): Promise<{ spentTodayBase: string; openExposureBase: string; openPositions: number }> {
  const rows = mapRows<{ maxIn: string; status: TradeIntentStatus; createdAt: string }>(
    await query(
      `SELECT max_in, status, created_at FROM trade_intents
         WHERE agent_id = $1
           AND mode = 'LIVE'
           AND status IN ('APPROVED', 'SIMULATED', 'SIGNED', 'SUBMITTED', 'UNKNOWN', 'CONFIRMED')`,
      [agentId],
    ),
  );
  let spent = 0n;
  let open = 0n;
  let positions = 0;
  const from = since.getTime();
  for (const r of rows) {
    const amount = BigInt(r.maxIn);
    if (Date.parse(r.createdAt) >= from) spent += amount;
    // Anything not yet settled is still at risk.
    if (r.status !== 'CONFIRMED') {
      open += amount;
      positions += 1;
    }
  }
  return { spentTodayBase: spent.toString(), openExposureBase: open.toString(), openPositions: positions };
}

/** One paper fill as the journal holds it, for working out positions. */
export interface PaperFillRow {
  intentId: string;
  side: TradeSide;
  assetIn: AssetRef;
  assetOut: AssetRef;
  inBase: string;
  outBase: string;
  at: string;
}

/**
 * Every paper fill an agent has, oldest first. All of them rather than a
 * recent page, because what is held now depends on every buy and sale ever
 * made; a position worked out from the last two hundred trades is wrong for
 * any agent that has made more.
 */
export async function paperFillsOf(agentId: string): Promise<PaperFillRow[]> {
  const rows = mapRows<{ id: string; side: TradeSide; assetIn: AssetRef; assetOut: AssetRef; postcondition: Record<string, unknown> | null; createdAt: string }>(
    await query(
      `SELECT id, side, asset_in, asset_out, postcondition, created_at FROM trade_intents
         WHERE agent_id = $1 AND mode = 'PAPER' AND status = 'PAPER_FILLED'
         ORDER BY created_at ASC`,
      [agentId],
    ),
  );
  const fills: PaperFillRow[] = [];
  for (const r of rows) {
    const inBase = r.postcondition?.inBase;
    const outBase = r.postcondition?.outBase;
    // A fill without its amounts cannot be counted; leaving it out is safer
    // than counting it as zero, which would read as a free trade.
    if (typeof inBase !== 'string' || typeof outBase !== 'string' || !/^[0-9]+$/.test(inBase) || !/^[0-9]+$/.test(outBase)) continue;
    fills.push({ intentId: r.id, side: r.side, assetIn: r.assetIn, assetOut: r.assetOut, inBase, outBase, at: r.createdAt });
  }
  return fills;
}

/**
 * Runs `fn` while holding a lock for one agent's paper journal, so a check of
 * what it holds and the fill that depends on it cannot interleave with
 * another of its trades. Two sales of the same holding arriving together
 * would otherwise both see it.
 *
 * A session lock on a connection of its own rather than a transaction:
 * `fn` uses the ordinary pooled queries, and those must never run inside a
 * transaction, which they could neither see into nor wait on safely. The lock
 * is released however `fn` ends, and dies with its connection.
 */
export async function withPaperLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const holder = await getPool().connect();
  // A connection whose unlock did not happen goes back to the server closed,
  // not to the pool: returned, it would hold the lock for whoever borrowed it.
  let clean = false;
  try {
    await holder.query(`SELECT pg_advisory_lock(hashtext('paper_journal:' || $1))`, [agentId]);
    try {
      return await fn();
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(hashtext('paper_journal:' || $1))`, [agentId]);
      clean = true;
    }
  } finally {
    holder.release(!clean);
  }
}

// ---------------------------------------------------------------------------
// Pauses
// ---------------------------------------------------------------------------

/** Stop trading at a scope. A second attempt finds the first rather than stacking. */
export async function pauseTrading(input: {
  scope: TradePauseScope;
  target: string | null;
  reason: string;
  createdBy: string | null;
}): Promise<TradePauseRow> {
  const row = mapRow<TradePauseRow>(
    await queryOne(
      `INSERT INTO trade_pauses (scope, target, reason, created_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (scope, coalesce(target, '')) WHERE lifted_at IS NULL DO NOTHING
       RETURNING *`,
      [input.scope, input.target, input.reason, input.createdBy],
    ),
  );
  if (row) return row;
  const existing = await queryOne(
    `SELECT * FROM trade_pauses WHERE scope = $1 AND coalesce(target, '') = coalesce($2, '') AND lifted_at IS NULL`,
    [input.scope, input.target],
  );
  return mapRow<TradePauseRow>(existing) as TradePauseRow;
}

export async function liftPause(id: string, liftedBy: string | null): Promise<TradePauseRow | null> {
  return mapRow<TradePauseRow>(
    await queryOne(
      `UPDATE trade_pauses SET lifted_at = now(), lifted_by = $2 WHERE id = $1 AND lifted_at IS NULL RETURNING *`,
      [id, liftedBy],
    ),
  );
}

/**
 * Which scopes currently stop this trade.
 *
 * Asked at execution time rather than read once with the decision, because a
 * pause is worth having precisely when something has already been approved.
 */
export async function activePauseScopes(input: {
  agentId: string;
  venue: TradeVenue;
  walletId: string | null;
  runtimeId?: string | null;
}): Promise<TradePauseScope[]> {
  const rows = mapRows<{ scope: TradePauseScope; target: string | null }>(
    await query(`SELECT scope, target FROM trade_pauses WHERE lifted_at IS NULL`, []),
  );
  const hits: TradePauseScope[] = [];
  for (const r of rows) {
    const matches =
      (r.scope === 'GLOBAL') ||
      (r.scope === 'AGENT' && r.target === input.agentId) ||
      (r.scope === 'VENUE' && r.target === input.venue) ||
      (r.scope === 'WALLET' && input.walletId !== null && r.target === input.walletId) ||
      (r.scope === 'RUNTIME' && input.runtimeId != null && r.target === input.runtimeId);
    if (matches && !hits.includes(r.scope)) hits.push(r.scope);
  }
  return hits;
}

export async function listPauses(includeLifted = false): Promise<TradePauseRow[]> {
  return mapRows<TradePauseRow>(
    await query(
      includeLifted
        ? `SELECT * FROM trade_pauses ORDER BY created_at DESC LIMIT 200`
        : `SELECT * FROM trade_pauses WHERE lifted_at IS NULL ORDER BY created_at DESC`,
      [],
    ),
  );
}
