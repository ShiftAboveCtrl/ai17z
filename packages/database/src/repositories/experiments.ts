import { query, queryOne } from '../pool';

/**
 * The question an agent is currently trying to answer about its own writing.
 *
 * Deliberately small. One running experiment per agent, two arms, and an
 * instruction each -- the database enforces the first of those with a partial
 * unique index, because two experiments at once are one experiment with four
 * arms and no way to attribute anything to either question.
 *
 * The arithmetic that decides a winner is in `packages/runtime/src/experiments.ts`
 * and is pure. This only stores the question and which arm each post was
 * written for.
 */

export interface ExperimentRow extends Record<string, unknown> {
  id: string;
  agent_id: string;
  hypothesis: string;
  status: 'RUNNING' | 'STOPPED';
  variant_a_key: string;
  variant_a_label: string;
  variant_a_instruction: string;
  variant_b_key: string;
  variant_b_label: string;
  variant_b_instruction: string;
  minimum_per_arm: number;
  created_at: string;
  ended_at: string | null;
}

export interface AssignmentRow extends Record<string, unknown> {
  id: string;
  experiment_id: string;
  agent_id: string;
  job_id: string | null;
  remote_post_id: string | null;
  variant_key: string;
  assigned_at: string;
}

/** The experiment an agent is running, if it is running one. */
export async function running(agentId: string): Promise<ExperimentRow | null> {
  return queryOne<ExperimentRow>(
    `SELECT * FROM experiments WHERE agent_id = $1 AND status = 'RUNNING'`,
    [agentId],
  );
}

export async function get(id: string): Promise<ExperimentRow | null> {
  return queryOne<ExperimentRow>('SELECT * FROM experiments WHERE id = $1', [id]);
}

/** Everything this agent has tried, newest first. */
export async function listForAgent(agentId: string, limit = 20): Promise<ExperimentRow[]> {
  return query<ExperimentRow>(
    'SELECT * FROM experiments WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2',
    [agentId, Math.min(Math.max(limit, 1), 100)],
  );
}

export async function start(input: {
  agentId: string;
  hypothesis: string;
  variantA: { key: string; label: string; instruction?: string };
  variantB: { key: string; label: string; instruction?: string };
  minimumPerArm?: number;
}): Promise<ExperimentRow> {
  const row = await queryOne<ExperimentRow>(
    `INSERT INTO experiments
       (agent_id, hypothesis,
        variant_a_key, variant_a_label, variant_a_instruction,
        variant_b_key, variant_b_label, variant_b_instruction,
        minimum_per_arm)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      input.agentId,
      input.hypothesis,
      input.variantA.key,
      input.variantA.label,
      input.variantA.instruction ?? '',
      input.variantB.key,
      input.variantB.label,
      input.variantB.instruction ?? '',
      input.minimumPerArm ?? 12,
    ],
  );
  return row!;
}

/**
 * Stops an experiment without deleting it.
 *
 * The results stay readable afterwards, which is the point: an experiment that
 * disappears when it ends cannot be quoted, and "we tried that and it made no
 * difference" is most of what an owner learns from doing this at all.
 */
export async function stop(id: string): Promise<ExperimentRow | null> {
  return queryOne<ExperimentRow>(
    `UPDATE experiments SET status = 'STOPPED', ended_at = now() WHERE id = $1 RETURNING *`,
    [id],
  );
}

/**
 * Records which arm a post was written for, once.
 *
 * `ON CONFLICT DO NOTHING` against the per-job unique index: a job that is
 * retried is the same post, and counting it twice would put one post in one arm
 * twice. The existing row is returned so the caller gets the arm that was
 * already chosen rather than a fresh one.
 */
export async function assign(input: {
  experimentId: string;
  agentId: string;
  jobId: string;
  variantKey: string;
}): Promise<AssignmentRow> {
  const inserted = await queryOne<AssignmentRow>(
    `INSERT INTO experiment_assignments (experiment_id, agent_id, job_id, variant_key)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [input.experimentId, input.agentId, input.jobId, input.variantKey],
  );
  if (inserted) return inserted;
  const existing = await queryOne<AssignmentRow>(
    'SELECT * FROM experiment_assignments WHERE experiment_id = $1 AND job_id = $2',
    [input.experimentId, input.jobId],
  );
  return existing!;
}

/**
 * Attaches the published post to its assignment.
 *
 * Until this happens the assignment is a post that was written and may never
 * have been sent, and one that was never sent takes no part in any comparison.
 */
export async function published(jobId: string, remotePostId: string): Promise<void> {
  await query(
    'UPDATE experiment_assignments SET remote_post_id = $2 WHERE job_id = $1 AND remote_post_id IS NULL',
    [jobId, remotePostId],
  );
}

export interface ArmReadingRow extends Record<string, unknown> {
  variant_key: string;
  remote_post_id: string;
  impressions: number | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
}

/**
 * Every published post in the experiment, with its freshest reading.
 *
 * Left join, so a post that has been published but never measured comes back
 * with nulls rather than not at all. Whether an unmeasured post counts is the
 * pure code's decision -- it leaves them out of rates entirely rather than
 * treating them as zeroes -- and it cannot make that decision about rows this
 * query silently dropped.
 */
export async function readings(experimentId: string): Promise<ArmReadingRow[]> {
  return query<ArmReadingRow>(
    `SELECT a.variant_key,
            a.remote_post_id,
            p.impressions, p.likes, p.replies, p.reposts
       FROM experiment_assignments a
       LEFT JOIN LATERAL (
              SELECT impressions, likes, replies, reposts
                FROM post_analytics
               WHERE post_analytics.remote_post_id = a.remote_post_id
               ORDER BY observed_at DESC
               LIMIT 1
            ) p ON true
      WHERE a.experiment_id = $1
        AND a.remote_post_id IS NOT NULL`,
    [experimentId],
  );
}
