import { queryOne } from '../pool';

interface RequestRow extends Record<string, unknown> {
  result: unknown;
}

/** The request record survives a missing best-effort capability audit write. */
export async function resultForJob(jobId: string): Promise<unknown> {
  const row = await queryOne<RequestRow>(
    `SELECT r.result FROM social_paper_requests r JOIN jobs j
       ON r.agent_id = j.agent_id AND r.request_key = 'event:' || j.event_id::text
     WHERE j.id = $1`, [jobId],
  );
  return row?.result ?? null;
}

/** The unique key is the claim. A crashed claimant is never silently replayed. */
export async function claim(agentId: string, requestKey: string): Promise<{ claimed: boolean; result: unknown }> {
  const inserted = await queryOne(
    `INSERT INTO social_paper_requests (agent_id, request_key) VALUES ($1, $2)
     ON CONFLICT DO NOTHING RETURNING agent_id`,
    [agentId, requestKey],
  );
  if (inserted) return { claimed: true, result: null };
  const existing = await queryOne<RequestRow>(
    `SELECT result FROM social_paper_requests WHERE agent_id = $1 AND request_key = $2`, [agentId, requestKey],
  );
  return { claimed: false, result: existing?.result ?? null };
}

export async function complete(agentId: string, requestKey: string, result: Record<string, unknown>): Promise<void> {
  await queryOne(
    `UPDATE social_paper_requests SET result = $3::jsonb, completed_at = now()
     WHERE agent_id = $1 AND request_key = $2 AND result IS NULL RETURNING agent_id`,
    [agentId, requestKey, JSON.stringify(result)],
  );
}
