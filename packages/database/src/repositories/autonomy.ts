import { mapRow, mapRows } from '../mapper';
import { query, queryOne } from '../pool';

/**
 * The durable half of an agent restraining itself.
 *
 * Budgets are deliberately not here. How many model calls an agent has made
 * today, how many approaches it published, how much it looked up: every one of
 * those is already a row in `model_calls`, `actions` or `jobs`. Counting them
 * is a read, it survives a restart because the rows do, and a second copy is a
 * number that drifts from the thing it describes. What is in this file is what
 * could not be derived from work that may never have happened.
 */

// ── Growth sessions ─────────────────────────────────────────────────────────

export interface GrowthSessionRow {
  id: string;
  agentId: string;
  startedAt: string;
  endedAt: string | null;
  endedReason: string | null;
  candidatesConsidered: number;
  modelCalls: number;
  researchCalls: number;
  publicActions: number;
}

/** The session currently open for this agent, if one is. */
export async function openSession(agentId: string): Promise<GrowthSessionRow | null> {
  return mapRow<GrowthSessionRow>(
    await queryOne('SELECT * FROM agent_growth_sessions WHERE agent_id = $1 AND ended_at IS NULL', [agentId]),
  );
}

/**
 * Opens a session, or returns the one already open.
 *
 * The unique partial index is what makes this safe rather than the check
 * above it: two workers deciding to start a session in the same moment is an
 * ordinary race, and the database is the only thing that can settle it.
 */
export async function startSession(agentId: string): Promise<GrowthSessionRow> {
  const inserted = await queryOne(
    `INSERT INTO agent_growth_sessions (agent_id) VALUES ($1)
     ON CONFLICT (agent_id) WHERE ended_at IS NULL DO NOTHING
     RETURNING *`,
    [agentId],
  );
  if (inserted) return mapRow<GrowthSessionRow>(inserted) as GrowthSessionRow;
  return (await openSession(agentId)) as GrowthSessionRow;
}

/** Closes the open session, saying why. A session that did nothing still closes. */
export async function endSession(agentId: string, reason: string): Promise<void> {
  await query(
    `UPDATE agent_growth_sessions SET ended_at = now(), ended_reason = $2
      WHERE agent_id = $1 AND ended_at IS NULL`,
    [agentId, reason.slice(0, 300)],
  );
}

/** Records something the open session spent. Silent when none is open. */
export async function chargeSession(
  agentId: string,
  what: 'candidates' | 'model' | 'research' | 'action',
  howMany = 1,
): Promise<void> {
  const column = {
    candidates: 'candidates_considered',
    model: 'model_calls',
    research: 'research_calls',
    action: 'public_actions',
  }[what];
  await query(
    `UPDATE agent_growth_sessions SET ${column} = ${column} + $2 WHERE agent_id = $1 AND ended_at IS NULL`,
    [agentId, howMany],
  );
}

/** How many sessions started in the trailing day, open one included. */
export async function sessionsToday(agentId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM agent_growth_sessions
      WHERE agent_id = $1 AND started_at > now() - interval '24 hours'`,
    [agentId],
  );
  return row?.n ?? 0;
}

/** When the last session ended, for the cooldown. Null if none ever has. */
export async function lastSessionEndedAt(agentId: string): Promise<string | null> {
  const row = await queryOne<{ ended_at: string }>(
    `SELECT ended_at FROM agent_growth_sessions
      WHERE agent_id = $1 AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1`,
    [agentId],
  );
  return row?.ended_at ?? null;
}

/** What has been spent across every session in the trailing day. */
export async function spentToday(
  agentId: string,
): Promise<{ modelCalls: number; researchCalls: number; publicActions: number }> {
  const row = await queryOne<{ model_calls: number; research_calls: number; public_actions: number }>(
    `SELECT coalesce(sum(model_calls),0)::int AS model_calls,
            coalesce(sum(research_calls),0)::int AS research_calls,
            coalesce(sum(public_actions),0)::int AS public_actions
       FROM agent_growth_sessions
      WHERE agent_id = $1 AND started_at > now() - interval '24 hours'`,
    [agentId],
  );
  return {
    modelCalls: row?.model_calls ?? 0,
    researchCalls: row?.research_calls ?? 0,
    publicActions: row?.public_actions ?? 0,
  };
}

// ── Do not contact ──────────────────────────────────────────────────────────

export interface DoNotContactRow {
  id: string;
  agentId: string;
  channel: string;
  handle: string;
  remoteUserId: string | null;
  source: 'THEY_ASKED' | 'OWNER';
  evidence: string | null;
  reason: string | null;
  createdAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

/**
 * Records that somebody asked to be left alone.
 *
 * Idempotent on the live entry, because the same person saying it twice is one
 * fact and not two. The evidence of the first time is kept: it is the earliest
 * and therefore the one that establishes when this started.
 */
export async function addDoNotContact(input: {
  agentId: string;
  channel: string;
  handle: string;
  remoteUserId?: string | null;
  source?: 'THEY_ASKED' | 'OWNER';
  evidence?: string | null;
  reason?: string | null;
}): Promise<DoNotContactRow> {
  const handle = input.handle.replace(/^@+/, '');
  const existing = await findDoNotContact(input.agentId, input.channel, handle);
  if (existing) return existing;
  const row = await queryOne(
    `INSERT INTO do_not_contact (agent_id, channel, handle, remote_user_id, source, evidence, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      input.agentId,
      input.channel,
      handle,
      input.remoteUserId ?? null,
      input.source ?? 'THEY_ASKED',
      input.evidence?.slice(0, 300) ?? null,
      input.reason?.slice(0, 300) ?? null,
    ],
  );
  return mapRow<DoNotContactRow>(row) as DoNotContactRow;
}

