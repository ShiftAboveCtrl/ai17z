import { query, queryOne } from '../pool';

/**
 * What an agent learned from its own published actions, and the trials it ran
 * on what it learned. See `packages/runtime/src/learning.ts`, which decides;
 * this only stores.
 */

/** A published action old enough to have been seen, with everything needed to score it. */
export interface MeasurableAction {
  actionId: string;
  jobId: string;
  type: string;
  text: string;
  executedAt: string;
  eventType: string | null;
  eventPayload: Record<string, unknown> | null;
  learningMeta: Record<string, unknown> | null;
  views: number | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  quotes: number | null;
  bookmarks: number | null;
}

/**
 * Published actions with a reading taken at least `settleHours` after they went
 * out, not yet scored. Only the latest such reading is used: an early reading
 * of a post that kept travelling would teach the agent it failed.
 */
export async function measurableActions(
  agentId: string,
  settleHours = 6,
  limit = 100,
): Promise<MeasurableAction[]> {
  const rows = await query<{
    action_id: string;
    job_id: string;
    type: string;
    text: string | null;
    executed_at: string;
    event_type: string | null;
    event_payload: Record<string, unknown> | null;
    learning_meta: Record<string, unknown> | null;
    views: number | null;
    likes: number | null;
    reposts: number | null;
    replies: number | null;
    quotes: number | null;
    bookmarks: number | null;
  }>(
    `SELECT x.id AS action_id, x.job_id, x.type, x.payload ->> 'text' AS text, x.executed_at,
            e.type AS event_type, e.payload AS event_payload,
            j.resolved_context -> 'meta' -> 'learning' AS learning_meta,
            r.views, r.likes, r.reposts, r.replies, r.quotes, r.bookmarks
       FROM actions x
       JOIN jobs j ON j.id = x.job_id
       LEFT JOIN events e ON e.id = j.event_id
       JOIN LATERAL (
         SELECT p.views, p.likes, p.reposts, p.replies, p.quotes, p.bookmarks
           FROM post_analytics p
          WHERE p.remote_post_id = x.remote_action_id
            AND p.observed_at >= x.executed_at + ($2::int * interval '1 hour')
          ORDER BY p.observed_at DESC
          LIMIT 1
       ) r ON true
      WHERE x.agent_id = $1
        AND x.status = 'EXECUTED'
        AND x.type IN ('REPLY', 'POST')
        AND x.remote_action_id IS NOT NULL
        AND x.executed_at < now() - ($2::int * interval '1 hour')
        AND x.executed_at > now() - interval '30 days'
        AND NOT EXISTS (SELECT 1 FROM agent_learning_outcomes o WHERE o.action_id = x.id)
      ORDER BY x.executed_at
      LIMIT $3`,
    [agentId, settleHours, limit],
  );
  return rows.map((row) => ({
    actionId: row.action_id,
    jobId: row.job_id,
    type: row.type,
    text: row.text ?? '',
    executedAt: new Date(row.executed_at).toISOString(),
    eventType: row.event_type,
    eventPayload: row.event_payload,
    learningMeta: row.learning_meta,
    views: row.views,
    likes: row.likes,
    reposts: row.reposts,
    replies: row.replies,
    quotes: row.quotes,
    bookmarks: row.bookmarks,
  }));
}

/** The raw reach of this agent's most recent scored actions, for placing a new one among them. */
export async function recentReach(agentId: string, limit = 200): Promise<number[]> {
  const rows = await query<{ reach: number }>(
    `SELECT reach FROM agent_learning_outcomes WHERE agent_id = $1 ORDER BY measured_at DESC LIMIT $2`,
    [agentId, limit],
  );
  return rows.map((row) => Number(row.reach));
}

export async function recordOutcome(input: {
  actionId: string;
  agentId: string;
  features: Record<string, unknown>;
  reach: number;
  reward: number;
}): Promise<boolean> {
  const row = await queryOne<{ action_id: string }>(
    `INSERT INTO agent_learning_outcomes (action_id, agent_id, features, reach, reward)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (action_id) DO NOTHING
     RETURNING action_id`,
    [input.actionId, input.agentId, JSON.stringify(input.features), input.reach, input.reward],
  );
  return row !== null;
}

export interface ArmRow {
  dimension: string;
  arm: string;
  trials: number;
  reward: number;
  updatedAt: string;
}

