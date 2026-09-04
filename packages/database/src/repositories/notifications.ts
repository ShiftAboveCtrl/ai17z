/**
 * Telling the owner that something needs them.
 *
 * Not a second inbox. The inbox answers "who said something and did they get an
 * answer" out of jobs, events and actions. This answers the other question:
 * what is wrong with the installation itself. The two do not overlap, and the
 * distinction is load-bearing -- an account locked out of X produces no job at
 * all, so a screen built out of jobs is exactly where that problem is invisible.
 *
 * Three properties, all enforced by the unique index rather than by code:
 *
 *   - the same problem recurring is one row with a count, not a row per
 *     occurrence, so a poller failing every thirty seconds does not produce two
 *     thousand notifications overnight
 *   - acknowledging clears it, and the same problem happening later is allowed
 *     to be news again, because "I fixed it and it broke again" is information
 *   - unless it was acknowledged with a mute still running, which is how
 *     somebody says "I know, I am working on it" without going silent for ever
 */
import { query, queryOne } from '../pool';
import { mapRow, mapRows } from '../mapper';

export type NotificationSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface NotificationRecord {
  id: string;
  agentId: string | null;
  accountId: string | null;
  kind: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  actionLabel: string | null;
  actionHref: string | null;
  data: Record<string, unknown>;
  dedupeKey: string;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  mutedUntil: string | null;
}

const COLUMNS = `id, agent_id, account_id, kind, severity, title, body, action_label, action_href,
  data, dedupe_key, occurrences, first_seen_at, last_seen_at, acknowledged_at, acknowledged_by, muted_until`;

export interface RaiseInput {
  kind: string;
  severity: NotificationSeverity;
  title: string;
  body?: string;
  agentId?: string | null;
  accountId?: string | null;
  actionLabel?: string | null;
  actionHref?: string | null;
  data?: Record<string, unknown>;
  /**
   * The identity of the problem rather than of the occurrence.
   *
   * Two failures of the same poller on the same account are one problem; the
   * same failure on a different account is a different one. Whoever raises the
   * notification decides that, because only they know which parts of the
   * situation make it the same situation.
   */
  dedupeKey: string;
}

/**
 * Raises one, or records that an existing one happened again.
 *
 * Returns null when a mute is still running, so a caller can tell the
 * difference between "told them" and "deliberately did not".
 */
export async function raise(input: RaiseInput): Promise<NotificationRecord | null> {
  // An acknowledged row with a mute still running suppresses the new one, and
  // counts the occurrence, so the owner sees how many times it happened while
  // they were not being told.
  const muted = await queryOne<{ id: string }>(
    `SELECT id FROM notifications
      WHERE dedupe_key = $1 AND acknowledged_at IS NOT NULL AND muted_until IS NOT NULL AND muted_until > now()
      ORDER BY acknowledged_at DESC LIMIT 1`,
    [input.dedupeKey],
  );
  if (muted) {
    await query(`UPDATE notifications SET occurrences = occurrences + 1, last_seen_at = now() WHERE id = $1`, [
      muted.id,
    ]);
    return null;
  }

  const row = await queryOne(
    `INSERT INTO notifications (agent_id, account_id, kind, severity, title, body, action_label, action_href, data, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
     ON CONFLICT (dedupe_key) WHERE acknowledged_at IS NULL DO UPDATE
       SET occurrences = notifications.occurrences + 1,
           last_seen_at = now(),
           severity = CASE
             WHEN EXCLUDED.severity = 'CRITICAL' OR notifications.severity = 'CRITICAL' THEN 'CRITICAL'
             WHEN EXCLUDED.severity = 'WARNING' OR notifications.severity = 'WARNING' THEN 'WARNING'
             ELSE 'INFO'
           END,
           title = EXCLUDED.title,
           body = EXCLUDED.body,
           data = EXCLUDED.data
     RETURNING ${COLUMNS}`,
    [
      input.agentId ?? null,
      input.accountId ?? null,
      input.kind,
      input.severity,
      input.title,
      input.body ?? '',
      input.actionLabel ?? null,
      input.actionHref ?? null,
      JSON.stringify(input.data ?? {}),
      input.dedupeKey,
    ],
  );
  return mapRow<NotificationRecord>(row);
}

