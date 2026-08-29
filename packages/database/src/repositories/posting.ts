import { mapRow, mapRows } from '../mapper';
import { query, queryOne, withTransaction } from '../pool';

/**
 * The schedule for posts nobody asked for.
 *
 * A row is a permission and a rhythm, not a timetable. Coming due means the
 * agent gets to look at its idea backlog; an empty backlog means it says
 * nothing, and `lastReason` records that so a quiet agent is legible rather
 * than mysterious.
 */

export interface PostingRow {
  agentId: string;
  accountId: string | null;
  enabled: boolean;
  intervalSeconds: number;
  jitterPercent: number;
  nextPostAt: string | null;
  lastPostAt: string | null;
  lastJobId: string | null;
  lastReason: string;
  createdAt: string;
  updatedAt: string;
}

export async function getSchedule(agentId: string): Promise<PostingRow | null> {
  return mapRow<PostingRow>(await queryOne('SELECT * FROM agent_posting WHERE agent_id = $1', [agentId]));
}

/**
 * Sets or clears an agent's posting schedule.
 *
 * Turning posting on schedules the first chance one interval out rather than
 * immediately: switching it on should not fire a post before the person who
 * switched it on has finished reading the screen.
 */
export async function setSchedule(input: {
  agentId: string;
  accountId: string | null;
  enabled: boolean;
  intervalSeconds: number;
  jitterPercent?: number;
}): Promise<PostingRow> {
  const row = await queryOne(
    `INSERT INTO agent_posting (agent_id, account_id, enabled, interval_seconds, jitter_percent, next_post_at)
     -- $4 is both an integer column and a make_interval argument, so both uses
     -- are cast: Postgres will not deduce one type for two contexts.
     VALUES ($1,$2,$3,$4::int,$5::int,
             CASE WHEN $3 THEN now() + make_interval(secs => $4::double precision) ELSE NULL END)
     ON CONFLICT (agent_id) DO UPDATE
       SET account_id = excluded.account_id,
           enabled = excluded.enabled,
           interval_seconds = excluded.interval_seconds,
           jitter_percent = excluded.jitter_percent,
           -- Keep an existing appointment when nothing about the rhythm changed,
           -- so saving an unrelated setting does not reset the clock.
           next_post_at = CASE
             WHEN NOT excluded.enabled THEN NULL
             WHEN agent_posting.enabled AND agent_posting.interval_seconds = excluded.interval_seconds
               THEN agent_posting.next_post_at
             ELSE now() + make_interval(secs => excluded.interval_seconds::double precision)
           END,
           updated_at = now()
     RETURNING *`,
    [input.agentId, input.accountId, input.enabled, input.intervalSeconds, input.jitterPercent ?? 25],
  );
  return mapRow<PostingRow>(row) as PostingRow;
}

/**
 * Takes the schedules that are due, and moves them on before returning.
 *
 * Claimed inside a transaction with SKIP LOCKED, and the next appointment is
 * written in the same statement, so two workers cannot both decide it is time
 * and a crash mid-post costs one missed chance rather than a repeated one.
 */
export async function claimDue(limit: number): Promise<PostingRow[]> {
  return withTransaction(async (tx) => {
    const rows = await tx.many(
      `SELECT agent_id FROM agent_posting
        WHERE enabled AND next_post_at IS NOT NULL AND next_post_at <= now()
        ORDER BY next_post_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    if (rows.length === 0) return [];
    const ids = rows.map((r) => (r as { agent_id: string }).agent_id);

    const claimed = await tx.many(
      `UPDATE agent_posting
          SET next_post_at = now()
            + make_interval(secs => interval_seconds::double precision)
            -- Spread each appointment either side of the interval so the rhythm
            -- is a rhythm and not a metronome.
            + make_interval(secs => (random() - 0.5) * 2 * interval_seconds * jitter_percent / 100.0),
              updated_at = now()
        WHERE agent_id = ANY($1::uuid[])
        RETURNING *`,
      [ids],
    );
    return mapRows<PostingRow>(claimed);
  });
}

/** What happened when the schedule last came due. */
export async function recordAttempt(agentId: string, reason: string, jobId: string | null): Promise<void> {
  await query(
    `UPDATE agent_posting
        SET last_reason = $2,
            last_job_id = coalesce($3, last_job_id),
            last_post_at = CASE WHEN $3 IS NULL THEN last_post_at ELSE now() END,
            updated_at = now()
      WHERE agent_id = $1`,
    [agentId, reason.slice(0, 500), jobId],
  );
}
