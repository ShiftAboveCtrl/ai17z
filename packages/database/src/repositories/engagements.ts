import type { SalienceFactor } from '@xbam/shared/contracts';
import { mapRow, mapRows } from '../mapper';
import { query, queryOne } from '../pool';

/**
 * Likes and reposts an agent decided on by itself.
 *
 * Intentions only. Nothing here executes: the runner in `packages/runtime`
 * hands each one to `performCapabilityAction`, which is the same executor the
 * `x.like` and `x.repost` capabilities already use. So idempotency, the
 * stale-retake check and the action ledger are the ones that already exist.
 *
 * Two properties are enforced here rather than hoped for above. The unique
 * index makes one decision per post per kind, so an agent that notices the same
 * post four times proposes once. And `claimDue` moves the attempt time forward
 * in the statement that selects the row, exactly as the account poller, the
 * feed watcher and the wake loop do, so two workers cannot take one proposal.
 */

/*
  The two vocabularies, as arrays rather than as unions.

  Both have a CHECK constraint behind them, and `constrainedEnums.ts` needs the
  values at runtime to hold the column and the code against each other. A union
  type exists only at compile time, which is exactly how a widened enum reaches
  a narrower constraint and fails at the database on whichever path writes one
  first. That has cost this project a broken sign-in once already.

  Nothing outside the database has needed to name either of these, so they have
  no shared contract enum. `LIKE` and `REPOST` are two of the `ACTION_TYPES`,
  but this column is not that column: it says what an agent proposed to do on
  its own, and it may never grow to cover replying or posting.
*/
export const ENGAGEMENT_KINDS = ['LIKE', 'REPOST'] as const;
export const ENGAGEMENT_STATUSES = ['PROPOSED', 'APPROVED', 'DONE', 'DECLINED', 'FAILED'] as const;

export type EngagementKind = (typeof ENGAGEMENT_KINDS)[number];
export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number];

