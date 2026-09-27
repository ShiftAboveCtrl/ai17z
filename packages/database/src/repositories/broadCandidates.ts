import { query, queryOne, type Tx } from '../pool';

/**
 * What became of each post an agent came across on its own.
 *
 * Written in the ingest transaction, beside the job it did or did not create,
 * so a declined keyword match is on record in the same commit as the event.
 * Re-polling the same post updates nothing: the first decision stands, which
 * is the same rule the watched-account dispositions follow.
 */
export async function record(
  tx: Tx,
  input: {
    agentId: string;
    eventId: string;
    decision: 'QUEUED' | 'DECLINED';
    reason: string;
    authorFollowers: number | null;
  },
): Promise<void> {
  await tx.many(
    `INSERT INTO broad_candidate_decisions (agent_id, event_id, decision, reason, author_followers)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (agent_id, event_id) DO NOTHING`,
    [
      input.agentId,
      input.eventId,
      input.decision,
      input.reason.slice(0, 500),
      input.authorFollowers === null ? null : Math.min(Math.round(input.authorFollowers), 2_000_000_000),
    ],
  );
}

/** Keeps the table to a week. Called now and then, not on every write. */
export async function prune(): Promise<void> {
  await query(`DELETE FROM broad_candidate_decisions WHERE decided_at < now() - interval '7 days'`);
}

export interface BroadSummary {
  /** Posts the agent came across in the window. */
  seen: number;
  queued: number;
  declined: number;
  /** The reason given most often for declining, and how often. */
  topDecline: { reason: string; count: number } | null;
  /** Median audience of the posts it queued, where X reported one. */
  medianQueuedFollowers: number | null;
  /** Public actions that came out of broad discovery in the window. */
  published: number;
}

/**
 * The shape of the agent's own looking over the last `hours`.
 *
 * Reasons are grouped on their first sentence, because a decline reason
 * carries a count ("already approached 3 people") and grouping on the whole
 * string would scatter one cause across a dozen rows.
 */
export async function summary(agentId: string, hours = 24): Promise<BroadSummary> {
  const totals = await queryOne<{ seen: number; queued: number; declined: number; median: number | null }>(
    `SELECT count(*)::int AS seen,
            count(*) FILTER (WHERE decision = 'QUEUED')::int AS queued,
            count(*) FILTER (WHERE decision = 'DECLINED')::int AS declined,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY author_followers)
              FILTER (WHERE decision = 'QUEUED' AND author_followers IS NOT NULL) AS median
       FROM broad_candidate_decisions
      WHERE agent_id = $1 AND decided_at > now() - make_interval(hours => $2)`,
    [agentId, hours],
  );
  const top = await queryOne<{ reason: string; n: number }>(
    `SELECT split_part(reason, '. ', 1) AS reason, count(*)::int AS n
       FROM broad_candidate_decisions
      WHERE agent_id = $1 AND decision = 'DECLINED' AND decided_at > now() - make_interval(hours => $2)
      GROUP BY 1 ORDER BY n DESC LIMIT 1`,
    [agentId, hours],
  );
  const published = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM actions a
       JOIN jobs j ON j.id = a.job_id
       JOIN events e ON e.id = j.event_id
      WHERE a.agent_id = $1 AND a.status = 'EXECUTED' AND NOT a.dry_run
        AND e.type = 'KEYWORD_MATCH'
        AND a.executed_at > now() - make_interval(hours => $2)`,
    [agentId, hours],
  );
  return {
    seen: totals?.seen ?? 0,
    queued: totals?.queued ?? 0,
    declined: totals?.declined ?? 0,
    topDecline: top ? { reason: top.reason, count: top.n } : null,
    medianQueuedFollowers: totals?.median === null || totals?.median === undefined ? null : Math.round(Number(totals.median)),
    published: published?.n ?? 0,
  };
}
