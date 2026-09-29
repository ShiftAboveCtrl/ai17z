/**
 * Knowledge sources: the documents an agent has been taught from.
 *
 * A source owns its chunks. Removing one removes what it taught, which the
 * foreign key does rather than application code, because an agent that goes on
 * citing documents its owner withdrew is worse than one that knows nothing.
 */
import { query, queryOne, type Tx } from '../pool';
import { mapRow, mapRows } from '../mapper';

export const KNOWLEDGE_SOURCE_KINDS = ['UPLOAD', 'PATH', 'TEXT', 'URL', 'DOCUMENTATION_SITE', 'GITHUB_REPOSITORY'] as const;
export type KnowledgeSourceKind = (typeof KNOWLEDGE_SOURCE_KINDS)[number];

export const KNOWLEDGE_DOC_KINDS = ['DOC', 'SOURCE', 'README', 'PAGE'] as const;
export type KnowledgeDocKind = (typeof KNOWLEDGE_DOC_KINDS)[number];

/** What a collection is, so answers never mix two generations of one product. */
export interface KnowledgeLabels {
  version?: string | null;
  generation?: string | null;
  effectiveDate?: string | null;
  authority?: 'OFFICIAL' | 'COMMUNITY' | 'OWNER' | null;
}

export interface KnowledgeChange {
  added: number;
  changed: number;
  removed: number;
  unchanged: number;
  at: string;
}

export interface KnowledgeSourceRecord {
  id: string;
  agentId: string;
  name: string;
  kind: KnowledgeSourceKind;
  location: string | null;
  include: string[];
  /** What the source was when last read: a commit, a release, a date. */
  revision: string | null;
  enabled: boolean;
  indexedAt: string | null;
  documentCount: number;
  chunkCount: number;
  lastError: string | null;
  /** Null means this source is only re-read when somebody asks. */
  refreshIntervalMinutes: number | null;
  nextRefreshAt: string | null;
  config: Record<string, unknown>;
  labels: KnowledgeLabels;
  refreshingSince: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  errorKind: 'FAILED' | 'UNAVAILABLE' | null;
  lastChange: KnowledgeChange | null;
  createdAt: string;
  updatedAt: string;
}

const COLUMNS = `
  id, agent_id, name, kind, location, include, revision, enabled,
  indexed_at, document_count, chunk_count, last_error,
  refresh_interval_minutes, next_refresh_at, config, labels, refreshing_since,
  last_attempt_at, last_success_at, error_kind, last_change, created_at, updated_at`;

export interface CreateKnowledgeSourceInput {
  agentId: string;
  name: string;
  kind: KnowledgeSourceKind;
  location?: string | null;
  include?: string[];
  refreshIntervalMinutes?: number | null;
  config?: Record<string, unknown>;
  labels?: KnowledgeLabels;
}

export async function createSource(input: CreateKnowledgeSourceInput): Promise<KnowledgeSourceRecord> {
  const row = await queryOne(
    `INSERT INTO knowledge_sources (agent_id, name, kind, location, include, refresh_interval_minutes, next_refresh_at, config, labels)
     VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $6::int IS NULL THEN NULL ELSE now() END, $7::jsonb, $8::jsonb)
     RETURNING ${COLUMNS}`,
    [
      input.agentId,
      input.name.trim(),
      input.kind,
      input.location ?? null,
      input.include ?? [],
      input.refreshIntervalMinutes ?? null,
      JSON.stringify(input.config ?? {}),
      JSON.stringify(input.labels ?? {}),
    ],
  );
  return mapRow<KnowledgeSourceRecord>(row)!;
}

export async function listSources(agentId: string): Promise<KnowledgeSourceRecord[]> {
  return mapRows<KnowledgeSourceRecord>(
    await query(`SELECT ${COLUMNS} FROM knowledge_sources WHERE agent_id = $1 ORDER BY created_at`, [agentId]),
  );
}

export async function getSource(id: string): Promise<KnowledgeSourceRecord | null> {
  return mapRow<KnowledgeSourceRecord>(await queryOne(`SELECT ${COLUMNS} FROM knowledge_sources WHERE id = $1`, [id]));
}

