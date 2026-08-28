import { mapRow, mapRows } from '../mapper';
import { query, queryOne } from '../pool';

export interface IdeaRow {
  id: string;
  agentId: string;
  kind: string;
  summary: string;
  detail: string;
  source: string;
  sourceHandle: string | null;
  score: number;
  status: string;
  usedAt: string | null;
  createdAt: string;
}

export async function addIdea(input: {
  agentId: string;
  kind?: string;
  summary: string;
  detail?: string;
  source?: string;
  sourceJobId?: string | null;
  sourceHandle?: string | null;
  score?: number;
}): Promise<IdeaRow> {
  const row = await queryOne(
    `INSERT INTO content_ideas (agent_id, kind, summary, detail, source, source_job_id, source_handle, score)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      input.agentId,
      input.kind ?? 'observation',
      input.summary.slice(0, 500),
      input.detail ?? '',
      input.source ?? 'manual',
      input.sourceJobId ?? null,
      input.sourceHandle ?? null,
      input.score ?? 50,
    ],
  );
  return mapRow<IdeaRow>(row) as IdeaRow;
}

export async function listIdeas(agentId: string, status?: string, limit = 50): Promise<IdeaRow[]> {
  const clauses = ['agent_id = $1'];
  const params: unknown[] = [agentId];
  if (status) {
    params.push(status);
    clauses.push(`status = $${params.length}`);
  }
  params.push(limit);
  return mapRows<IdeaRow>(
    await query(
      `SELECT * FROM content_ideas WHERE ${clauses.join(' AND ')}
        ORDER BY status = 'unused' DESC, score DESC, created_at DESC LIMIT $${params.length}`,
      params,
    ),
  );
}

export async function counts(agentId: string): Promise<Record<string, number>> {
  const rows = await query<{ status: string; n: number }>(
    'SELECT status, count(*)::int AS n FROM content_ideas WHERE agent_id = $1 GROUP BY status',
    [agentId],
  );
  const result: Record<string, number> = { unused: 0, drafting: 0, used: 0, discarded: 0 };
  for (const row of rows) result[row.status] = row.n;
  return result;
}

/**
 * The best unused idea.
 *
 * Claimed by moving it to drafting in the same statement, so two scheduled
 * posts cannot pick up the same thought.
 */
export async function claimBestIdea(agentId: string): Promise<IdeaRow | null> {
  return mapRow<IdeaRow>(
    await queryOne(
      `UPDATE content_ideas SET status = 'drafting', updated_at = now()
        WHERE id = (
          SELECT id FROM content_ideas
           WHERE agent_id = $1 AND status = 'unused'
           ORDER BY score DESC, created_at
           LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
      [agentId],
    ),
  );
}

export async function resolveIdea(id: string, status: 'used' | 'discarded' | 'unused', jobId?: string | null): Promise<void> {
  await query(
    `UPDATE content_ideas
        SET status = $2, used_job_id = $3,
            used_at = CASE WHEN $2 = 'used' THEN now() ELSE NULL END,
            updated_at = now()
      WHERE id = $1`,
    [id, status, jobId ?? null],
  );
}

/** Stops the same thought being captured twice from two conversations. */
export async function similarExists(agentId: string, summary: string): Promise<boolean> {
  const row = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM content_ideas
      WHERE agent_id = $1 AND status <> 'discarded'
        AND lower(summary) = lower($2)`,
    [agentId, summary.slice(0, 500)],
  );
  return (row?.n ?? 0) > 0;
}
