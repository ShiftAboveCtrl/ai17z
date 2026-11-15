import { query } from '../pool';

/**
 * The "before" a narrative pulse compares against. Terms with a share and a
 * count, per agent and window end; never an author, handle or post text.
 */

export interface SnapshotTerm {
  term: string;
  share: number;
  authors: number;
}

export interface Snapshot {
  windowEnd: string;
  posts: number;
  terms: Map<string, SnapshotTerm>;
}

/** Snapshots are kept long enough to be somebody's "yesterday", and no longer. */
const KEEP_DAYS = 7;

export async function saveSnapshot(input: {
  agentId: string;
  windowEnd: Date;
  posts: number;
  terms: SnapshotTerm[];
}): Promise<void> {
  for (const t of input.terms) {
    await query(
      `INSERT INTO narrative_pulse_snapshots (agent_id, window_end, term, share, authors, posts)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (agent_id, window_end, term) DO UPDATE SET share = excluded.share, authors = excluded.authors, posts = excluded.posts`,
      [input.agentId, input.windowEnd.toISOString(), t.term, t.share, t.authors, input.posts],
    );
  }
  await query(
    `DELETE FROM narrative_pulse_snapshots WHERE agent_id = $1 AND window_end < $2::timestamptz - ($3::int * interval '1 day')`,
    [input.agentId, input.windowEnd.toISOString(), KEEP_DAYS],
  );
}

/**
 * The newest snapshot taken between `minAgeHours` and `maxAgeHours` before `now`.
 * Younger than the minimum would overlap the window being measured, and older
 * than the maximum is not a before worth comparing with.
 */
export async function latestBefore(
  agentId: string,
  now: Date,
  minAgeHours: number,
  maxAgeHours: number,
): Promise<Snapshot | null> {
  const rows = await query<{ window_end: Date; term: string; share: string; authors: number; posts: number }>(
    `SELECT window_end, term, share::text AS share, authors, posts
       FROM narrative_pulse_snapshots
      WHERE agent_id = $1
        AND window_end = (SELECT max(window_end) FROM narrative_pulse_snapshots
                           WHERE agent_id = $1
                             AND window_end <= $2::timestamptz - ($3::numeric * interval '1 hour')
                             AND window_end >= $2::timestamptz - ($4::numeric * interval '1 hour'))`,
    [agentId, now.toISOString(), minAgeHours, maxAgeHours],
  );
  if (rows.length === 0) return null;
  return {
    windowEnd: new Date(rows[0]!.window_end).toISOString(),
    posts: rows[0]!.posts,
    terms: new Map(rows.map((r) => [r.term, { term: r.term, share: Number(r.share), authors: r.authors }])),
  };
}
