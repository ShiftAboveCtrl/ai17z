import type { Disposition, Familiarity, RelationshipProfile } from '@xbam/shared/contracts';
import { deriveFamiliarity } from '@xbam/shared/contracts';
import { mapRow, mapRows } from '../mapper';
import { query, queryOne } from '../pool';

export interface RelationshipRow extends RelationshipProfile {
  createdAt: string;
  updatedAt: string;
}

export interface CallbackRow {
  id: string;
  relationshipId: string;
  label: string;
  detail: string;
  createdAt: string;
  lastUsedAt: string | null;
  useCount: number;
  retired: boolean;
}

function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@+/, '');
}

/**
 * Finds a relationship, preferring the platform's own id.
 *
 * Handles change. Somebody who renames themselves is the same person, and
 * treating them as a stranger because of it is exactly the discontinuity this
 * table exists to remove.
 */
export async function find(input: {
  agentId: string;
  channel: string;
  handle: string;
  remoteUserId?: string | null;
}): Promise<RelationshipRow | null> {
  if (input.remoteUserId) {
    const byId = await queryOne(
      'SELECT * FROM relationships WHERE agent_id = $1 AND channel = $2 AND remote_user_id = $3',
      [input.agentId, input.channel, input.remoteUserId],
    );
    if (byId) return mapRow<RelationshipRow>(byId);
  }
  return mapRow<RelationshipRow>(
    await queryOne('SELECT * FROM relationships WHERE agent_id = $1 AND channel = $2 AND lower(handle) = lower($3)', [
      input.agentId,
      input.channel,
      normalizeHandle(input.handle),
    ]),
  );
}

export async function get(id: string): Promise<RelationshipRow | null> {
  return mapRow<RelationshipRow>(await queryOne('SELECT * FROM relationships WHERE id = $1', [id]));
}

/**
 * Records an interaction and re-derives familiarity.
 *
 * Familiarity is computed rather than incremented, so correcting a count fixes
 * the level too, and a pinned level is never overwritten.
 */
export async function recordInteraction(input: {
  agentId: string;
  channel: string;
  handle: string;
  remoteUserId?: string | null;
  displayName?: string | null;
  direction: 'INBOUND' | 'OUTBOUND';
}): Promise<RelationshipRow> {
  const handle = normalizeHandle(input.handle);
  const inbound = input.direction === 'INBOUND' ? 1 : 0;
  const outbound = input.direction === 'OUTBOUND' ? 1 : 0;

  const row = await queryOne(
    `INSERT INTO relationships (agent_id, channel, handle, remote_user_id, display_name,
                                interaction_count, inbound_count, outbound_count)
     VALUES ($1,$2,$3,$4,$5,1,$6,$7)
     ON CONFLICT (agent_id, channel, handle) DO UPDATE
       SET interaction_count = relationships.interaction_count + 1,
           inbound_count = relationships.inbound_count + $6,
           outbound_count = relationships.outbound_count + $7,
           last_interaction_at = now(),
           -- A handle we now have an id for is the same person; fill it in.
           remote_user_id = coalesce(relationships.remote_user_id, excluded.remote_user_id),
           display_name = CASE WHEN excluded.display_name <> '' THEN excluded.display_name
                               ELSE relationships.display_name END,
           updated_at = now()
     RETURNING *`,
    [input.agentId, input.channel, handle, input.remoteUserId ?? null, input.displayName ?? '', inbound, outbound],
  );

  const relationship = mapRow<RelationshipRow>(row) as RelationshipRow;
  if (relationship.familiarityPinned) return relationship;

  const derived = deriveFamiliarity(relationship);
  if (derived === relationship.familiarity) return relationship;

  const updated = await queryOne(
    'UPDATE relationships SET familiarity = $2, updated_at = now() WHERE id = $1 RETURNING *',
    [relationship.id, derived],
  );
  return mapRow<RelationshipRow>(updated) as RelationshipRow;
}

export async function listForAgent(
  agentId: string,
  options: { limit?: number; familiarity?: Familiarity; search?: string } = {},
): Promise<RelationshipRow[]> {
  const clauses = ['agent_id = $1'];
  const params: unknown[] = [agentId];
  if (options.familiarity) {
    params.push(options.familiarity);
    clauses.push(`familiarity = $${params.length}`);
  }
  if (options.search) {
    params.push(`%${options.search.replace(/^@+/, '')}%`);
    clauses.push(`(handle ILIKE $${params.length} OR display_name ILIKE $${params.length})`);
  }
  params.push(options.limit ?? 50);
  return mapRows<RelationshipRow>(
    await query(
      `SELECT * FROM relationships WHERE ${clauses.join(' AND ')}
        ORDER BY last_interaction_at DESC LIMIT $${params.length}`,
      params,
    ),
  );
}

