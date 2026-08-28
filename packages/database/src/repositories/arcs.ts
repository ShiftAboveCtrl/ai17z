import { mapRow, mapRows } from '../mapper';
import { query, queryOne } from '../pool';

export interface ThreadStateRow {
  id: string;
  agentId: string;
  conversationId: string | null;
  remoteConversationId: string;
  summary: string;
  mainTopic: string | null;
  openQuestion: string | null;
  resolvedPoints: string[];
  participants: string[];
  turnCount: number;
  summarisedAtTurn: number;
  updatedAt: string;
}

export async function getThreadState(agentId: string, remoteConversationId: string): Promise<ThreadStateRow | null> {
  return mapRow<ThreadStateRow>(
    await queryOne('SELECT * FROM thread_states WHERE agent_id = $1 AND remote_conversation_id = $2', [
      agentId,
      remoteConversationId,
    ]),
  );
}

/** Counts a turn, creating the state on first sight of the thread. */
export async function touchThread(input: {
  agentId: string;
  remoteConversationId: string;
  conversationId?: string | null;
  participant?: string | null;
}): Promise<ThreadStateRow> {
  const row = await queryOne(
    `INSERT INTO thread_states (agent_id, remote_conversation_id, conversation_id, turn_count, participants)
     VALUES ($1,$2,$3,1, CASE WHEN $4::text IS NULL THEN '[]'::jsonb ELSE jsonb_build_array($4) END)
     ON CONFLICT (agent_id, remote_conversation_id) DO UPDATE
       SET turn_count = thread_states.turn_count + 1,
           conversation_id = coalesce(thread_states.conversation_id, excluded.conversation_id),
           participants = CASE
             WHEN $4::text IS NULL OR thread_states.participants @> jsonb_build_array($4)
               THEN thread_states.participants
             ELSE thread_states.participants || jsonb_build_array($4)
           END,
           updated_at = now()
     RETURNING *`,
    [input.agentId, input.remoteConversationId, input.conversationId ?? null, input.participant ?? null],
  );
  return mapRow<ThreadStateRow>(row) as ThreadStateRow;
}

export async function saveThreadSummary(input: {
  id: string;
  summary: string;
  mainTopic?: string | null;
  openQuestion?: string | null;
  resolvedPoints?: string[];
  atTurn: number;
}): Promise<void> {
  await query(
    `UPDATE thread_states
        SET summary = $2, main_topic = $3, open_question = $4,
            resolved_points = $5::jsonb, summarised_at_turn = $6, updated_at = now()
      WHERE id = $1`,
    [
      input.id,
      input.summary,
      input.mainTopic ?? null,
      input.openQuestion ?? null,
      JSON.stringify(input.resolvedPoints ?? []),
      input.atTurn,
    ],
  );
}

// ── Narratives ──────────────────────────────────────────────────────────────

export interface NarrativeRow {
  id: string;
  label: string;
  detail: string;
  useCount: number;
  lastUsedAt: string | null;
}

export async function recordNarrative(agentId: string, label: string, detail = ''): Promise<void> {
  await query(
    `INSERT INTO narratives (agent_id, label, detail, use_count, last_used_at)
     VALUES ($1,$2,$3,1, now())
     ON CONFLICT (agent_id, label) DO UPDATE
       SET use_count = narratives.use_count + 1, last_used_at = now(),
           detail = CASE WHEN excluded.detail <> '' THEN excluded.detail ELSE narratives.detail END`,
    [agentId, label.trim().toLowerCase(), detail],
  );
}

export async function listNarratives(agentId: string, limit = 30): Promise<NarrativeRow[]> {
  return mapRows<NarrativeRow>(
    await query('SELECT * FROM narratives WHERE agent_id = $1 ORDER BY use_count DESC LIMIT $2', [agentId, limit]),
  );
}

/**
 * Narratives used too recently to use again.
 *
 * An agent with three ideas it recycles endlessly is worse than one that knows
 * it already made that argument this week.
 */
export async function overusedNarratives(agentId: string, withinHours = 48, minUses = 2): Promise<NarrativeRow[]> {
  return mapRows<NarrativeRow>(
    await query(
      `SELECT * FROM narratives
        WHERE agent_id = $1 AND use_count >= $3
          AND last_used_at > now() - ($2::int * interval '1 hour')
        ORDER BY last_used_at DESC LIMIT 10`,
      [agentId, withinHours, minUses],
    ),
  );
}

// ── Entities ────────────────────────────────────────────────────────────────

export interface EntityRow {
  id: string;
  kind: string;
  name: string;
  nameKey: string;
  summary: string;
  mentionCount: number;
  lastSeenAt: string;
}

function nameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function observeEntity(input: {
  agentId: string;
  kind: string;
  name: string;
  summary?: string;
}): Promise<EntityRow> {
  const row = await queryOne(
    `INSERT INTO entities (agent_id, kind, name, name_key, summary, mention_count)
     VALUES ($1,$2,$3,$4,$5,1)
     ON CONFLICT (agent_id, kind, name_key) DO UPDATE
       SET mention_count = entities.mention_count + 1, last_seen_at = now(),
           summary = CASE WHEN excluded.summary <> '' THEN excluded.summary ELSE entities.summary END
     RETURNING *`,
    [input.agentId, input.kind, input.name.trim(), nameKey(input.name), input.summary ?? ''],
  );
  return mapRow<EntityRow>(row) as EntityRow;
}

/**
 * Records that two things came up together.
 *
 * The only claim being made is that they co-occurred, which is why the count is
 * stored rather than a confidence: this is an observation, not an inference
 * about anybody or anything.
 */
export async function observeEdge(input: {
  agentId: string;
  fromId: string;
  toId: string;
  relation: string;
}): Promise<void> {
  if (input.fromId === input.toId) return;
  await query(
    `INSERT INTO entity_edges (agent_id, from_id, to_id, relation)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (from_id, to_id, relation) DO UPDATE
       SET observations = entity_edges.observations + 1, last_seen_at = now()`,
    [input.agentId, input.fromId, input.toId, input.relation],
  );
}

export async function findEntities(agentId: string, names: string[]): Promise<EntityRow[]> {
  if (names.length === 0) return [];
  return mapRows<EntityRow>(
    await query('SELECT * FROM entities WHERE agent_id = $1 AND name_key = ANY($2::text[])', [
      agentId,
      names.map(nameKey),
    ]),
  );
}

export async function listEntities(agentId: string, limit = 100): Promise<EntityRow[]> {
  return mapRows<EntityRow>(
    await query('SELECT * FROM entities WHERE agent_id = $1 ORDER BY mention_count DESC LIMIT $2', [agentId, limit]),
  );
}

/** What else keeps coming up alongside this thing. */
export async function relatedEntities(entityId: string, limit = 5): Promise<(EntityRow & { relation: string; observations: number })[]> {
  return mapRows(
    await query(
      `SELECT e.*, edge.relation, edge.observations
         FROM entity_edges edge JOIN entities e ON e.id = edge.to_id
        WHERE edge.from_id = $1
        ORDER BY edge.observations DESC LIMIT $2`,
      [entityId, limit],
    ),
  );
}
