import type { ResolvedContext } from '@xbam/shared/contracts';
import { queryOne, withTransaction } from '../pool';

export async function get(jobId: string): Promise<Record<string, unknown> | null> {
  const row = await queryOne('SELECT decision FROM post_media_decisions WHERE job_id = $1', [jobId]);
  return row?.decision as Record<string, unknown> | null ?? null;
}

/** Persist the decision, attachment context and optional trace atomically. Jobs already exist. */
export async function save(input: {
  jobId: string; agentId: string; decision: { chosen: boolean; reason: string; media: unknown[] };
  enabled: boolean; context: ResolvedContext | null;
}): Promise<boolean> {
  return withTransaction(async tx => {
    const inserted = await tx.one(
      'INSERT INTO post_media_decisions (job_id, decision) VALUES ($1, $2::jsonb) ON CONFLICT DO NOTHING RETURNING job_id',
      [input.jobId, JSON.stringify(input.decision)],
    );
    if (!inserted) return false;
    if (input.context) await tx.query('UPDATE jobs SET resolved_context = $2::jsonb WHERE id = $1', [input.jobId, JSON.stringify(input.context)]);
    if (input.enabled) await tx.query(
      `INSERT INTO trace_events (job_id, agent_id, type, level, message, data)
       VALUES ($1, $2, 'POST_MEDIA_DECIDED', 'info', $3, $4::jsonb)`,
      [input.jobId, input.agentId, `Post media: ${input.decision.reason}.`,
        JSON.stringify({ phase: 'post_media', chosen: input.decision.chosen, reason: input.decision.reason })],
    );
    return true;
  });
}
