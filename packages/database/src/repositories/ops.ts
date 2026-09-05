import { query, queryOne } from '../pool';
import { mapRow, mapRows } from '../mapper';

export async function getSetting<T = unknown>(key: string): Promise<T | null> {
  const row = await queryOne<{ value: T }>('SELECT value FROM app_settings WHERE key = $1', [key]);
  return row ? row.value : null;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

export async function audit(input: {
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  data?: Record<string, unknown>;
}): Promise<void> {
  await query(
    'INSERT INTO audit_events (actor_user_id, action, entity_type, entity_id, data) VALUES ($1,$2,$3,$4,$5::jsonb)',
    [input.actorUserId, input.action, input.entityType, input.entityId ?? null, JSON.stringify(input.data ?? {})],
  );
}

export interface ArtifactRow {
  id: string;
  kind: string;
  jobId: string | null;
  actionId: string | null;
  accountId: string | null;
  agentId: string | null;
  mimeType: string;
  relPath: string;
  bytes: number;
  meta: Record<string, unknown>;
  createdAt: string;
}

export async function createArtifact(input: {
  kind: 'SCREENSHOT' | 'PORTRAIT' | 'UPLOAD' | 'EXPORT' | 'HTML_SNAPSHOT';
  jobId?: string | null;
  actionId?: string | null;
  accountId?: string | null;
  agentId?: string | null;
  mimeType: string;
  relPath: string;
  bytes: number;
  meta?: Record<string, unknown>;
}): Promise<ArtifactRow> {
  const row = await queryOne(
    `INSERT INTO artifacts (kind, job_id, action_id, account_id, agent_id, mime_type, rel_path, bytes, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *`,
    [
      input.kind,
      input.jobId ?? null,
      input.actionId ?? null,
      input.accountId ?? null,
      input.agentId ?? null,
      input.mimeType,
      input.relPath,
      input.bytes,
      JSON.stringify(input.meta ?? {}),
    ],
  );
  return mapRow<ArtifactRow>(row) as ArtifactRow;
}

/**
 * Removes the row for an artifact that has been replaced.
 *
 * Returns it, so the caller can delete the file it points at. The row goes
 * first: a row with no file is a broken image, and a file with no row is bytes
 * nothing can reach, and only one of those is recoverable.
 */
export async function deleteArtifact(id: string): Promise<ArtifactRow | null> {
  return mapRow<ArtifactRow>(await queryOne('DELETE FROM artifacts WHERE id = $1 RETURNING *', [id]));
}

export async function getArtifact(id: string): Promise<ArtifactRow | null> {
  return mapRow<ArtifactRow>(await queryOne('SELECT * FROM artifacts WHERE id = $1', [id]));
}

export interface DiagnosticRow {
  id: string;
  jobId: string | null;
  actionId: string | null;
  accountId: string | null;
  channel: string;
  kind: string;
  url: string | null;
  targetRef: string | null;
  errorClass: string | null;
  message: string;
  artifactId: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
}

export async function createDiagnostic(input: {
  jobId?: string | null;
  actionId?: string | null;
  accountId?: string | null;
  channel: string;
  kind: string;
  url?: string | null;
  targetRef?: string | null;
  errorClass?: string | null;
  message: string;
  artifactId?: string | null;
  meta?: Record<string, unknown>;
}): Promise<DiagnosticRow> {
  const row = await queryOne(
    `INSERT INTO diagnostics (job_id, action_id, account_id, channel, kind, url, target_ref,
       error_class, message, artifact_id, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING *`,
    [
      input.jobId ?? null,
      input.actionId ?? null,
      input.accountId ?? null,
      input.channel,
      input.kind,
      input.url ?? null,
      input.targetRef ?? null,
      input.errorClass ?? null,
      input.message,
      input.artifactId ?? null,
      JSON.stringify(input.meta ?? {}),
    ],
  );
  return mapRow<DiagnosticRow>(row) as DiagnosticRow;
}

export async function listDiagnostics(filters: { jobId?: string; accountId?: string; limit?: number }): Promise<DiagnosticRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.jobId) {
    params.push(filters.jobId);
    conditions.push(`job_id = $${params.length}`);
  }
  if (filters.accountId) {
    params.push(filters.accountId);
    conditions.push(`account_id = $${params.length}`);
  }
  params.push(filters.limit ?? 50);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return mapRows<DiagnosticRow>(
    await query(`SELECT * FROM diagnostics ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params),
  );
}

export interface ToolRow {
  id: string;
  key: string;
  name: string;
  description: string;
  kind: string;
  inputSchema: Record<string, unknown>;
  enabledGlobally: boolean;
  createdAt: string;
}

export async function upsertTool(input: {
  key: string;
  name: string;
  description: string;
  kind: 'BUILTIN' | 'HTTP' | 'CUSTOM';
  inputSchema: Record<string, unknown>;
}): Promise<ToolRow> {
  const row = await queryOne(
    `INSERT INTO tools (key, name, description, kind, input_schema)
     VALUES ($1,$2,$3,$4,$5::jsonb)
     ON CONFLICT (key) DO UPDATE SET name = excluded.name, description = excluded.description,
       kind = excluded.kind, input_schema = excluded.input_schema
     RETURNING *`,
    [input.key, input.name, input.description, input.kind, JSON.stringify(input.inputSchema)],
  );
  return mapRow<ToolRow>(row) as ToolRow;
}

export async function listTools(): Promise<ToolRow[]> {
  return mapRows<ToolRow>(await query('SELECT * FROM tools ORDER BY key'));
}

export interface AgentToolRow extends ToolRow {
  enabled: boolean;
  config: Record<string, unknown>;
}

export async function listAgentTools(agentId: string): Promise<AgentToolRow[]> {
  const rows = await query(
    `SELECT t.*, coalesce(at.enabled, false) AS enabled, coalesce(at.config, '{}'::jsonb) AS config
       FROM tools t LEFT JOIN agent_tools at ON at.tool_id = t.id AND at.agent_id = $1
      ORDER BY t.key`,
    [agentId],
  );
  return mapRows<AgentToolRow>(rows);
}

export async function setAgentTool(input: {
  agentId: string;
  toolKey: string;
  enabled: boolean;
  config?: Record<string, unknown>;
}): Promise<void> {
  await query(
    `INSERT INTO agent_tools (agent_id, tool_id, enabled, config)
     SELECT $1, t.id, $3, $4::jsonb FROM tools t WHERE t.key = $2
     ON CONFLICT (agent_id, tool_id) DO UPDATE SET enabled = excluded.enabled, config = excluded.config`,
    [input.agentId, input.toolKey, input.enabled, JSON.stringify(input.config ?? {})],
  );
}

export interface ImportRunRow {
  id: string;
  source: string;
  agentId: string | null;
  status: string;
  report: Record<string, unknown>;
  startedAt: string;
  finishedAt: string | null;
}

export async function startImportRun(source: string, agentId: string | null): Promise<string> {
  const row = await queryOne<{ id: string }>(
    'INSERT INTO import_runs (source, agent_id) VALUES ($1,$2) RETURNING id',
    [source, agentId],
  );
  return row!.id;
}

export async function finishImportRun(
  id: string,
  status: 'COMPLETED' | 'FAILED',
  report: Record<string, unknown>,
  agentId?: string | null,
): Promise<void> {
  await query(
    `UPDATE import_runs SET status = $2, report = $3::jsonb, agent_id = coalesce($4, agent_id), finished_at = now()
      WHERE id = $1`,
    [id, status, JSON.stringify(report), agentId ?? null],
  );
}

export async function listImportRuns(): Promise<ImportRunRow[]> {
  return mapRows<ImportRunRow>(await query('SELECT * FROM import_runs ORDER BY started_at DESC LIMIT 50'));
}

/** Records that a legacy natural key has been imported, so re-runs update in place. */
export async function rememberImport(input: {
  source: string;
  entityType: string;
  naturalKey: string;
  entityId: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO import_fingerprints (source, entity_type, natural_key, entity_id)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (source, entity_type, natural_key) DO UPDATE SET entity_id = excluded.entity_id`,
    [input.source, input.entityType, input.naturalKey, input.entityId],
  );
}

export async function importedKeys(source: string, entityType: string): Promise<Set<string>> {
  const rows = await query<{ natural_key: string }>(
    'SELECT natural_key FROM import_fingerprints WHERE source = $1 AND entity_type = $2',
    [source, entityType],
  );
  return new Set(rows.map((r) => r.natural_key));
}