/** Sources an agent may actually be answered from. */
export async function enabledSources(agentId: string): Promise<KnowledgeSourceRecord[]> {
  return mapRows<KnowledgeSourceRecord>(
    await query(`SELECT ${COLUMNS} FROM knowledge_sources WHERE agent_id = $1 AND enabled ORDER BY created_at`, [
      agentId,
    ]),
  );
}

export interface UpdateKnowledgeSourceInput {
  name?: string;
  location?: string | null;
  include?: string[];
  enabled?: boolean;
  revision?: string | null;
  indexedAt?: string | null;
  documentCount?: number;
  chunkCount?: number;
  /** Explicit null clears a previous failure; undefined leaves it alone. */
  lastError?: string | null;
  refreshIntervalMinutes?: number | null;
  nextRefreshAt?: string | null;
  config?: Record<string, unknown>;
  labels?: KnowledgeLabels;
  refreshingSince?: string | null;
  lastAttemptAt?: string | null;
  lastSuccessAt?: string | null;
  errorKind?: 'FAILED' | 'UNAVAILABLE' | null;
  lastChange?: KnowledgeChange | null;
}

export async function updateSource(id: string, input: UpdateKnowledgeSourceInput): Promise<KnowledgeSourceRecord> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (input.name !== undefined) set('name', input.name.trim());
  if (input.location !== undefined) set('location', input.location);
  if (input.include !== undefined) set('include', input.include);
  if (input.enabled !== undefined) set('enabled', input.enabled);
  if (input.revision !== undefined) set('revision', input.revision);
  if (input.indexedAt !== undefined) set('indexed_at', input.indexedAt);
  if (input.documentCount !== undefined) set('document_count', input.documentCount);
  if (input.chunkCount !== undefined) set('chunk_count', input.chunkCount);
  if (input.lastError !== undefined) set('last_error', input.lastError);
  if (input.refreshIntervalMinutes !== undefined) set('refresh_interval_minutes', input.refreshIntervalMinutes);
  if (input.nextRefreshAt !== undefined) set('next_refresh_at', input.nextRefreshAt);
  if (input.config !== undefined) set('config', JSON.stringify(input.config));
  if (input.labels !== undefined) set('labels', JSON.stringify(input.labels));
  if (input.refreshingSince !== undefined) set('refreshing_since', input.refreshingSince);
  if (input.lastAttemptAt !== undefined) set('last_attempt_at', input.lastAttemptAt);
  if (input.lastSuccessAt !== undefined) set('last_success_at', input.lastSuccessAt);
  if (input.errorKind !== undefined) set('error_kind', input.errorKind);
  if (input.lastChange !== undefined) set('last_change', input.lastChange === null ? null : JSON.stringify(input.lastChange));

  if (sets.length === 0) return (await getSource(id))!;

  const row = await queryOne(
    `UPDATE knowledge_sources SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
    params,
  );
  return mapRow<KnowledgeSourceRecord>(row)!;
}

/**
 * Sources whose refresh has come round, claimed as they are read.
 *
 * `next_refresh_at` moves forward in the same statement that selects the row,
 * which is what stops two workers re-reading one source and stops a restart
 * refreshing everything at once. The same shape as the account poller, and for
 * the same reasons.
 */
export async function claimDueForRefresh(limit = 5): Promise<KnowledgeSourceRecord[]> {
  return mapRows<KnowledgeSourceRecord>(
    await query(
      `UPDATE knowledge_sources
          -- A source with no schedule was queued to be read once (a collection
          -- just created, or an owner pressing refresh): claiming it clears the
          -- stamp rather than setting another.
          SET next_refresh_at = CASE WHEN refresh_interval_minutes IS NULL THEN NULL
                                     ELSE now() + (refresh_interval_minutes * interval '1 minute') END
        WHERE id IN (
          SELECT id FROM knowledge_sources
           WHERE enabled
             AND next_refresh_at IS NOT NULL
             AND next_refresh_at <= now()
           ORDER BY next_refresh_at
           FOR UPDATE SKIP LOCKED
           LIMIT $1
        )
        RETURNING ${COLUMNS}`,
      [limit],
    ),
  );
}

export async function deleteSource(id: string): Promise<void> {
  await query('DELETE FROM knowledge_sources WHERE id = $1', [id]);
}

/**
 * Remove chunks this source produced that the latest read did not.
 *
 * A refresh writes everything it found, then this deletes what it did not find.
 * Doing it in that order means a document is never briefly missing from an
 * agent that is answering questions while its source is being re-read.
 */
export async function pruneChunks(sourceId: string, keepHashes: string[], executor?: Tx): Promise<number> {
  const sql = `DELETE FROM memories
     WHERE knowledge_source_id = $1
       AND ($2::text[] = '{}' OR NOT (content_hash = ANY($2::text[])))
     RETURNING id`;
  const params = [sourceId, keepHashes];
  // A transaction's query returns a result object; the pool's returns rows.
  const result = executor ? await executor.query(sql, params) : await query(sql, params);
  return Array.isArray(result) ? result.length : result.rows.length;
}

/** Everything this source currently teaches, for the "what was indexed" view. */
export async function listChunks(
  sourceId: string,
  limit = 200,
): Promise<{ id: string; content: string; origin: Record<string, unknown> | null }[]> {
  return mapRows(
    await query(
      `SELECT id, content, origin FROM memories
       WHERE knowledge_source_id = $1
       ORDER BY origin->>'path', origin->>'heading'
       LIMIT $2`,
      [sourceId, limit],
    ),
  );
}

/** How many chunks a source currently has, for reporting after a refresh. */
export async function countChunks(sourceId: string): Promise<number> {
  const row = await queryOne('SELECT count(*)::int AS n FROM memories WHERE knowledge_source_id = $1', [sourceId]);
  return (row as { n?: number } | null)?.n ?? 0;
}


// -- Documents a collection holds ----------------------------------------------

export interface KnowledgeDocumentRow {
  id: string;
  sourceId: string;
  docKey: string;
  title: string | null;
  docKind: KnowledgeDocKind;
  revision: string;
  contentHash: string;
  chunkCount: number;
  fetchedAt: string;
}

export async function listDocuments(sourceId: string): Promise<KnowledgeDocumentRow[]> {
  return mapRows<KnowledgeDocumentRow>(
    await query('SELECT * FROM knowledge_documents WHERE source_id = $1 ORDER BY doc_key', [sourceId]),
  );
}

export async function upsertDocument(input: {
  sourceId: string;
  docKey: string;
  title: string | null;
  docKind: KnowledgeDocKind;
  revision: string;
  contentHash: string;
  chunkCount: number;
}): Promise<void> {
  await query(
    `INSERT INTO knowledge_documents (source_id, doc_key, title, doc_kind, revision, content_hash, chunk_count, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (source_id, doc_key) DO UPDATE
       SET title = excluded.title, doc_kind = excluded.doc_kind, revision = excluded.revision,
           content_hash = excluded.content_hash, chunk_count = excluded.chunk_count, fetched_at = now()`,
    [input.sourceId, input.docKey, input.title, input.docKind, input.revision, input.contentHash, input.chunkCount],
  );
}

/** Marks unchanged documents as checked, without rewriting anything. */
export async function touchDocuments(sourceId: string, docKeys: string[]): Promise<void> {
  if (docKeys.length === 0) return;
  await query('UPDATE knowledge_documents SET fetched_at = now() WHERE source_id = $1 AND doc_key = ANY($2::text[])', [
    sourceId,
    docKeys,
  ]);
}

/**
 * Removes one document's chunks that a re-read did not produce again.
 *
 * Per document, so a refresh that re-read three changed pages of a two-hundred
 * page site leaves the other hundred and ninety-seven exactly as they were.
 */
export async function pruneDocumentChunks(sourceId: string, docKey: string, keepHashes: string[]): Promise<number> {
  const rows = await query(
    `DELETE FROM memories
      WHERE knowledge_source_id = $1 AND origin->>'path' = $2
        AND ($3::text[] = '{}' OR NOT (content_hash = ANY($3::text[])))
      RETURNING id`,
    [sourceId, docKey, keepHashes],
  );
  return rows.length;
}

/** Removes documents that are gone from the source, and everything they taught. */
export async function removeDocuments(sourceId: string, docKeys: string[]): Promise<number> {
  if (docKeys.length === 0) return 0;
  const chunks = await query(
    `DELETE FROM memories WHERE knowledge_source_id = $1 AND origin->>'path' = ANY($2::text[]) RETURNING id`,
    [sourceId, docKeys],
  );
  await query('DELETE FROM knowledge_documents WHERE source_id = $1 AND doc_key = ANY($2::text[])', [sourceId, docKeys]);
  return chunks.length;
}
