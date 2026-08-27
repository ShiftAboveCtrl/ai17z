import type { RadarSourceConfig, RadarSourceKind, RadarStatus } from '@xbam/shared/contracts';
import { mapRow, mapRows } from '../mapper';
import { query, queryOne } from '../pool';

export interface RadarSourceRow {
  id: string;
  accountId: string;
  kind: RadarSourceKind;
  target: string | null;
  label: string;
  enabled: boolean;
  config: RadarSourceConfig;
  status: RadarStatus;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  lastResultAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  cursor: string | null;
  nextPollAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listSources(accountId: string): Promise<RadarSourceRow[]> {
  return mapRows<RadarSourceRow>(
    await query('SELECT * FROM radar_sources WHERE account_id = $1 ORDER BY kind, target NULLS FIRST', [accountId]),
  );
}

export async function getSource(id: string): Promise<RadarSourceRow | null> {
  return mapRow<RadarSourceRow>(await queryOne('SELECT * FROM radar_sources WHERE id = $1', [id]));
}

export async function upsertSource(input: {
  accountId: string;
  kind: RadarSourceKind;
  target?: string | null;
  label?: string;
  enabled?: boolean;
  config?: Partial<RadarSourceConfig>;
}): Promise<RadarSourceRow> {
  const row = await queryOne(
    `INSERT INTO radar_sources (account_id, kind, target, label, enabled, config, next_poll_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb, now())
     ON CONFLICT (account_id, kind, target) DO UPDATE
       SET label = excluded.label,
           enabled = excluded.enabled,
           config = radar_sources.config || excluded.config,
           updated_at = now(),
           -- An edited source is checked now, not after the old interval.
           next_poll_at = now()
     RETURNING *`,
    [
      input.accountId,
      input.kind,
      input.target ?? null,
      input.label ?? '',
      input.enabled ?? true,
      JSON.stringify(input.config ?? {}),
    ],
  );
  return mapRow<RadarSourceRow>(row) as RadarSourceRow;
}

export async function deleteSource(id: string): Promise<void> {
  await query('DELETE FROM radar_sources WHERE id = $1', [id]);
}

/**
 * Sources due for a poll, claimed so two workers cannot both take one.
 *
 * Same shape as the account poller: the schedule lives in the row, and the claim
 * moves it forward in the statement that reads it.
 */
export async function claimDueSources(limit: number, holdSeconds: number): Promise<RadarSourceRow[]> {
  return mapRows<RadarSourceRow>(
    await query(
      `UPDATE radar_sources SET next_poll_at = now() + make_interval(secs => $2), last_poll_at = now()
        WHERE id IN (
          SELECT rs.id FROM radar_sources rs
            JOIN accounts a ON a.id = rs.account_id
           WHERE rs.enabled AND a.enabled AND a.status = 'CONNECTED'
             AND (rs.next_poll_at IS NULL OR rs.next_poll_at <= now())
           ORDER BY (rs.config->>'priority')::int DESC NULLS LAST, rs.next_poll_at NULLS FIRST
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
      [limit, holdSeconds],
    ),
  );
}

/**
 * Records the outcome of a poll.
 *
 * Health is deliberately three-valued rather than a boolean. A source that
 * worked but found nothing is healthy; one that failed once is degraded, not
 * broken; only repeated failure is failing. Collapsing these is how an account
 * ends up reporting healthy while the thing it depends on has been down an hour.
 */
export async function recordPoll(input: {
  sourceId: string;
  nextPollAt: Date;
  found: number;
  cursor?: string | null;
  error?: string | null;
}): Promise<void> {
  const failed = Boolean(input.error);
  await query(
    `UPDATE radar_sources
        SET next_poll_at = $2,
            last_success_at = CASE WHEN $3 THEN last_success_at ELSE now() END,
            last_result_at  = CASE WHEN $4 > 0 THEN now() ELSE last_result_at END,
            last_error = $5,
            cursor = coalesce($6, cursor),
            consecutive_failures = CASE WHEN $3 THEN consecutive_failures + 1 ELSE 0 END,
            status = CASE
              WHEN NOT $3 THEN 'HEALTHY'
              WHEN consecutive_failures + 1 >= 3 THEN 'FAILING'
              ELSE 'DEGRADED'
            END,
            updated_at = now()
      WHERE id = $1`,
    [input.sourceId, input.nextPollAt, failed, input.found, input.error ?? null, input.cursor ?? null],
  );
}

/**
 * Records that a source saw an event.
 *
 * The event is the identity; this is the evidence. Seeing the same post through
 * a second source is not a second event, it is corroboration — and the count is
 * what shows whether a source is pulling its weight or only ever repeating what
 * another one already found.
 */
export async function recordDiscovery(input: {
  eventId: string;
  sourceId: string | null;
  sourceKind: string;
}): Promise<{ firstTimeFromThisSource: boolean }> {
  const rows = await query<{ inserted: boolean }>(
    `INSERT INTO event_discoveries (event_id, source_id, source_kind)
     VALUES ($1,$2,$3)
     ON CONFLICT (event_id, source_kind) DO UPDATE
       SET last_seen_at = now(), seen_count = event_discoveries.seen_count + 1
     RETURNING (xmax = 0) AS inserted`,
    [input.eventId, input.sourceId, input.sourceKind],
  );
  return { firstTimeFromThisSource: rows[0]?.inserted ?? false };
}

export interface DiscoveryRow {
  sourceKind: string;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
}

export async function listDiscoveries(eventId: string): Promise<DiscoveryRow[]> {
  return mapRows<DiscoveryRow>(
    await query(
      `SELECT source_kind, first_seen_at, last_seen_at, seen_count
         FROM event_discoveries WHERE event_id = $1 ORDER BY first_seen_at`,
      [eventId],
    ),
  );
}

// ── The agent's own posts, so replies underneath them can be found ──────────

export async function recordOwnPost(input: {
  accountId: string;
  agentId: string | null;
  remoteId: string;
  remoteUrl?: string | null;
  text?: string;
  postedAt?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO own_posts (account_id, agent_id, remote_id, remote_url, text, posted_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (account_id, remote_id) DO NOTHING`,
    [
      input.accountId,
      input.agentId,
      input.remoteId,
      input.remoteUrl ?? null,
      input.text ?? '',
      input.postedAt ?? null,
    ],
  );
}

/**
 * Own posts worth checking for replies, least recently checked first.
 *
 * Bounded by age as well as count: a thread from last month is not where the
 * next reply is going to appear, and checking it costs a page load.
 */
export async function ownPostsToCheck(accountId: string, limit: number, maxAgeHours = 72): Promise<
  { id: string; remoteId: string; remoteUrl: string | null; replyCount: number }[]
> {
  return mapRows(
    await query(
      `SELECT id, remote_id, remote_url, reply_count FROM own_posts
        WHERE account_id = $1
          AND (posted_at IS NULL OR posted_at > now() - ($3::int * interval '1 hour'))
        ORDER BY last_checked_at NULLS FIRST
        LIMIT $2`,
      [accountId, limit, maxAgeHours],
    ),
  );
}

export async function markOwnPostChecked(id: string, replyCount: number): Promise<void> {
  await query('UPDATE own_posts SET last_checked_at = now(), reply_count = $2 WHERE id = $1', [id, replyCount]);
}