export interface EngagementRow {
  id: string;
  agentId: string;
  accountId: string;
  kind: EngagementKind;
  remoteId: string;
  remoteUrl: string;
  authorHandle: string;
  excerpt: string;
  score: number;
  factors: SalienceFactor[];
  confidence: number;
  attentionId: string | null;
  status: EngagementStatus;
  reason: string;
  jobId: string | null;
  attempts: number;
  nextAttemptAt: string;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const COLUMNS = `id, agent_id, account_id, kind, remote_id, remote_url, author_handle, excerpt,
  score, factors, confidence, attention_id, status, reason, job_id, attempts, next_attempt_at,
  decided_at, created_at, updated_at`;

export interface ProposeInput {
  agentId: string;
  accountId: string;
  kind: EngagementKind;
  remoteId: string;
  remoteUrl?: string;
  authorHandle?: string;
  excerpt?: string;
  score: number;
  factors?: SalienceFactor[];
  confidence?: number;
  attentionId?: string | null;
}

/**
 * Propose one, or leave the existing decision alone.
 *
 * Deliberately **not** an upsert that rewrites. A proposal an owner has already
 * approved, declined or acted on is a decision, and seeing the post again is
 * not a reason to reopen it. The only thing a repeat sighting may do is raise
 * the score of a proposal nobody has looked at yet, because a post that keeps
 * turning out to be relevant is more worth acknowledging than it first seemed.
 */
export async function propose(input: ProposeInput): Promise<EngagementRow | null> {
  const row = await queryOne(
    `INSERT INTO agent_engagements
       (agent_id, account_id, kind, remote_id, remote_url, author_handle, excerpt,
        score, factors, confidence, attention_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
     ON CONFLICT (agent_id, kind, remote_id) DO UPDATE
       SET score = greatest(agent_engagements.score, excluded.score),
           factors = excluded.factors,
           confidence = greatest(agent_engagements.confidence, excluded.confidence),
           updated_at = now()
       WHERE agent_engagements.status = 'PROPOSED'
     RETURNING ${COLUMNS}`,
    [
      input.agentId,
      input.accountId,
      input.kind,
      input.remoteId,
      (input.remoteUrl ?? '').slice(0, 500),
      (input.authorHandle ?? '').slice(0, 120),
      (input.excerpt ?? '').slice(0, 400),
      Math.round(input.score),
      JSON.stringify(input.factors ?? []),
      input.confidence ?? 0.5,
      input.attentionId ?? null,
    ],
  );
  // Null when the conflict hit a row that is already settled, which is the
  // correct outcome and not an error.
  return mapRow<EngagementRow>(row);
}

/** What this agent is proposing, newest first. */
export async function listEngagements(
  agentId: string,
  options: { status?: EngagementStatus; limit?: number } = {},
): Promise<EngagementRow[]> {
  const params: unknown[] = [agentId];
  const clauses = ['agent_id = $1'];
  if (options.status) {
    params.push(options.status);
    clauses.push(`status = $${params.length}`);
  }
  params.push(Math.min(Math.max(options.limit ?? 20, 1), 200));
  return mapRows<EngagementRow>(
    await query(
      `SELECT ${COLUMNS} FROM agent_engagements WHERE ${clauses.join(' AND ')}
        ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    ),
  );
}

export async function getEngagement(id: string): Promise<EngagementRow | null> {
  return mapRow<EngagementRow>(await queryOne(`SELECT ${COLUMNS} FROM agent_engagements WHERE id = $1`, [id]));
}

/**
 * Claim proposals that are due, moving their attempt time forward in the same
 * statement that selects them.
 *
 * The same shape as every other claim in this codebase, and for the same
 * reason: two workers must not take one proposal, and a restart must not
 * stampede every proposal at once.
 */
export async function claimDue(limit: number, holdSeconds: number): Promise<EngagementRow[]> {
  return mapRows<EngagementRow>(
    await query(
      `UPDATE agent_engagements
          SET next_attempt_at = now() + make_interval(secs => $2),
              attempts = attempts + 1,
              updated_at = now()
        WHERE id IN (
          SELECT id FROM agent_engagements
           WHERE status IN ('PROPOSED','APPROVED') AND next_attempt_at <= now()
           ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED
        )
        RETURNING ${COLUMNS}`,
      [limit, holdSeconds],
    ),
  );
}

/**
 * Put one back without charging it an attempt.
 *
 * A claim another worker is holding is not a try that failed: nothing was
 * asked of X, and counting it spends the three this proposal gets. With a
 * two-minute hold that used up every attempt inside six minutes, which is
 * shorter than the ten an abandoned action needs before it can be retaken, so
 * a single orphaned row could defeat the proposal permanently.
 *
 * Deferred past that window instead, and the attempt claimDue just charged is
 * given back.
 */
export async function deferAttempt(id: string, seconds: number, reason: string): Promise<void> {
  await query(
    `UPDATE agent_engagements
        SET next_attempt_at = now() + make_interval(secs => $2),
            attempts = greatest(attempts - 1, 0),
            reason = $3,
            updated_at = now()
      WHERE id = $1`,
    [id, seconds, reason.slice(0, 1000)],
  );
}

/**
 * Settle one, with the reason.
 *
 * A proposal that stops being worth doing is DECLINED and says why, rather than
 * being deleted: "why did it not like that" is a fair question and an empty
 * table cannot answer it.
 */
export async function settle(
  id: string,
  status: Exclude<EngagementStatus, 'PROPOSED'>,
  reason: string,
  jobId?: string | null,
): Promise<void> {
  await query(
    `UPDATE agent_engagements
        SET status = $2, reason = $3, job_id = coalesce($4, job_id),
            decided_at = now(), updated_at = now()
      WHERE id = $1`,
    [id, status, reason.slice(0, 1000), jobId ?? null],
  );
}

/**
 * Records which job is attempting this, before it is known how it went.
 *
 * "Which job attempted this" is a fair question while it is still being
 * attempted, and `settle` only answers it once the attempt is over. An
 * attempt that is retried left the row pointing at nothing at all.
 */
export async function attachJob(id: string, jobId: string): Promise<void> {
  await query('UPDATE agent_engagements SET job_id = $2, updated_at = now() WHERE id = $1', [id, jobId]);
}

/** An owner saying yes to one, which only moves it out of PROPOSED. */
export async function approve(id: string, agentId: string): Promise<boolean> {
  const rows = await query(
    `UPDATE agent_engagements SET status = 'APPROVED', next_attempt_at = now(), updated_at = now()
      WHERE id = $1 AND agent_id = $2 AND status = 'PROPOSED' RETURNING id`,
    [id, agentId],
  );
  return rows.length > 0;
}

/** Posts this agent has already acted on, so nothing is proposed twice. */
export async function actedOn(agentId: string, limit = 500): Promise<Set<string>> {
  const rows = await query<{ remote_id: string }>(
    `SELECT remote_id FROM agent_engagements
      WHERE agent_id = $1 AND status IN ('DONE','APPROVED','DECLINED','FAILED')
      ORDER BY updated_at DESC LIMIT $2`,
    [agentId, limit],
  );
  return new Set(rows.map((row) => row.remote_id));
}

/** How many real engagements happened in a window, for the rate gate. */
export async function countSince(agentId: string, kind: EngagementKind, sinceIso: string): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM agent_engagements
      WHERE agent_id = $1 AND kind = $2 AND status = 'DONE' AND decided_at >= $3`,
    [agentId, kind, sinceIso],
  );
  return row?.count ?? 0;
}
