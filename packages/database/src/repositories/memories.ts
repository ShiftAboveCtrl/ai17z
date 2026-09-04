import type { MemoryRecord, MemoryScope, MemoryType, RetrievedMemory } from '@xbam/shared/contracts';
import { NotFoundError, sha256Hex } from '@xbam/shared';
import { query, queryOne, type Tx } from '../pool';
import { mapRow, mapRows } from '../mapper';

const COLUMNS = `
  id, agent_id, scope, memory_type, account_id, conversation_id, remote_user_id, remote_handle,
  content, summary, importance, confidence, pinned, source_event_id, source_job_id,
  created_at, updated_at, last_accessed_at, expires_at, knowledge_source_id, origin`;

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
  /** The knowledge source that taught this, when it came from one. */
  knowledgeSourceId?: string | null;
  /** Where in that source: { path, heading, revision, modifiedAt }. */
  origin?: Record<string, unknown> | null;
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
    // Per source, so two sources teaching the same sentence are two facts and
    // a refresh of one cannot collide with the other's chunks.
    case 'KNOWLEDGE':
      return input.knowledgeSourceId ? `knowledge:${input.knowledgeSourceId}` : 'knowledge';
    default:
      return input.scope.toLowerCase();
  }
}

function normalizeForHash(content: string): string {
  return content.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The content hash the dedupe index is built on.
 *
 * Exported because anything that needs to say "these are the rows I just wrote"
 * has to agree with this exactly. A second implementation that skipped the
 * lowercasing meant a knowledge refresh computed different hashes from the ones
 * it had stored, so its prune step deleted every chunk it had written a moment
 * earlier and the source indexed to nothing.
 */
export function memoryContentHash(content: string): string {
  return sha256Hex(normalizeForHash(content));
}

export interface WriteMemoryResult {
  memory: MemoryRecord;
  created: boolean;
}

/** Idempotent write: identical content in the same bucket updates rather than duplicates. */
export async function writeMemory(input: WriteMemoryInput, executor?: Tx): Promise<WriteMemoryResult> {
  const scopeKey = scopeKeyFor(input);
  const contentHash = memoryContentHash(input.content);
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
    input.knowledgeSourceId ?? null,
    input.origin ? JSON.stringify(input.origin) : null,
  ];
  const sql = `
    INSERT INTO memories (agent_id, scope, memory_type, account_id, conversation_id, remote_user_id,
      remote_handle, content, summary, importance, confidence, pinned, source_event_id, source_job_id,
      content_hash, scope_key, expires_at, knowledge_source_id, origin)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb)
    ON CONFLICT (agent_id, scope, scope_key, content_hash) DO UPDATE
      SET importance = greatest(memories.importance, excluded.importance),
          summary = coalesce(excluded.summary, memories.summary),
          -- A re-read of the same text under a new revision updates where it
          -- came from, so an answer cites the version now installed.
          origin = coalesce(excluded.origin, memories.origin),
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
/**
 * Drop query terms that match most of what this agent knows.
 *
 * The query is an OR of every keyword, ranked by ts_rank, so a term that
 * appears everywhere competes on equal footing with the one that actually
 * identifies the answer. Asked "can I use Ollama?", the keywords are "use" and
 * "ollama": the first is in half the documentation, the second is in one
 * paragraph, and a chunk repeating "use" outranked the paragraph that answers
 * the question.
 *
 * So a term matching more than a third of the rows is discarded as carrying no
 * signal -- which is document frequency, the same idea as a stopword list
 * except measured against this agent's own corpus rather than guessed at in
 * advance. "Memory" is a stopword in a corpus about memory and a strong term
 * everywhere else, and no fixed list can know that.
 *
 * Every term is kept when there is too little to measure, or when the filter
 * would leave nothing: a weak query beats no query.
 */
interface TermWeight {
  term: string;
  /** How many of this agent's memories in this scope contain it. */
  hits: number;
}

/**
 * How common each query term is in what this agent already knows.
 *
 * The ranking underneath is ts_rank over an OR of every keyword, and ts_rank
 * rewards how often a term appears in a chunk without any sense of how common
 * that term is across the corpus. Asked "can I use Ollama?", the keywords are
 * "use" and "ollama": a passage repeating "use" five times outranked the one
 * paragraph in the documentation that names Ollama, and the answer came back
 * about Docker sign-in.
 *
 * Measuring rather than guessing matters here. A fixed stopword list cannot
 * know that "memory" carries no signal in a corpus about memory and plenty of
 * it everywhere else.
 */
async function termWeights(agentId: string, scope: MemoryScope, terms: string[]): Promise<TermWeight[]> {
  const rows = await query<{ term: string; hits: string }>(
    `SELECT t.term,
            count(m.id) FILTER (WHERE to_tsvector('simple', m.content) @@ to_tsquery('simple', t.term)) AS hits
       FROM unnest($3::text[]) AS t(term)
       LEFT JOIN memories m ON m.agent_id = $1 AND m.scope = $2
      GROUP BY t.term`,
    [agentId, scope, terms],
  );
  const weights = new Map(rows.map((r) => [r.term, Number(r.hits)]));
  return terms.map((term) => ({ term, hits: weights.get(term) ?? 0 }));
}

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
  const cleaned = terms.map((t) => t.replace(/[^\p{L}\p{N}_]/gu, '')).filter(Boolean);
  const tsquery = cleaned.join(' | ') || 'xbam_no_match';

  // The rarest term the question used, which is nearly always the one that
  // identifies the answer. It decides the order before frequency gets a say,
  // so one mention of "ollama" beats five mentions of "use".
  const weights = cleaned.length > 1 ? await termWeights(q.agentId, scope, cleaned) : [];
  const rarest = weights.filter((w) => w.hits > 0).sort((a, b) => a.hits - b.hits)[0]?.term ?? null;

  return mapRows<MemoryRecord>(
    await query(
      `SELECT ${COLUMNS},
              ts_rank(to_tsvector('simple', content), to_tsquery('simple', $3)) AS rank,
              ($5::text IS NOT NULL
                AND to_tsvector('simple', content) @@ to_tsquery('simple', $5)) AS names_it
         FROM memories
        WHERE agent_id = $1 AND scope = $2 ${LIVE}
          AND (pinned OR to_tsvector('simple', content) @@ to_tsquery('simple', $3))
        ORDER BY pinned DESC, names_it DESC, rank DESC, importance DESC, created_at DESC
        LIMIT $4`,
      [q.agentId, scope, tsquery, q.limit, rarest],
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