/** How many people the agent knows at each level, for the summary UI. */
export async function counts(agentId: string): Promise<Record<Familiarity, number>> {
  const rows = await query<{ familiarity: Familiarity; n: number }>(
    'SELECT familiarity, count(*)::int AS n FROM relationships WHERE agent_id = $1 GROUP BY familiarity',
    [agentId],
  );
  const result: Record<Familiarity, number> = { NEW: 0, KNOWN: 0, FAMILIAR: 0, REGULAR: 0 };
  for (const row of rows) result[row.familiarity] = row.n;
  return result;
}

/** Owner edits. Everything here is a deliberate override of what was derived. */
export async function update(
  id: string,
  patch: Partial<{
    summary: string;
    ownerNote: string;
    topics: string[];
    typicalTone: string | null;
    disposition: Disposition;
    familiarity: Familiarity;
    familiarityPinned: boolean;
  }>,
): Promise<RelationshipRow> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const push = (fragment: string, value: unknown) => {
    params.push(value);
    sets.push(fragment.replace('$?', `$${params.length}`));
  };
  if (patch.summary !== undefined) push('summary = $?', patch.summary);
  if (patch.ownerNote !== undefined) push('owner_note = $?', patch.ownerNote);
  if (patch.topics !== undefined) push('topics = $?::jsonb', JSON.stringify(patch.topics));
  if (patch.typicalTone !== undefined) push('typical_tone = $?', patch.typicalTone);
  if (patch.disposition !== undefined) push('disposition = $?', patch.disposition);
  if (patch.familiarity !== undefined) {
    push('familiarity = $?', patch.familiarity);
    // Setting it by hand is what pinning means; otherwise the next interaction
    // would silently undo the correction.
    sets.push('familiarity_pinned = true');
  }
  if (patch.familiarityPinned !== undefined) push('familiarity_pinned = $?', patch.familiarityPinned);
  if (sets.length === 0) return (await get(id)) as RelationshipRow;

  sets.push('updated_at = now()');
  return mapRow<RelationshipRow>(
    await queryOne(`UPDATE relationships SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params),
  ) as RelationshipRow;
}

/** Merges newly observed topics without letting the list grow without bound. */
export async function addTopics(id: string, topics: string[], max = 12): Promise<void> {
  if (topics.length === 0) return;
  const current = await get(id);
  if (!current) return;
  const merged = [...new Set([...topics.map((t) => t.trim().toLowerCase()).filter(Boolean), ...current.topics])];
  await update(id, { topics: merged.slice(0, max) });
}

// ── Callbacks ───────────────────────────────────────────────────────────────

export async function addCallback(input: {
  relationshipId: string;
  label: string;
  detail: string;
  sourceEventId?: string | null;
  sourceJobId?: string | null;
}): Promise<CallbackRow | null> {
  const row = await queryOne(
    `INSERT INTO relationship_callbacks (relationship_id, label, detail, source_event_id, source_job_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (relationship_id, label) DO NOTHING
     RETURNING *`,
    [input.relationshipId, input.label.trim(), input.detail, input.sourceEventId ?? null, input.sourceJobId ?? null],
  );
  return mapRow<CallbackRow>(row);
}

export async function listCallbacks(relationshipId: string): Promise<CallbackRow[]> {
  return mapRows<CallbackRow>(
    await query('SELECT * FROM relationship_callbacks WHERE relationship_id = $1 ORDER BY created_at DESC', [
      relationshipId,
    ]),
  );
}

/**
 * A callback that is fair to use right now.
 *
 * Rested rather than random: one used yesterday is not due again, and one used
 * repeatedly stops being a shared reference and becomes a catchphrase.
 */
export async function dueCallback(
  relationshipId: string,
  restHours = 72,
  maxUses = 4,
): Promise<CallbackRow | null> {
  return mapRow<CallbackRow>(
    await queryOne(
      `SELECT * FROM relationship_callbacks
        WHERE relationship_id = $1 AND NOT retired AND use_count < $3
          AND (last_used_at IS NULL OR last_used_at < now() - ($2::int * interval '1 hour'))
        ORDER BY last_used_at NULLS FIRST, created_at
        LIMIT 1`,
      [relationshipId, restHours, maxUses],
    ),
  );
}

export async function markCallbackUsed(id: string): Promise<void> {
  await query('UPDATE relationship_callbacks SET last_used_at = now(), use_count = use_count + 1 WHERE id = $1', [id]);
}

export async function retireCallback(id: string, retired = true): Promise<void> {
  await query('UPDATE relationship_callbacks SET retired = $2 WHERE id = $1', [id, retired]);
}