export async function arms(agentId: string): Promise<ArmRow[]> {
  const rows = await query<{ dimension: string; arm: string; trials: number; reward: number; updated_at: string }>(
    `SELECT dimension, arm, trials, reward, updated_at FROM agent_strategy_arms WHERE agent_id = $1`,
    [agentId],
  );
  return rows.map((row) => ({
    dimension: row.dimension,
    arm: row.arm,
    trials: Number(row.trials),
    reward: Number(row.reward),
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

export async function saveArm(agentId: string, arm: Omit<ArmRow, 'updatedAt'>, at: Date): Promise<void> {
  await query(
    `INSERT INTO agent_strategy_arms (agent_id, dimension, arm, trials, reward, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (agent_id, dimension, arm)
     DO UPDATE SET trials = EXCLUDED.trials, reward = EXCLUDED.reward, updated_at = EXCLUDED.updated_at`,
    [agentId, arm.dimension, arm.arm, arm.trials, arm.reward, at.toISOString()],
  );
}

export interface TrialRow {
  id: string;
  dimension: string;
  arm: string;
  hypothesis: string;
  status: 'RUNNING' | 'KEPT' | 'REVERTED';
  verdict: string | null;
  startedAt: string;
  decidedAt: string | null;
}

const TRIAL_COLUMNS = `id, dimension, arm, hypothesis, status, verdict, started_at, decided_at`;

function toTrial(row: {
  id: string;
  dimension: string;
  arm: string;
  hypothesis: string;
  status: TrialRow['status'];
  verdict: string | null;
  started_at: string;
  decided_at: string | null;
}): TrialRow {
  return {
    id: row.id,
    dimension: row.dimension,
    arm: row.arm,
    hypothesis: row.hypothesis,
    status: row.status,
    verdict: row.verdict,
    startedAt: new Date(row.started_at).toISOString(),
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
  };
}

export async function trials(agentId: string, limit = 30): Promise<TrialRow[]> {
  const rows = await query<Parameters<typeof toTrial>[0]>(
    `SELECT ${TRIAL_COLUMNS} FROM agent_learning_trials WHERE agent_id = $1 ORDER BY started_at DESC LIMIT $2`,
    [agentId, limit],
  );
  return rows.map(toTrial);
}

/** Starts a trial unless one is already running on this choice; the unique index decides. */
export async function startTrial(input: { agentId: string; dimension: string; arm: string; hypothesis: string }): Promise<TrialRow | null> {
  const row = await queryOne<Parameters<typeof toTrial>[0]>(
    `INSERT INTO agent_learning_trials (agent_id, dimension, arm, hypothesis)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING ${TRIAL_COLUMNS}`,
    [input.agentId, input.dimension, input.arm, input.hypothesis.slice(0, 500)],
  );
  return row ? toTrial(row) : null;
}

export async function decideTrial(id: string, status: 'KEPT' | 'REVERTED', verdict: string): Promise<void> {
  await query(
    `UPDATE agent_learning_trials SET status = $2, verdict = $3, decided_at = now() WHERE id = $1 AND status = 'RUNNING'`,
    [id, status, verdict.slice(0, 500)],
  );
}

/** Outcomes scored since a trial began, split by whether the learned option was applied. */
export async function trialEvidence(
  agentId: string,
  dimension: string,
  since: string,
): Promise<{ applied: number[]; held: number[] }> {
  const rows = await query<{ variant: string | null; reward: number }>(
    `SELECT features -> 'variants' ->> $2 AS variant, reward
       FROM agent_learning_outcomes
      WHERE agent_id = $1 AND measured_at >= $3`,
    [agentId, dimension, since],
  );
  return {
    applied: rows.filter((row) => row.variant === 'learned').map((row) => Number(row.reward)),
    held: rows.filter((row) => row.variant === 'control').map((row) => Number(row.reward)),
  };
}

export interface DimensionRow {
  dimension: string;
  confidence: number;
  kept: number;
  reverted: number;
}

export async function dimensions(agentId: string): Promise<DimensionRow[]> {
  const rows = await query<{ dimension: string; confidence: number; kept: number; reverted: number }>(
    `SELECT dimension, confidence, kept, reverted FROM agent_learning_dimensions WHERE agent_id = $1`,
    [agentId],
  );
  return rows.map((row) => ({
    dimension: row.dimension,
    confidence: Number(row.confidence),
    kept: Number(row.kept),
    reverted: Number(row.reverted),
  }));
}

export async function saveDimension(agentId: string, row: DimensionRow): Promise<void> {
  await query(
    `INSERT INTO agent_learning_dimensions (agent_id, dimension, confidence, kept, reverted, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (agent_id, dimension)
     DO UPDATE SET confidence = EXCLUDED.confidence, kept = EXCLUDED.kept, reverted = EXCLUDED.reverted, updated_at = now()`,
    [agentId, row.dimension, row.confidence, row.kept, row.reverted],
  );
}

export async function outcomeCount(agentId: string): Promise<number> {
  const row = await queryOne<{ n: string }>(`SELECT count(*) AS n FROM agent_learning_outcomes WHERE agent_id = $1`, [agentId]);
  return Number(row?.n ?? 0);
}

/**
 * Forgets everything this agent learned. The outcomes go too: an owner who
 * resets learning means start over, and outcomes left behind would rebuild the
 * same preferences on the next wake.
 */
export async function reset(agentId: string): Promise<void> {
  await query(`DELETE FROM agent_learning_trials WHERE agent_id = $1`, [agentId]);
  await query(`DELETE FROM agent_strategy_arms WHERE agent_id = $1`, [agentId]);
  await query(`DELETE FROM agent_learning_dimensions WHERE agent_id = $1`, [agentId]);
  await query(`DELETE FROM agent_learning_outcomes WHERE agent_id = $1`, [agentId]);
}
