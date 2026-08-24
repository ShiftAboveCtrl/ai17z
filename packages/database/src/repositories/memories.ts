import type { MemoryRecord, MemoryScope, MemoryType, RetrievedMemory } from '@xbam/shared/contracts';
import { NotFoundError, sha256Hex } from '@xbam/shared';
import { query, queryOne, type Tx } from '../pool';
import { mapRow, mapRows } from '../mapper';

const COLUMNS = `
  id, agent_id, scope, memory_type, account_id, conversation_id, remote_user_id, remote_handle,
  content, summary, importance, confidence, pinned, source_event_id, source_job_id,
  created_at, updated_at, last_accessed_at, expires_at`;

export interface WriteMemoryInput {
  agentId: string;
  scope: MemoryScope;
  memoryType: MemoryType;
  content: string;
  summary?: string | null;
  accountId?: string | null;
  conversationId?: string | null;
  remoteUserId?: string | null;
  remoteHandle?: string | null;
  importance?: number;
  confidence?: number;
  pinned?: boolean;
  sourceEventId?: string | null;
  sourceJobId?: string | null;
  expiresAt?: string | null;
}

/**
 * The dedupe bucket a memory lives in. THREAD memories dedupe per conversation,
 * USER memories per remote handle, everything else per agent. Without this the
 * unique index would either collapse unrelated memories or never fire at all.
 */
export function scopeKeyFor(input: WriteMemoryInput): string {
  switch (input.scope) {
    case 'THREAD':
      return `conversation:${input.conversationId ?? 'none'}`;
    case 'USER':
      return `user:${(input.remoteHandle ?? input.remoteUserId ?? 'unknown').toLowerCase()}`;
    case 'ACCOUNT':
      return `account:${input.accountId ?? 'none'}`;
    default:
      return input.scope.toLowerCase();
  }
}

