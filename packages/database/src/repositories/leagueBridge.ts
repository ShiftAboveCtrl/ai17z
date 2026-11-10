import type { AssetRef, MarketSnapshot, TradeMandate, TradeSide } from '@xbam/shared/contracts';
import { isUniqueViolation, query, queryOne, withTransaction } from '../pool';
import { mapRow, mapRows } from '../mapper';
import { putMandate, type TradeMandateRow } from './trading';

/**
 * Persistence for the paper league bridge (`docs/architecture/STUDIO_LEAGUE_BRIDGE.md`).
 *
 * Nothing here knows what Studio looks like, and nothing here can sign: a league
 * entry points at a PAPER mandate and a fill report is a copy of a paper fill.
 */

/** Migration 0120's CHECKs on league_entries.status and league_fill_reports.state; registered in constrainedEnums.ts. */
export const LEAGUE_ENTRY_STATUSES = ['PENDING', 'ACTIVE', 'ENDED', 'REFUSED'] as const;
export const LEAGUE_FILL_STATES = ['PENDING', 'ACCEPTED', 'REJECTED', 'LOCAL_ONLY'] as const;
export type LeagueEntryStatus = (typeof LEAGUE_ENTRY_STATUSES)[number];
export type LeagueFillState = (typeof LEAGUE_FILL_STATES)[number];

