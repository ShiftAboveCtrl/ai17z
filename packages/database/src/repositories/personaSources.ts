import { query, queryOne, withTransaction } from '../pool';
import { mapRow, mapRows } from '../mapper';

export interface PersonaSourceRow {
  id: string;
  agentId: string;
  kind: 'x_public' | 'manual';
  handle: string | null;
  label: string;
  config: Record<string, unknown>;
  status: 'IDLE' | 'SYNCING' | 'READY' | 'ERROR' | 'UNAVAILABLE';
  lastError: string | null;
  /** How far a collection has got, in words. Null when it has not said. */
  progress: string | null;
  lastSyncedAt: string | null;
  syncCursor: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersonaSourceItemRow {
  id: string;
  sourceId: string;
  remoteId: string;
  url: string | null;
  itemKind: string;
  rawText: string;
  normalizedText: string;
  contentHash: string;
  remoteCreatedAt: string | null;
  styleScore: number;
  personaScore: number;
  beliefScore: number;
  knowledgeScore: number;
  noiseScore: number;
  classification: string;
  excluded: boolean;
  exclusionReason: string | null;
  ownerOverride: boolean | null;
  ingestedAt: string;
}

export async function listSources(agentId: string): Promise<PersonaSourceRow[]> {
  return mapRows<PersonaSourceRow>(
    await query('SELECT * FROM persona_sources WHERE agent_id = $1 ORDER BY created_at', [agentId]),
  );
}

export async function getSource(id: string): Promise<PersonaSourceRow | null> {
  return mapRow<PersonaSourceRow>(await queryOne('SELECT * FROM persona_sources WHERE id = $1', [id]));
}

export async function upsertSource(input: {
  agentId: string;
  kind: 'x_public' | 'manual';
  handle: string | null;
  label?: string;
  config?: Record<string, unknown>;
}): Promise<PersonaSourceRow> {
  const row = await queryOne(
    `INSERT INTO persona_sources (agent_id, kind, handle, label, config)
     VALUES ($1,$2,$3,$4,$5::jsonb)
     ON CONFLICT (agent_id, kind, handle) DO UPDATE
       SET label = excluded.label, config = excluded.config, updated_at = now()
     RETURNING *`,
    [input.agentId, input.kind, input.handle, input.label ?? '', JSON.stringify(input.config ?? {})],
  );
  return mapRow<PersonaSourceRow>(row) as PersonaSourceRow;
}

export async function setSourceStatus(
  id: string,
  status: PersonaSourceRow['status'],
  detail?: {
    lastError?: string | null;
    syncCursor?: string | null;
    touchSynced?: boolean;
    /**
     * How far a collection has got, in the words a person reads.
     *
     * Kept apart from `lastError` on purpose: progress is not a failure, and
     * sharing the column would make a working collection look like a broken one
     * on every screen that reads it. `coalesce` because most callers have
     * nothing to say about progress and must not blank what the last one wrote.
     */
    progress?: string | null;
  },
): Promise<void> {
  await query(
    `UPDATE persona_sources
        SET status = $2,
            last_error = $3,
            sync_cursor = coalesce($4, sync_cursor),
            last_synced_at = CASE WHEN $5 THEN now() ELSE last_synced_at END,
            progress = coalesce($6, progress),
            updated_at = now()
      WHERE id = $1`,
    [
      id,
      status,
      detail?.lastError ?? null,
      detail?.syncCursor ?? null,
      detail?.touchSynced ?? false,
      detail?.progress ?? null,
    ],
  );
}

/**
 * Remember what was learned about the account itself.
 *
 * Merged rather than replaced, so a caller recording the resolved identity does
 * not blank the collection settings sitting beside it. The immutable X user id
 * lives here: `config` is jsonb and already exists, which is a better place for
 * it than a column added to carry one value.
 */
export async function updateSourceConfig(id: string, patch: Record<string, unknown>): Promise<void> {
  await query(
    `UPDATE persona_sources
        SET config = coalesce(config, '{}'::jsonb) || $2::jsonb,
            updated_at = now()
      WHERE id = $1`,
    [id, JSON.stringify(patch)],
  );
}

export async function deleteSource(id: string): Promise<void> {
  await query('DELETE FROM persona_sources WHERE id = $1', [id]);
}

export interface StoreItemInput {
  sourceId: string;
  remoteId: string;
  url: string | null;
  itemKind: string;
  rawText: string;
  normalizedText: string;
  contentHash: string;
  remoteCreatedAt: string | null;
  raw: Record<string, unknown>;
  styleScore: number;
  personaScore: number;
  beliefScore: number;
  knowledgeScore: number;
  noiseScore: number;
  classification: string;
  excluded: boolean;
  exclusionReason: string | null;
}

/**
 * Stores one corpus item. Duplicates collapse on either the remote id or the
 * content fingerprint, so a repost and its original never both survive.
 */
export async function storeItem(input: StoreItemInput): Promise<{ created: boolean }> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO persona_source_items (
       source_id, remote_id, url, item_kind, raw_text, normalized_text, content_hash,
       remote_created_at, raw, style_score, persona_score, belief_score, knowledge_score,
       noise_score, classification, excluded, exclusion_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      input.sourceId, input.remoteId, input.url, input.itemKind, input.rawText, input.normalizedText,
      input.contentHash, input.remoteCreatedAt, JSON.stringify(input.raw), input.styleScore,
      input.personaScore, input.beliefScore, input.knowledgeScore, input.noiseScore,
      input.classification, input.excluded, input.exclusionReason,
    ],
  );
  return { created: row !== null };
}

