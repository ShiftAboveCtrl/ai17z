import { query } from '../pool';

/**
 * What a post did, as X showed it at a moment in time.
 *
 * Snapshots rather than a running total, because every question Growth asks is
 * about change. A number that is overwritten each time it is read cannot say
 * whether a post is still being seen a day later, and that is most of what
 * separates a format that worked from one that got lucky in an hour.
 */
export type AnalyticsSource = 'TIMELINE' | 'POST_ANALYTICS';

export interface PostAnalyticsRow extends Record<string, unknown> {
  id: string;
  agent_id: string;
  account_id: string | null;
  channel: string;
  remote_post_id: string;
  action_id: string | null;
  observed_at: string;
  impressions: number | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  quotes: number | null;
  bookmarks: number | null;
  profile_visits: number | null;
  link_clicks: number | null;
  source: AnalyticsSource;
}

export interface PostObservation {
  agentId: string;
  accountId: string | null;
  remotePostId: string;
  actionId?: string | null;
  source: AnalyticsSource;
  impressions?: number | null;
  likes?: number | null;
  reposts?: number | null;
  replies?: number | null;
  quotes?: number | null;
  bookmarks?: number | null;
  profileVisits?: number | null;
  linkClicks?: number | null;
}

/**
 * Records one reading, or leaves the existing one alone.
 *
 * The unique index is per post, per source, per minute: a poller that runs
 * twice in the same minute is recording the same observation, not two. Nothing
 * is overwritten -- an older reading is the evidence, and replacing it would
 * throw away the only thing that makes a series a series.
 */
export async function record(observation: PostObservation): Promise<PostAnalyticsRow | null> {
  const rows = await query<PostAnalyticsRow>(
    `INSERT INTO post_analytics
       (agent_id, account_id, remote_post_id, action_id, source,
        impressions, likes, reposts, replies, quotes, bookmarks, profile_visits, link_clicks)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      observation.agentId,
      observation.accountId,
      observation.remotePostId,
      observation.actionId ?? null,
      observation.source,
      observation.impressions ?? null,
      observation.likes ?? null,
      observation.reposts ?? null,
      observation.replies ?? null,
      observation.quotes ?? null,
      observation.bookmarks ?? null,
      observation.profileVisits ?? null,
      observation.linkClicks ?? null,
    ],
  );
  return rows[0] ?? null;
}

/** Every reading for one post, oldest first, which is the order it grew in. */
export async function history(remotePostId: string): Promise<PostAnalyticsRow[]> {
  return query<PostAnalyticsRow>(
    `SELECT * FROM post_analytics WHERE remote_post_id = $1 ORDER BY observed_at`,
    [remotePostId],
  );
}

/**
 * The most recent reading for each of an agent's posts.
 *
 * What a screen shows: one row per post, the freshest numbers. The series is
 * still there underneath for anything that needs to ask how it got there.
 */
export async function latestForAgent(agentId: string, limit = 50): Promise<PostAnalyticsRow[]> {
  return query<PostAnalyticsRow>(
    `SELECT DISTINCT ON (remote_post_id) *
       FROM post_analytics
      WHERE agent_id = $1
      ORDER BY remote_post_id, observed_at DESC
      LIMIT $2`,
    [agentId, Math.min(Math.max(limit, 1), 200)],
  );
}

/**
 * How much a post moved between its first and last reading.
 *
 * Null where there is only one reading: one point is not a trend, and saying
 * "up 0" about a post nobody has looked at twice is worse than saying nothing.
 */
export async function growth(remotePostId: string): Promise<{ metric: string; from: number; to: number }[] | null> {
  const readings = await history(remotePostId);
  if (readings.length < 2) return null;
  const first = readings[0]!;
  const last = readings[readings.length - 1]!;
  const metrics: (keyof PostAnalyticsRow)[] = ['impressions', 'likes', 'reposts', 'replies', 'bookmarks'];
  return metrics
    .map((metric) => ({ metric: String(metric), from: first[metric] as number | null, to: last[metric] as number | null }))
    .filter((row): row is { metric: string; from: number; to: number } => row.from !== null && row.to !== null);
}

export interface PublishedPostRow extends Record<string, unknown> {
  action_id: string;
  remote_post_id: string;
  text: string;
  published_at: string;
  action_type: string;
  impressions: number | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  observed_at: string | null;
}

/**
 * What this agent actually published, with the freshest reading of each.
 *
 * Anchored on `actions` rather than on `post_analytics`, because a post nobody
 * has measured yet is still a post the agent published -- and a query that
 * started from the readings would silently make the unmeasured ones not exist,
 * which is exactly the shape that turns "we have not looked" into "it got
 * nothing".
 *
 * Real actions only. A dry run is not a public position, so it did not happen
 * as far as anything measuring performance is concerned.
 */
export async function publishedWithReadings(agentId: string, limit = 100): Promise<PublishedPostRow[]> {
  return query<PublishedPostRow>(
    `SELECT a.id                                 AS action_id,
            a.remote_action_id                   AS remote_post_id,
            COALESCE(a.payload->>'text', '')     AS text,
            COALESCE(a.executed_at, a.created_at) AS published_at,
            a.type                               AS action_type,
            p.impressions, p.likes, p.reposts, p.replies, p.observed_at
       FROM actions a
       LEFT JOIN LATERAL (
              SELECT impressions, likes, reposts, replies, observed_at
                FROM post_analytics
               WHERE post_analytics.remote_post_id = a.remote_action_id
               ORDER BY observed_at DESC
               LIMIT 1
            ) p ON true
      WHERE a.agent_id = $1
        AND a.dry_run = false
        AND a.status = 'EXECUTED'
        AND a.remote_action_id IS NOT NULL
      ORDER BY COALESCE(a.executed_at, a.created_at) DESC
      LIMIT $2`,
    [agentId, Math.min(Math.max(limit, 1), 500)],
  );
}
