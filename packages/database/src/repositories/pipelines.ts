import type { PipelineDraft, PipelineEdge, PipelineNode } from '@xbam/shared/contracts';
import { NotFoundError } from '@xbam/shared';
import { query, queryOne, withTransaction } from '../pool';
import { mapRows } from '../mapper';

export interface PipelineVersionRecord {
  id: string;
  pipelineId: string;
  agentId: string;
  version: number;
  name: string;
  changeNote: string;
  createdAt: string;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
}

async function loadGraph(pipelineVersionId: string): Promise<{ nodes: PipelineNode[]; edges: PipelineEdge[] }> {
  const nodeRows = await query(
    `SELECT key, kind, label, config, position_x AS x, position_y AS y
       FROM pipeline_nodes WHERE pipeline_version_id = $1 ORDER BY sort_order, key`,
    [pipelineVersionId],
  );
  const edgeRows = await query(
    `SELECT from_key AS "from", to_key AS "to", branch, condition FROM pipeline_edges WHERE pipeline_version_id = $1`,
    [pipelineVersionId],
  );
  return { nodes: mapRows<PipelineNode>(nodeRows), edges: edgeRows as unknown as PipelineEdge[] };
}

export async function getPipelineVersion(id: string): Promise<PipelineVersionRecord | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT pv.id, pv.pipeline_id, p.agent_id, pv.version, pv.name, pv.change_note, pv.created_at
       FROM pipeline_versions pv JOIN pipelines p ON p.id = pv.pipeline_id WHERE pv.id = $1`,
    [id],
  );
  if (!row) return null;
  const graph = await loadGraph(id);
  return {
    id: row.id as string,
    pipelineId: row.pipeline_id as string,
    agentId: row.agent_id as string,
    version: row.version as number,
    name: row.name as string,
    changeNote: row.change_note as string,
    createdAt: (row.created_at as Date).toISOString(),
    ...graph,
  };
}

export async function getActivePipeline(agentId: string): Promise<PipelineVersionRecord | null> {
  const row = await queryOne<{ id: string }>('SELECT pipeline_version_id AS id FROM agents WHERE id = $1', [agentId]);
  if (!row?.id) return null;
  return getPipelineVersion(row.id);
}

export async function listPipelineVersions(agentId: string): Promise<PipelineVersionRecord[]> {
  const rows = await query<{ id: string }>(
    `SELECT pv.id FROM pipelines p JOIN pipeline_versions pv ON pv.pipeline_id = p.id
      WHERE p.agent_id = $1 ORDER BY pv.version DESC`,
    [agentId],
  );
  const out: PipelineVersionRecord[] = [];
  for (const row of rows) {
    const record = await getPipelineVersion(row.id);
    if (record) out.push(record);
  }
  return out;
}

/** Saves a new pipeline version and points the agent at it. Graphs are immutable. */
export async function savePipelineVersion(
  agentId: string,
  draft: PipelineDraft,
  createdBy: string | null,
): Promise<PipelineVersionRecord> {
  const id = await withTransaction(async (tx) => {
    let pipeline = await tx.one<{ id: string }>('SELECT id FROM pipelines WHERE agent_id = $1', [agentId]);
    if (!pipeline) {
      pipeline = await tx.one<{ id: string }>('INSERT INTO pipelines (agent_id) VALUES ($1) RETURNING id', [agentId]);
    }
    if (!pipeline) throw new NotFoundError('Pipeline');

    const next = await tx.one<{ next: number }>(
      'SELECT coalesce(max(version), 0) + 1 AS next FROM pipeline_versions WHERE pipeline_id = $1',
      [pipeline.id],
    );
    const versionRow = await tx.one<{ id: string }>(
      `INSERT INTO pipeline_versions (pipeline_id, version, name, change_note, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [pipeline.id, next?.next ?? 1, draft.name, draft.changeNote, createdBy],
    );
    const versionId = versionRow!.id;

    let order = 0;
    for (const node of draft.nodes) {
      await tx.query(
        `INSERT INTO pipeline_nodes (pipeline_version_id, key, kind, label, config, position_x, position_y, sort_order)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
        [versionId, node.key, node.kind, node.label, JSON.stringify(node.config ?? {}), node.x, node.y, order],
      );
      order += 1;
    }
    const nodeKeys = new Set(draft.nodes.map((n) => n.key));
    for (const edge of draft.edges) {
      if (!nodeKeys.has(edge.from) || !nodeKeys.has(edge.to)) {
        throw new NotFoundError(`Pipeline edge endpoint ${edge.from} -> ${edge.to}`);
      }
      await tx.query(
        'INSERT INTO pipeline_edges (pipeline_version_id, from_key, to_key, branch, condition) VALUES ($1,$2,$3,$4,$5)',
        [versionId, edge.from, edge.to, edge.branch ?? 'next', edge.condition ?? null],
      );
    }
    await tx.query('UPDATE agents SET pipeline_version_id = $2, updated_at = now() WHERE id = $1', [
      agentId,
      versionId,
    ]);
    return versionId;
  });
  return (await getPipelineVersion(id)) as PipelineVersionRecord;
}

/** Agents that have a pipeline at all, for an upgrade pass over them. */
export async function agentsWithPipelines(): Promise<string[]> {
  const rows = await query<{ agent_id: string }>(
    'SELECT DISTINCT agent_id FROM pipelines ORDER BY agent_id',
  );
  return rows.map((r) => r.agent_id);
}