export interface ItemFilters {
  sourceId: string;
  view?: 'useful' | 'excluded' | 'all';
  limit?: number;
  offset?: number;
}

export async function listItems(filters: ItemFilters): Promise<{ items: PersonaSourceItemRow[]; total: number }> {
  // The owner override always wins over the machine decision.
  const effective = 'coalesce(owner_override, NOT excluded)';
  const where =
    filters.view === 'useful'
      ? `WHERE source_id = $1 AND ${effective}`
      : filters.view === 'excluded'
        ? `WHERE source_id = $1 AND NOT ${effective}`
        : 'WHERE source_id = $1';

  const total = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM persona_source_items ${where}`,
    [filters.sourceId],
  );
  const rows = await query(
    `SELECT * FROM persona_source_items ${where}
      ORDER BY style_score DESC, ingested_at DESC
      LIMIT $2 OFFSET $3`,
    [filters.sourceId, filters.limit ?? 50, filters.offset ?? 0],
  );
  return { items: mapRows<PersonaSourceItemRow>(rows), total: total?.count ?? 0 };
}

/** Items actually used for derivation: not excluded, or included by the owner. */
export async function selectedItems(sourceId: string, limit = 2000): Promise<PersonaSourceItemRow[]> {
  return mapRows<PersonaSourceItemRow>(
    await query(
      `SELECT * FROM persona_source_items
        WHERE source_id = $1 AND coalesce(owner_override, NOT excluded)
        ORDER BY style_score DESC LIMIT $2`,
      [sourceId, limit],
    ),
  );
}

export async function setOwnerOverride(itemId: string, include: boolean | null): Promise<void> {
  await query('UPDATE persona_source_items SET owner_override = $2 WHERE id = $1', [itemId, include]);
}

export async function sourceStats(sourceId: string): Promise<{ total: number; useful: number; excluded: number }> {
  const row = await queryOne<{ total: number; useful: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE coalesce(owner_override, NOT excluded))::int AS useful
       FROM persona_source_items WHERE source_id = $1`,
    [sourceId],
  );
  const total = row?.total ?? 0;
  const useful = row?.useful ?? 0;
  return { total, useful, excluded: total - useful };
}

export interface PersonaTraitRow {
  id: string;
  agentId: string;
  sourceId: string | null;
  kind: 'style' | 'belief' | 'topic' | 'example' | 'language';
  content: string;
  confidence: number;
  createdAt: string;
}

export interface TraitWithEvidence extends PersonaTraitRow {
  evidence: Array<{ id: string; text: string; url: string | null }>;
}