/** The live entry for this person, or null. Matched on handle, case-insensitively. */
export async function findDoNotContact(
  agentId: string,
  channel: string,
  handle: string | null,
): Promise<DoNotContactRow | null> {
  if (!handle) return null;
  return mapRow<DoNotContactRow>(
    await queryOne(
      `SELECT * FROM do_not_contact
        WHERE agent_id = $1 AND channel = $2 AND lower(handle) = lower($3) AND revoked_at IS NULL`,
      [agentId, channel, handle.replace(/^@+/, '')],
    ),
  );
}

/**
 * Lifts an entry without removing it.
 *
 * The row stays because "they asked us to stop in March" is a thing an owner
 * may need to see long after it stopped applying, and a delete would leave the
 * agent looking as though it had never been told.
 */
export async function revokeDoNotContact(id: string, reason: string): Promise<void> {
  await query('UPDATE do_not_contact SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL', [
    id,
    reason.slice(0, 300),
  ]);
}

export async function listDoNotContact(agentId: string, includeRevoked = false): Promise<DoNotContactRow[]> {
  return mapRows<DoNotContactRow>(
    await query(
      `SELECT * FROM do_not_contact WHERE agent_id = $1 ${includeRevoked ? '' : 'AND revoked_at IS NULL'}
        ORDER BY created_at DESC LIMIT 500`,
      [agentId],
    ),
  );
}

// ── What the owner keeps saying yes and no to ───────────────────────────────

export interface OwnerSignalRow {
  id: string;
  agentId: string;
  fingerprint: string;
  family: string;
  accepted: number;
  rejected: number;
  lastDecisionAt: string;
  lastRejectedAt: string | null;
  lastReason: string | null;
}

/**
 * Records one decision.
 *
 * Counts rather than a score, because a count is a fact and a score is an
 * opinion that has to be recomputed whenever the opinion changes. The decay is
 * applied when the signal is read.
 */
export async function recordOwnerDecision(input: {
  agentId: string;
  fingerprint: string;
  family: string;
  accepted: boolean;
  reason?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO owner_decision_signals (agent_id, fingerprint, family, accepted, rejected, last_decision_at, last_rejected_at, last_reason)
     VALUES ($1,$2,$3,$4,$5, now(), $6, $7)
     ON CONFLICT (agent_id, fingerprint) DO UPDATE
       SET accepted = owner_decision_signals.accepted + excluded.accepted,
           rejected = owner_decision_signals.rejected + excluded.rejected,
           last_decision_at = now(),
           last_rejected_at = coalesce(excluded.last_rejected_at, owner_decision_signals.last_rejected_at),
           last_reason = coalesce(excluded.last_reason, owner_decision_signals.last_reason)`,
    [
      input.agentId,
      input.fingerprint,
      input.family,
      input.accepted ? 1 : 0,
      input.accepted ? 0 : 1,
      input.accepted ? null : new Date().toISOString(),
      input.reason?.slice(0, 300) ?? null,
    ],
  );
}

export async function getOwnerSignal(agentId: string, fingerprint: string): Promise<OwnerSignalRow | null> {
  return mapRow<OwnerSignalRow>(
    await queryOne('SELECT * FROM owner_decision_signals WHERE agent_id = $1 AND fingerprint = $2', [
      agentId,
      fingerprint,
    ]),
  );
}

/** Everything learned about one family, for a proposal with no history of its own. */
export async function familySignal(
  agentId: string,
  family: string,
): Promise<{ accepted: number; rejected: number }> {
  const row = await queryOne<{ accepted: number; rejected: number }>(
    `SELECT coalesce(sum(accepted),0)::int AS accepted, coalesce(sum(rejected),0)::int AS rejected
       FROM owner_decision_signals WHERE agent_id = $1 AND family = $2`,
    [agentId, family],
  );
  return { accepted: row?.accepted ?? 0, rejected: row?.rejected ?? 0 };
}

export async function listOwnerSignals(agentId: string, limit = 100): Promise<OwnerSignalRow[]> {
  return mapRows<OwnerSignalRow>(
    await query(
      'SELECT * FROM owner_decision_signals WHERE agent_id = $1 ORDER BY last_decision_at DESC LIMIT $2',
      [agentId, limit],
    ),
  );
}

// ── Account health ──────────────────────────────────────────────────────────

export type AccountHealth = 'HEALTHY' | 'DEGRADED' | 'COOLDOWN' | 'HUMAN_ACTION_REQUIRED';

export interface AccountHealthRow {
  health: AccountHealth;
  healthReason: string | null;
  healthUntil: string | null;
  healthChangedAt: string | null;
}

export async function getAccountHealth(accountId: string): Promise<AccountHealthRow | null> {
  return mapRow<AccountHealthRow>(
    await queryOne(
      'SELECT health, health_reason, health_until, health_changed_at FROM accounts WHERE id = $1',
      [accountId],
    ),
  );
}

/**
 * Moves an account's health, keeping the moment it changed.
 *
 * `health_changed_at` only moves when the state actually changes, so "degraded
 * for the last forty minutes" is answerable. Writing it every time would make
 * every check look like a fresh problem.
 */
export async function setAccountHealth(input: {
  accountId: string;
  health: AccountHealth;
  reason?: string | null;
  until?: Date | null;
}): Promise<void> {
  await query(
    `UPDATE accounts
        SET health = $2,
            health_reason = $3,
            health_until = $4,
            health_changed_at = CASE WHEN health IS DISTINCT FROM $2 THEN now() ELSE health_changed_at END
      WHERE id = $1`,
    [input.accountId, input.health, input.reason?.slice(0, 300) ?? null, input.until ?? null],
  );
}
