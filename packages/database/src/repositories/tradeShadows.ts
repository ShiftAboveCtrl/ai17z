/**
 * Shadow trading rows: what to run against a live market, how often, and the
 * tally of what happened.
 *
 * The one load-bearing thing here is `claimDue`. It moves `next_run_at`
 * forward in the same statement that selects the row, under
 * `FOR UPDATE SKIP LOCKED`, which is what stops two workers running one shadow
 * and stops a restart running every shadow at once. Every recurring loop in
 * this codebase claims that way; a shadow that read first and wrote afterwards
 * would be the one exception, and the exception is where the duplicate goes.
 *
 * Nothing here executes anything. The runtime takes a claimed row and hands it
 * to `runPaperTrade`, which is the one trading pipeline.
 */
import type { AssetRef, ShadowOutcome, TradeSide, TradeVenue } from '@xbam/shared/contracts';
import { query, queryOne } from '../pool';
import { mapRow, mapRows } from '../mapper';

/** Re-exported from the contract rather than spelled again here. */
export type { ShadowOutcome };

export interface TradeShadowRow {
  id: string;
  agentId: string;
  ownerId: string | null;
  label: string;
  venue: TradeVenue;
  side: TradeSide;
  assetIn: AssetRef;
  assetOut: AssetRef;
  subject: AssetRef;
  maxIn: string;
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  maxFeeBase: string;
  intervalSeconds: number;
  nextRunAt: string;
  lastRunAt: string | null;
  runs: number;
  fills: number;
  refusals: number;
  noMarket: number;
  lastOutcome: ShadowOutcome | null;
  lastDetail: string | null;
  paused: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ShadowDraft {
  agentId: string;
  ownerId: string | null;
  label: string;
  venue: TradeVenue;
  side: TradeSide;
  assetIn: AssetRef;
  assetOut: AssetRef;
  subject: AssetRef;
  maxIn: string;
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  maxFeeBase: string;
  intervalSeconds: number;
}

/**
 * Create a shadow, or update the one with this label.
 *
 * Upsert on `(agent_id, label)` because re-running a setup screen must change
 * the shadow somebody already made rather than add a second one running
 * beside it. The tally is deliberately not reset: what was observed under an
 * earlier setting still happened, and `updated_at` is what says the setting
 * moved.
 */
export async function putShadow(draft: ShadowDraft): Promise<TradeShadowRow> {
  return mapRow<TradeShadowRow>(
    await queryOne(
      `INSERT INTO trade_shadows (
         agent_id, owner_id, label, venue, side, asset_in, asset_out, subject,
         max_in, max_slippage_bps, max_price_impact_bps, max_fee_base, interval_seconds
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13)
       ON CONFLICT (agent_id, label) DO UPDATE SET
         venue = EXCLUDED.venue,
         side = EXCLUDED.side,
         asset_in = EXCLUDED.asset_in,
         asset_out = EXCLUDED.asset_out,
         subject = EXCLUDED.subject,
         max_in = EXCLUDED.max_in,
         max_slippage_bps = EXCLUDED.max_slippage_bps,
         max_price_impact_bps = EXCLUDED.max_price_impact_bps,
         max_fee_base = EXCLUDED.max_fee_base,
         interval_seconds = EXCLUDED.interval_seconds,
         updated_at = now()
       RETURNING *`,
      [
        draft.agentId,
        draft.ownerId,
        draft.label,
        draft.venue,
        draft.side,
        JSON.stringify(draft.assetIn),
        JSON.stringify(draft.assetOut),
        JSON.stringify(draft.subject),
        draft.maxIn,
        draft.maxSlippageBps,
        draft.maxPriceImpactBps,
        draft.maxFeeBase,
        draft.intervalSeconds,
      ],
    ),
  )!;
}

/**
 * The shadows that are due, with their next run already moved forward.
 *
 * Forward by one interval from now rather than from `next_run_at`, so a worker
 * that was off for a day does not then run a shadow every second catching up.
 * The same reasoning as the poller's claim: being late is not a reason to do a
 * day's reads at once against somebody else's API.
 */
export async function claimDue(limit = 5, now: Date = new Date()): Promise<TradeShadowRow[]> {
  return mapRows<TradeShadowRow>(
    await query(
      `UPDATE trade_shadows AS s
          SET next_run_at = $2::timestamptz + make_interval(secs => s.interval_seconds),
              last_run_at = $2::timestamptz,
              updated_at = now()
        WHERE s.id IN (
          SELECT id FROM trade_shadows
           WHERE paused = false AND next_run_at <= $2::timestamptz
           ORDER BY next_run_at
           FOR UPDATE SKIP LOCKED
           LIMIT $1
        )
        RETURNING *`,
      [limit, now.toISOString()],
    ),
  );
}

/** What one run came to. The intent itself is the record; this is the tally. */
export async function noteRun(
  id: string,
  outcome: ShadowOutcome,
  detail: string | null,
): Promise<TradeShadowRow | null> {
  return mapRow<TradeShadowRow>(
    await queryOne(
      `UPDATE trade_shadows SET
         runs = runs + 1,
         fills = fills + CASE WHEN $2 = 'FILLED' THEN 1 ELSE 0 END,
         refusals = refusals + CASE WHEN $2 = 'REFUSED' THEN 1 ELSE 0 END,
         no_market = no_market + CASE WHEN $2 = 'NO_MARKET' THEN 1 ELSE 0 END,
         last_outcome = $2,
         -- Trimmed rather than left to grow: this is shown on a card, and a
         -- stack trace in it pushes the layout wider than a phone.
         last_detail = left($3, 500),
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, outcome, detail],
    ),
  );
}

export async function listShadows(agentId: string): Promise<TradeShadowRow[]> {
  return mapRows<TradeShadowRow>(
    await query(`SELECT * FROM trade_shadows WHERE agent_id = $1 ORDER BY created_at DESC`, [agentId]),
  );
}

export async function getShadow(id: string): Promise<TradeShadowRow | null> {
  return mapRow<TradeShadowRow>(await queryOne(`SELECT * FROM trade_shadows WHERE id = $1`, [id]));
}

export async function setShadowPaused(id: string, paused: boolean): Promise<TradeShadowRow | null> {
  return mapRow<TradeShadowRow>(
    await queryOne(`UPDATE trade_shadows SET paused = $2, updated_at = now() WHERE id = $1 RETURNING *`, [id, paused]),
  );
}

export async function deleteShadow(id: string): Promise<boolean> {
  const rows = await query(`DELETE FROM trade_shadows WHERE id = $1 RETURNING id`, [id]);
  return rows.length > 0;
}

/** How many shadows exist and how many are running, for a status screen. */
export async function shadowCounts(): Promise<{ total: number; running: number }> {
  const row = await queryOne<{ total: string; running: string }>(
    `SELECT count(*) AS total, count(*) FILTER (WHERE paused = false) AS running FROM trade_shadows`,
  );
  return { total: Number(row?.total ?? 0), running: Number(row?.running ?? 0) };
}