/** Replaces the derived traits for one source, keeping evidence attached. */
export async function replaceTraits(
  agentId: string,
  sourceId: string,
  traits: Array<{ kind: PersonaTraitRow['kind']; content: string; confidence: number; evidence: string[] }>,
): Promise<number> {
  return withTransaction(async (tx) => {
    await tx.query('DELETE FROM persona_traits WHERE agent_id = $1 AND source_id = $2', [agentId, sourceId]);
    let stored = 0;
    for (const trait of traits) {
      const row = await tx.one<{ id: string }>(
        `INSERT INTO persona_traits (agent_id, source_id, kind, content, confidence)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (agent_id, kind, content) DO UPDATE SET confidence = excluded.confidence
         RETURNING id`,
        [agentId, sourceId, trait.kind, trait.content, trait.confidence],
      );
      if (!row) continue;
      stored += 1;
      for (const itemId of trait.evidence) {
        await tx.query(
          'INSERT INTO persona_trait_evidence (trait_id, item_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [row.id, itemId],
        );
      }
    }
    return stored;
  });
}

/** Traits with the corpus items that produced them, so a claim can be checked. */
export async function listTraits(agentId: string): Promise<TraitWithEvidence[]> {
  const traits = mapRows<PersonaTraitRow>(
    await query('SELECT * FROM persona_traits WHERE agent_id = $1 ORDER BY kind, confidence DESC', [agentId]),
  );
  if (traits.length === 0) return [];

  const evidence = await query<{ trait_id: string; id: string; raw_text: string; url: string | null }>(
    `SELECT e.trait_id, i.id, i.raw_text, i.url
       FROM persona_trait_evidence e JOIN persona_source_items i ON i.id = e.item_id
      WHERE e.trait_id = ANY($1::uuid[])`,
    [traits.map((t) => t.id)],
  );
  const byTrait = new Map<string, TraitWithEvidence['evidence']>();
  for (const row of evidence) {
    const list = byTrait.get(row.trait_id) ?? [];
    list.push({ id: row.id, text: row.raw_text, url: row.url });
    byTrait.set(row.trait_id, list);
  }
  return traits.map((t) => ({ ...t, evidence: byTrait.get(t.id) ?? [] }));
}

export interface SyncRequest {
  text?: string;
  limit: number;
  incremental: boolean;
}

/**
 * Records that a sync was asked for.
 *
 * The work happens in a worker rather than in the API, because the tool a
 * source needs — twscrape, with its own account database — lives on a machine,
 * and the API runs in a container that has neither.
 */
export async function requestSync(sourceId: string, request: SyncRequest): Promise<void> {
  await query(
    `UPDATE persona_sources
        SET pending_request = $2::jsonb, claimed_by = NULL, claimed_at = NULL,
            status = 'SYNCING', last_error = NULL
      WHERE id = $1`,
    [sourceId, JSON.stringify(request)],
  );
}

/**
 * Claims one requested sync.
 *
 * A claim older than the lease is retried: a worker that died mid-scrape should
 * not leave a source stuck in SYNCING for ever, which is the same failure the
 * browser task queue had.
 */
export async function claimSync(
  workerId: string,
  leaseMinutes = 20,
): Promise<{ id: string; kind: PersonaSourceRow['kind']; handle: string | null; request: SyncRequest } | null> {
  // The kind and the handle come back with the claim because what to do next
  // depends on them: an X source is read through the browser by the shared
  // collector, and anything else goes straight through the adapter path.
  const row = await queryOne<{ id: string; kind: PersonaSourceRow['kind']; handle: string | null; pending_request: SyncRequest }>(
    `UPDATE persona_sources SET claimed_by = $1, claimed_at = now()
      WHERE id = (
        SELECT id FROM persona_sources
         WHERE pending_request IS NOT NULL
           AND (claimed_at IS NULL OR claimed_at < now() - ($2::int * interval '1 minute'))
         ORDER BY claimed_at NULLS FIRST
         LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      RETURNING id, kind, handle, pending_request`,
    [workerId, leaseMinutes],
  );
  return row ? { id: row.id, kind: row.kind, handle: row.handle, request: row.pending_request } : null;
}

export async function clearSyncRequest(sourceId: string): Promise<void> {
  await query('UPDATE persona_sources SET pending_request = NULL, claimed_by = NULL, claimed_at = NULL WHERE id = $1', [
    sourceId,
  ]);
}
