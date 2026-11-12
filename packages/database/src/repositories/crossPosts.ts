import { mapRows } from '../mapper';
import { query, queryOne } from '../pool';
import type { Tx } from '../pool';

/**
 * Posting a copy of the agent's own post to Farcaster.
 *
 * Off unless the owner switched it on for that Farcaster account, and read
 * again at send so switching it off stops jobs that were already queued.
 */
export async function farcasterPostingEnabled(accountId: string): Promise<boolean> {
  const row = await queryOne<{ enabled: boolean }>('SELECT enabled FROM farcaster_posting WHERE account_id = $1', [accountId]);
  return row?.enabled === true;
}

export async function setFarcasterPosting(accountId: string, enabled: boolean): Promise<void> {
  await query(
    `INSERT INTO farcaster_posting (account_id, enabled) VALUES ($1, $2)
     ON CONFLICT (account_id) DO UPDATE SET enabled = excluded.enabled, updated_at = now()`,
    [accountId, enabled],
  );
}

/** The two things that can become of an idea on another network. A CHECK in migration 0134 holds the same list. */
export const CROSS_POST_STATUSES = ['QUEUED', 'SKIPPED'] as const;
export type CrossPostStatus = (typeof CROSS_POST_STATUSES)[number];

export interface CrossPostRow {
  id: string;
  agentId: string;
  ideaId: string;
  originAccountId: string;
  targetAccountId: string;
  channel: string;
  dryRun: boolean;
  jobId: string | null;
  status: CrossPostStatus;
  reason: string;
  createdAt: string;
}

/**
 * Records what became of one idea on one other network, once.
 *
 * The unique key makes a second fan-out of the same idea (a restart, the
 * "a job for this idea already exists" path) a no-op that returns the first
 * record unchanged, rather than a second post. The one exception is a skip
 * followed by a queue: an account that was unavailable at the first fan-out
 * and is available at a later one does get its cast job, so the record moves
 * to QUEUED with that job, or it would report a skip for a cast that went out.
 */
export async function recordCrossPost(tx: Tx | null, input: {
  agentId: string;
  ideaId: string;
  originAccountId: string;
  targetAccountId: string;
  channel: string;
  dryRun: boolean;
  jobId: string | null;
  status: CrossPostStatus;
  reason: string;
}): Promise<{ created: boolean }> {
  const sql = `INSERT INTO cross_posts (agent_id, idea_id, origin_account_id, target_account_id, channel, dry_run, job_id, status, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (idea_id, target_account_id, dry_run) DO UPDATE
       SET status = EXCLUDED.status, job_id = EXCLUDED.job_id, reason = EXCLUDED.reason
       WHERE cross_posts.status = 'SKIPPED' AND EXCLUDED.status = 'QUEUED'
     RETURNING id`;
  const params = [input.agentId, input.ideaId, input.originAccountId, input.targetAccountId, input.channel,
    input.dryRun, input.jobId, input.status, input.reason.slice(0, 500)];
  const row = tx ? await tx.one(sql, params) : await queryOne(sql, params);
  return { created: Boolean(row) };
}

export async function listCrossPosts(agentId: string, limit = 20): Promise<CrossPostRow[]> {
  return mapRows<CrossPostRow>(await query(
    'SELECT * FROM cross_posts WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2', [agentId, limit]));
}