/** Everything still waiting on a person, worst first. */
export async function listOpen(filter: { agentId?: string | null; limit?: number } = {}): Promise<NotificationRecord[]> {
  const clauses = ['acknowledged_at IS NULL'];
  const values: unknown[] = [];
  if (filter.agentId) {
    values.push(filter.agentId);
    // Installation-wide notifications belong on every agent's screen: a worker
    // that is not running is the reason this agent is doing nothing.
    clauses.push(`(agent_id = $${values.length} OR agent_id IS NULL)`);
  }
  values.push(filter.limit ?? 100);
  return mapRows<NotificationRecord>(
    await query(
      `SELECT ${COLUMNS} FROM notifications
        WHERE ${clauses.join(' AND ')}
        ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END,
                 last_seen_at DESC
        LIMIT $${values.length}`,
      values,
    ),
  );
}

export async function listRecent(limit = 50): Promise<NotificationRecord[]> {
  return mapRows<NotificationRecord>(
    await query(`SELECT ${COLUMNS} FROM notifications ORDER BY last_seen_at DESC LIMIT $1`, [limit]),
  );
}

export async function get(id: string): Promise<NotificationRecord | null> {
  return mapRow<NotificationRecord>(await queryOne(`SELECT ${COLUMNS} FROM notifications WHERE id = $1`, [id]));
}

/**
 * Marks one seen and dealt with.
 *
 * `muteMs` is "and do not tell me again for a while" rather than "never tell me
 * again": there is no permanent silence, because a problem nobody is ever told
 * about again is one that will be found by its consequences.
 */
export async function acknowledge(input: {
  id: string;
  by: string | null;
  muteMs?: number;
}): Promise<NotificationRecord | null> {
  const row = await queryOne(
    `UPDATE notifications
        SET acknowledged_at = now(),
            acknowledged_by = $2,
            muted_until = CASE WHEN $3::bigint > 0 THEN now() + ($3::bigint * interval '1 millisecond') ELSE NULL END
      WHERE id = $1 AND acknowledged_at IS NULL
      RETURNING ${COLUMNS}`,
    [input.id, input.by, Math.max(0, Math.floor(input.muteMs ?? 0))],
  );
  return mapRow<NotificationRecord>(row);
}

/** Acknowledges everything open, for a screen with a "clear all" button. */
export async function acknowledgeAll(by: string | null): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE notifications SET acknowledged_at = now(), acknowledged_by = $1
      WHERE acknowledged_at IS NULL RETURNING id`,
    [by],
  );
  return rows.length;
}

/**
 * Clears a problem that has fixed itself.
 *
 * An account that signs back in should not leave "this account needs you"
 * sitting on the screen. Acknowledged as resolved rather than deleted, so the
 * record of it having happened survives.
 */
export async function resolve(dedupeKey: string): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE notifications SET acknowledged_at = now(), acknowledged_by = 'resolved'
      WHERE dedupe_key = $1 AND acknowledged_at IS NULL RETURNING id`,
    [dedupeKey],
  );
  return rows.length;
}

export async function countOpen(): Promise<{ critical: number; warning: number; info: number }> {
  const row = await queryOne<{ critical: number; warning: number; info: number }>(
    `SELECT count(*) FILTER (WHERE severity = 'CRITICAL')::int AS critical,
            count(*) FILTER (WHERE severity = 'WARNING')::int AS warning,
            count(*) FILTER (WHERE severity = 'INFO')::int AS info
       FROM notifications WHERE acknowledged_at IS NULL`,
  );
  return { critical: row?.critical ?? 0, warning: row?.warning ?? 0, info: row?.info ?? 0 };
}