function normalizeForHash(content: string): string {
  return content.trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface WriteMemoryResult {
  memory: MemoryRecord;
  created: boolean;
}

/** Idempotent write: identical content in the same bucket updates rather than duplicates. */
export async function writeMemory(input: WriteMemoryInput, executor?: Tx): Promise<WriteMemoryResult> {
  const scopeKey = scopeKeyFor(input);
  const contentHash = sha256Hex(normalizeForHash(input.content));
  const params = [
    input.agentId,
    input.scope,
    input.memoryType,
    input.accountId ?? null,
    input.conversationId ?? null,
    input.remoteUserId ?? null,
    input.remoteHandle ?? null,
    input.content,
    input.summary ?? null,
    input.importance ?? 0.5,
    input.confidence ?? 0.8,
    input.pinned ?? false,
    input.sourceEventId ?? null,
    input.sourceJobId ?? null,
    contentHash,
    scopeKey,
    input.expiresAt ?? null,
  ];
  const sql = `
    INSERT INTO memories (agent_id, scope, memory_type, account_id, conversation_id, remote_user_id,
      remote_handle, content, summary, importance, confidence, pinned, source_event_id, source_job_id,
      content_hash, scope_key, expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    ON CONFLICT (agent_id, scope, scope_key, content_hash) DO UPDATE
      SET importance = greatest(memories.importance, excluded.importance),
          summary = coalesce(excluded.summary, memories.summary),
          updated_at = now()
    RETURNING ${COLUMNS}, (xmax = 0) AS inserted`;
  const row = executor ? await executor.one(sql, params) : await queryOne(sql, params);
  const memory = mapRow<MemoryRecord & { inserted: boolean }>(row) as MemoryRecord & { inserted: boolean };
  return { memory, created: memory.inserted === true };
}

export async function getMemory(id: string): Promise<MemoryRecord | null> {
  return mapRow<MemoryRecord>(await queryOne(`SELECT ${COLUMNS} FROM memories WHERE id = $1`, [id]));
}

export async function updateMemory(
  id: string,
  patch: Partial<{ content: string; summary: string | null; importance: number; pinned: boolean; expiresAt: string | null }>,
): Promise<MemoryRecord> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const push = (fragment: string, value: unknown) => {
    params.push(value);
    sets.push(fragment.replace('$?', `$${params.length}`));
  };
  if (patch.content !== undefined) {
    push('content = $?', patch.content);
    push('content_hash = $?', sha256Hex(normalizeForHash(patch.content)));
  }
  if (patch.summary !== undefined) push('summary = $?', patch.summary);
  if (patch.importance !== undefined) push('importance = $?', patch.importance);
  if (patch.pinned !== undefined) push('pinned = $?', patch.pinned);
  if (patch.expiresAt !== undefined) push('expires_at = $?', patch.expiresAt);
  if (sets.length === 0) {
    const existing = await getMemory(id);
    if (!existing) throw new NotFoundError('Memory');
    return existing;
  }
  const row = await queryOne(
    `UPDATE memories SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
    params,
  );
  if (!row) throw new NotFoundError('Memory');
  return mapRow<MemoryRecord>(row) as MemoryRecord;
}

export async function deleteMemory(id: string): Promise<void> {
  await query('DELETE FROM memories WHERE id = $1', [id]);
}

export async function purgeExpiredMemories(): Promise<number> {
  const rows = await query('DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < now() RETURNING id');
  return rows.length;
}

export interface MemorySearchFilters {
  agentId: string;
  scopes?: MemoryScope[];
  handle?: string;
  conversationId?: string;
  search?: string;
  pinnedOnly?: boolean;
  limit?: number;
  offset?: number;
}

export async function searchMemories(
  filters: MemorySearchFilters,
): Promise<{ items: MemoryRecord[]; total: number }> {
  const conditions = ['agent_id = $1'];
  const params: unknown[] = [filters.agentId];
  const add = (fragment: string, value: unknown) => {
    params.push(value);
    conditions.push(fragment.replace('$?', `$${params.length}`));
  };
  if (filters.scopes?.length) add('scope = ANY($?::text[])', filters.scopes);
  if (filters.handle) add('lower(remote_handle) = lower($?)', filters.handle);
  if (filters.conversationId) add('conversation_id = $?', filters.conversationId);
  if (filters.pinnedOnly) conditions.push('pinned');
  if (filters.search) add('content ILIKE $?', `%${filters.search}%`);
  const where = `WHERE ${conditions.join(' AND ')}`;

  const totalRow = await queryOne<{ count: number }>(`SELECT count(*)::int AS count FROM memories ${where}`, params);
  params.push(filters.limit ?? 50, filters.offset ?? 0);
  const rows = await query(
    `SELECT ${COLUMNS} FROM memories ${where}
      ORDER BY pinned DESC, created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { items: mapRows<MemoryRecord>(rows), total: totalRow?.count ?? 0 };
}

export interface ScopedQuery {
  agentId: string;
  limit: number;
  conversationId?: string | null;
  remoteHandle?: string | null;
  accountId?: string | null;
  keywords?: string[];
}

const LIVE = 'AND (expires_at IS NULL OR expires_at > now())';

export async function selectThreadMemories(q: ScopedQuery): Promise<MemoryRecord[]> {
  if (!q.conversationId) return [];
  return mapRows<MemoryRecord>(
    await query(
      `SELECT ${COLUMNS} FROM memories
        WHERE agent_id = $1 AND scope = 'THREAD' AND conversation_id = $2 ${LIVE}
        ORDER BY created_at DESC LIMIT $3`,
      [q.agentId, q.conversationId, q.limit],
    ),
  );
}

export async function selectUserMemories(q: ScopedQuery): Promise<MemoryRecord[]> {
  if (!q.remoteHandle) return [];
  return mapRows<MemoryRecord>(
    await query(
      `SELECT ${COLUMNS} FROM memories
        WHERE agent_id = $1 AND scope = 'USER' AND lower(remote_handle) = lower($2) ${LIVE}
        ORDER BY pinned DESC, importance DESC, created_at DESC LIMIT $3`,
      [q.agentId, q.remoteHandle, q.limit],
    ),
  );
}

export async function selectAccountMemories(q: ScopedQuery): Promise<MemoryRecord[]> {
  if (!q.accountId) return [];
  return mapRows<MemoryRecord>(
    await query(
      `SELECT ${COLUMNS} FROM memories
        WHERE agent_id = $1 AND scope = 'ACCOUNT' AND account_id = $2 ${LIVE}
        ORDER BY pinned DESC, importance DESC, created_at DESC LIMIT $3`,
      [q.agentId, q.accountId, q.limit],
    ),
  );
}

/**
 * Keyword-relevant selection for PERSONA / KNOWLEDGE / EPISODIC. Deterministic by
 * design: pinned first, then full-text rank, then importance. Vector search can be
 * added later without changing this contract.
 */
export async function selectRelevantMemories(scope: MemoryScope, q: ScopedQuery): Promise<MemoryRecord[]> {
  const terms = (q.keywords ?? []).filter(Boolean);
  if (terms.length === 0) {
    return mapRows<MemoryRecord>(
      await query(
        `SELECT ${COLUMNS} FROM memories
          WHERE agent_id = $1 AND scope = $2 ${LIVE}
          ORDER BY pinned DESC, importance DESC, created_at DESC LIMIT $3`,
        [q.agentId, scope, q.limit],
      ),
    );
  }
  const tsquery = terms.map((t) => t.replace(/[^\p{L}\p{N}_]/gu, '')).filter(Boolean).join(' | ');
  return mapRows<MemoryRecord>(
    await query(
      `SELECT ${COLUMNS},
              ts_rank(to_tsvector('simple', content), to_tsquery('simple', $3)) AS rank
         FROM memories
        WHERE agent_id = $1 AND scope = $2 ${LIVE}
          AND (pinned OR to_tsvector('simple', content) @@ to_tsquery('simple', $3))
        ORDER BY pinned DESC, rank DESC, importance DESC, created_at DESC
        LIMIT $4`,
      [q.agentId, scope, tsquery || 'xbam_no_match', q.limit],
    ),
  );
}

export async function touchAccessed(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await query('UPDATE memories SET last_accessed_at = now() WHERE id = ANY($1::uuid[])', [ids]);
}

export async function recordRetrievals(jobId: string, retrieved: RetrievedMemory[], executor?: Tx): Promise<void> {
  for (const item of retrieved) {
    const sql = `INSERT INTO memory_retrievals (job_id, memory_id, rank, score, reason)
                 VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT (job_id, memory_id) DO UPDATE
                   SET rank = excluded.rank, score = excluded.score, reason = excluded.reason`;
    const params = [jobId, item.memoryId, item.rank, item.score, item.reason];
    if (executor) await executor.query(sql, params);
    else await query(sql, params);
  }
}

export async function listRetrievals(jobId: string): Promise<RetrievedMemory[]> {
  const rows = await query(
    `SELECT mr.memory_id, mr.rank, mr.score, mr.reason,
            m.scope, m.memory_type, m.content, m.summary, m.importance, m.created_at
       FROM memory_retrievals mr JOIN memories m ON m.id = mr.memory_id
      WHERE mr.job_id = $1 ORDER BY mr.rank`,
    [jobId],
  );
  return mapRows<RetrievedMemory>(rows);
}