export interface LeagueEntryRow {
  id: string;
  agentId: string;
  ownerId: string | null;
  seasonSlug: string;
  entryKey: string;
  installationId: string | null;
  linkedAt: string | null;
  studioOrigin: string | null;
  alias: string;
  replacePaperMandate: boolean;
  /** The season as validated and applied. Opaque here; the runtime parses it. */
  season: unknown;
  rulesHash: string;
  startsAt: string;
  endsAt: string;
  fillsAcceptedUntil: string;
  remoteEntryId: string | null;
  mandateId: string | null;
  status: LeagueEntryStatus;
  statusReason: string | null;
  refusalCode: string | null;
  lastProblem: string | null;
  lastSeasonCheckAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeagueFillRow {
  entryId: string;
  intentId: string;
  fillKey: string;
  filledAt: string;
  payload: Record<string, unknown>;
  contentHash: string;
  state: LeagueFillState;
  reason: string | null;
  attempts: number;
  nextAttemptAt: string;
  reportedAt: string | null;
}

/** A paper fill as the trade journal holds it, with what a report needs and nothing else. */
export interface PaperFillIntent {
  intentId: string;
  side: TradeSide;
  assetIn: AssetRef;
  assetOut: AssetRef;
  quote: MarketSnapshot;
  executedOn: MarketSnapshot | null;
  postcondition: Record<string, unknown> | null;
  filledAt: string;
}

const ENTRY_COLUMNS = '*';

export async function getEntry(id: string): Promise<LeagueEntryRow | null> {
  return mapRow<LeagueEntryRow>(await queryOne(`SELECT ${ENTRY_COLUMNS} FROM league_entries WHERE id = $1`, [id]));
}

/** The agent's live entry (PENDING or ACTIVE), if any. An agent has one mandate and so at most one. */
export async function liveEntryOf(agentId: string): Promise<LeagueEntryRow | null> {
  return mapRow<LeagueEntryRow>(
    await queryOne(`SELECT ${ENTRY_COLUMNS} FROM league_entries WHERE agent_id = $1 AND status IN ('PENDING', 'ACTIVE')`, [agentId]),
  );
}

/** The agent's most recent entry of any status, for "what happened to it". */
export async function latestEntryOf(agentId: string): Promise<LeagueEntryRow | null> {
  return mapRow<LeagueEntryRow>(
    await queryOne(`SELECT ${ENTRY_COLUMNS} FROM league_entries WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1`, [agentId]),
  );
}

export async function entryOfSeason(agentId: string, slug: string): Promise<LeagueEntryRow | null> {
  return mapRow<LeagueEntryRow>(
    await queryOne(`SELECT ${ENTRY_COLUMNS} FROM league_entries WHERE agent_id = $1 AND season_slug = $2
      AND (status <> 'REFUSED' OR refusal_code IS NULL OR refusal_code NOT IN ('alias_taken', 'invalid_alias'))
      AND (status <> 'ENDED' OR end_code IS DISTINCT FROM 'link_changed')
      ORDER BY created_at DESC LIMIT 1`, [agentId, slug]),
  );
}

/** Entries the sweep still has something to do for. */
export async function openEntries(): Promise<LeagueEntryRow[]> {
  return mapRows<LeagueEntryRow>(await query(`SELECT ${ENTRY_COLUMNS} FROM league_entries WHERE status IN ('PENDING', 'ACTIVE') ORDER BY created_at`));
}

export type CreateEntryResult =
  | { kind: 'CREATED' | 'RESUMED'; row: LeagueEntryRow }
  /** The agent already holds a live entry for a different season. */
  | { kind: 'OTHER_LIVE_ENTRY'; row: LeagueEntryRow }
  /** This season was already refused or finished for this agent. It is not a slot to reuse. */
  | { kind: 'ALREADY_SETTLED'; row: LeagueEntryRow };

/**
 * Records an intent to enter, before anything is sent.
 *
 * Written first so that a crash between "Studio said yes" and "the mandate was
 * written" leaves a row to resume, keyed by the same `entry_key`, instead of an
 * entry at Studio that nothing here knows about.
 */
export async function createPendingEntry(input: {
  agentId: string;
  ownerId: string | null;
  seasonSlug: string;
  alias: string;
  replacePaperMandate: boolean;
  season: unknown;
  rulesHash: string;
  startsAt: string;
  endsAt: string;
  fillsAcceptedUntil: string;
  link: { installationId: string; linkedAt: string; origin: string };
}): Promise<CreateEntryResult> {
  const existing = await entryOfSeason(input.agentId, input.seasonSlug);
  if (existing) {
    return existing.status === 'PENDING' || existing.status === 'ACTIVE' ? { kind: 'RESUMED', row: existing } : { kind: 'ALREADY_SETTLED', row: existing };
  }
  try {
    const row = mapRow<LeagueEntryRow>(
      await queryOne(
        `INSERT INTO league_entries (agent_id, owner_id, season_slug, alias, replace_paper_mandate, season, rules_hash, starts_at, ends_at, fills_accepted_until, installation_id, linked_at, studio_origin)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13) RETURNING ${ENTRY_COLUMNS}`,
        [input.agentId, input.ownerId, input.seasonSlug, input.alias, input.replacePaperMandate, JSON.stringify(input.season), input.rulesHash, input.startsAt, input.endsAt, input.fillsAcceptedUntil, input.link.installationId, input.link.linkedAt, input.link.origin],
      ),
    );
    return { kind: 'CREATED', row: row as LeagueEntryRow };
  } catch (error) {
    if (isUniqueViolation(error, 'league_entries_one_live')) {
      const live = await liveEntryOf(input.agentId);
      if (live) return { kind: 'OTHER_LIVE_ENTRY', row: live };
    }
    if (isUniqueViolation(error, 'league_entries_agent_season')) {
      const again = await entryOfSeason(input.agentId, input.seasonSlug);
      if (again) return { kind: 'RESUMED', row: again };
    }
    throw error;
  }
}

/** Studio accepted the entry. Recorded on its own, before the mandate, so a failure after it is resumable. */
export async function setRemoteEntry(entryId: string, remoteEntryId: string): Promise<LeagueEntryRow | null> {
  return mapRow<LeagueEntryRow>(
    await queryOne(
      `UPDATE league_entries SET remote_entry_id = $2, last_problem = NULL, updated_at = now()
         WHERE id = $1 AND status = 'PENDING' AND (remote_entry_id IS NULL OR remote_entry_id = $2) RETURNING ${ENTRY_COLUMNS}`,
      [entryId, remoteEntryId],
    ),
  );
}

export type MandateSlot =
  | { ok: true; replaces: 'NOTHING' | 'A_LEAGUE_MANDATE' | 'A_PAPER_MANDATE' }
  | { ok: false; code: 'LIVE_MANDATE' | 'PAPER_MANDATE_EXISTS'; why: string };

async function slotFor(current: TradeMandateRow | null, isLeague: boolean, replacePaperMandate: boolean): Promise<MandateSlot> {
  if (!current) return { ok: true, replaces: 'NOTHING' };
  if (isLeague) return { ok: true, replaces: 'A_LEAGUE_MANDATE' };
  if (current.mode !== 'PAPER') {
    return { ok: false, code: 'LIVE_MANDATE', why: 'This agent has a live trading mandate. The league is paper only and never replaces a live mandate; pause or retire it yourself first.' };
  }
  if (!replacePaperMandate) {
    return { ok: false, code: 'PAPER_MANDATE_EXISTS', why: 'This agent already has a paper mandate of its own. Entering replaces it for the season, so say so explicitly to go ahead.' };
  }
  return { ok: true, replaces: 'A_PAPER_MANDATE' };
}

/** Whether entering would be allowed to write a mandate, asked before anything is sent to Studio. */
export async function mandateSlot(agentId: string, replacePaperMandate: boolean): Promise<MandateSlot> {
  const current = mapRow<TradeMandateRow>(await queryOne(`SELECT * FROM trade_mandates WHERE agent_id = $1 AND retired_at IS NULL`, [agentId]));
  const isLeague = current ? (await queryOne(`SELECT 1 AS yes FROM league_entries WHERE mandate_id = $1`, [current.id])) !== null : false;
  return slotFor(current, isLeague, replacePaperMandate);
}

export type ActivateResult =
  | { ok: true; entry: LeagueEntryRow; mandate: TradeMandateRow }
  | { ok: false; code: 'NOT_PENDING' | 'NO_REMOTE_ENTRY' | 'LIVE_MANDATE' | 'PAPER_MANDATE_EXISTS'; why: string };

/**
 * Writes the season mandate and marks the entry ACTIVE, together or not at all.
 *
 * The mandate it writes is whatever the caller passes, and the caller is
 * `mandateFromSeason`, which can only produce a PAPER one. The check here is the
 * other half: it will not replace a LIVE mandate, and it will not replace the
 * owner's own paper mandate unless asked to.
 */
export async function activateEntry(input: {
  entryId: string;
  mandate: Omit<TradeMandate, 'id' | 'agentId'>;
  replacePaperMandate: boolean;
}): Promise<ActivateResult> {
  return withTransaction(async (tx): Promise<ActivateResult> => {
    const entry = mapRow<LeagueEntryRow>(await tx.one(`SELECT ${ENTRY_COLUMNS} FROM league_entries WHERE id = $1 FOR UPDATE`, [input.entryId]));
    if (!entry || entry.status !== 'PENDING') return { ok: false, code: 'NOT_PENDING', why: 'This entry is not waiting to be activated.' };
    if (!entry.remoteEntryId) return { ok: false, code: 'NO_REMOTE_ENTRY', why: 'Studio has not accepted this entry yet.' };
    const current = mapRow<TradeMandateRow>(await tx.one(`SELECT * FROM trade_mandates WHERE agent_id = $1 AND retired_at IS NULL FOR UPDATE`, [entry.agentId]));
    const isLeague = current ? (await tx.one(`SELECT 1 AS yes FROM league_entries WHERE mandate_id = $1`, [current.id])) !== null : false;
    const slot = await slotFor(current, isLeague, input.replacePaperMandate);
    if (!slot.ok) return slot;
    // PAPER is not read from the caller: whatever the argument says, this is
    // the mode the mandate is written with.
    const mandate = await putMandate({ agentId: entry.agentId, ownerId: entry.ownerId, mandate: { ...input.mandate, mode: 'PAPER', approval: 'OWNER_APPROVES_EACH', protectiveExits: null } }, tx);
    const updated = mapRow<LeagueEntryRow>(
      await tx.one(
        `UPDATE league_entries SET status = 'ACTIVE', mandate_id = $2, last_problem = NULL, updated_at = now() WHERE id = $1 RETURNING ${ENTRY_COLUMNS}`,
        [entry.id, mandate.id],
      ),
    );
    return { ok: true, entry: updated as LeagueEntryRow, mandate };
  });
}

export async function refuseEntry(entryId: string, reason: string, code: string | null = null): Promise<void> {
  await query(`UPDATE league_entries SET status = 'REFUSED', status_reason = $2, refusal_code = $3, updated_at = now() WHERE id = $1 AND status = 'PENDING'`, [entryId, reason.slice(0, 300), code]);
}

/** Pause first and settle together, so interruption never leaves a live mandate behind. */
export async function stopEntry(entryId: string, reason: string, status: 'ENDED' | 'REFUSED' = 'ENDED', endCode: 'link_changed' | null = null): Promise<void> {
  await withTransaction(async (tx) => {
    const entry = await tx.one<{ mandate_id: string | null }>(`SELECT mandate_id FROM league_entries WHERE id = $1 AND status IN ('PENDING', 'ACTIVE') FOR UPDATE`, [entryId]);
    if (!entry) return;
    if (entry.mandate_id) await tx.query(`UPDATE trade_mandates SET paused = true, updated_at = now() WHERE id = $1`, [entry.mandate_id]);
    await tx.query(`UPDATE league_entries SET status = $2, status_reason = $3, last_problem = $3, end_code = $4, updated_at = now() WHERE id = $1`, [entryId, status, reason.slice(0, 300), endCode]);
  });
}

export async function endEntry(entryId: string, reason: string): Promise<void> {
  await query(`UPDATE league_entries SET status = 'ENDED', status_reason = $2, updated_at = now() WHERE id = $1 AND status IN ('PENDING', 'ACTIVE')`, [entryId, reason.slice(0, 300)]);
}

export async function noteProblem(entryId: string, problem: string | null): Promise<void> {
  await query(`UPDATE league_entries SET last_problem = $2, updated_at = now() WHERE id = $1`, [entryId, problem === null ? null : problem.slice(0, 300)]);
}

export async function noteSeasonChecked(entryId: string): Promise<void> {
  await query(`UPDATE league_entries SET last_season_check_at = now() WHERE id = $1`, [entryId]);
}

// ---------------------------------------------------------------------------
// Fills
// ---------------------------------------------------------------------------

/** Every paper fill made under one mandate, oldest first. */
export async function paperFillsUnderMandate(mandateId: string, agentId: string): Promise<PaperFillIntent[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT id, side, asset_in, asset_out, quote, executed_on, postcondition, updated_at FROM trade_intents
       WHERE mandate_id = $1 AND agent_id = $2 AND mode = 'PAPER' AND status = 'PAPER_FILLED' ORDER BY updated_at ASC, id ASC`,
    [mandateId, agentId],
  );
  return rows.map((r) => {
    const m = mapRow<{ id: string; side: TradeSide; assetIn: AssetRef; assetOut: AssetRef; quote: MarketSnapshot; executedOn: MarketSnapshot | null; postcondition: Record<string, unknown> | null; updatedAt: string }>(r)!;
    return { intentId: m.id, side: m.side, assetIn: m.assetIn, assetOut: m.assetOut, quote: m.quote, executedOn: m.executedOn, postcondition: m.postcondition, filledAt: m.updatedAt };
  });
}

/** Records fills not seen before. A fill already recorded is left exactly as it was. */
export async function recordFills(
  entryId: string,
  fills: Array<{ intentId: string; fillKey: string; filledAt: string; payload: Record<string, unknown>; contentHash: string; state: 'PENDING' | 'LOCAL_ONLY'; reason: string | null }>,
): Promise<number> {
  let inserted = 0;
  for (const f of fills) {
    const row = await queryOne(
      `INSERT INTO league_fill_reports (entry_id, intent_id, fill_key, filled_at, payload, content_hash, state, reason)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) ON CONFLICT (entry_id, intent_id) DO NOTHING RETURNING intent_id`,
      [entryId, f.intentId, f.fillKey, f.filledAt, JSON.stringify(f.payload), f.contentHash, f.state, f.reason],
    );
    if (row) inserted += 1;
  }
  return inserted;
}

export async function fillsOf(entryId: string): Promise<LeagueFillRow[]> {
  return mapRows<LeagueFillRow>(await query(`SELECT * FROM league_fill_reports WHERE entry_id = $1 ORDER BY filled_at ASC, intent_id ASC`, [entryId]));
}

export async function dueFills(entryId: string, now: Date, limit: number): Promise<LeagueFillRow[]> {
  return mapRows<LeagueFillRow>(
    await query(
      `SELECT * FROM league_fill_reports WHERE entry_id = $1 AND state = 'PENDING' AND next_attempt_at <= $2 ORDER BY filled_at ASC, intent_id ASC LIMIT $3`,
      [entryId, now.toISOString(), limit],
    ),
  );
}

export async function settleFill(entryId: string, fillKey: string, state: 'ACCEPTED' | 'REJECTED' | 'LOCAL_ONLY', reason: string | null): Promise<void> {
  await query(
    `UPDATE league_fill_reports SET state = $3::text, reason = $4, reported_at = CASE WHEN $3::text IN ('ACCEPTED', 'REJECTED') THEN now() ELSE reported_at END
       WHERE entry_id = $1 AND fill_key = $2 AND state = 'PENDING'`,
    [entryId, fillKey, state, reason === null ? null : reason.slice(0, 300)],
  );
}

/** A report that did not settle: try again later, with the delay the caller chose. */
export async function deferFills(entryId: string, fillKeys: string[], nextAttemptAt: Date): Promise<void> {
  if (fillKeys.length === 0) return;
  await query(
    `UPDATE league_fill_reports SET attempts = attempts + 1, next_attempt_at = $3 WHERE entry_id = $1 AND fill_key = ANY($2::text[]) AND state = 'PENDING'`,
    [entryId, fillKeys, nextAttemptAt.toISOString()],
  );
}

export async function fillCounts(entryId: string): Promise<Record<LeagueFillState, number>> {
  const rows = await query<{ state: LeagueFillState; n: number }>(`SELECT state, count(*)::int AS n FROM league_fill_reports WHERE entry_id = $1 GROUP BY state`, [entryId]);
  const out: Record<LeagueFillState, number> = { PENDING: 0, ACCEPTED: 0, REJECTED: 0, LOCAL_ONLY: 0 };
  for (const r of rows) out[r.state] = r.n;
  return out;
}
