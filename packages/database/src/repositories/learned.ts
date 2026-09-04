import { mapRows } from '../mapper';
import { query } from '../pool';

/**
 * Everything an agent has learned, in one list, with where it came from.
 *
 * Not a new store. Memory, relationships, stances, entities and commitments all
 * already exist and are each written by the part of the runtime that owns them;
 * a parallel "learned" table would be a copy that drifts. This reads them.
 *
 * The two questions an owner actually asks are "why does my agent remember
 * this?" and "how do I make it forget it?", so every row carries what it is,
 * where it came from, when, and enough identity to delete it.
 */

export const LEARNED_KINDS = ['MEMORY', 'RELATIONSHIP', 'STANCE', 'ENTITY', 'COMMITMENT'] as const;
export type LearnedKind = (typeof LEARNED_KINDS)[number];

export interface LearnedItem extends Record<string, unknown> {
  kind: LearnedKind;
  /** The row's own id, in its own table. What "forget this" needs. */
  id: string;
  /** What it learned, in as few words as the underlying row allows. */
  summary: string;
  /** The longer form, when there is one. */
  detail: string | null;
  /** Which memory scope, for a memory. Null for everything else. */
  scope: string | null;
  /** Where it came from: a handle, a document, a conversation. */
  source: string | null;
  /** How firmly it is held, where the underlying row has a notion of that. */
  confidence: number | null;
  /** Whether it currently affects anything the agent says. */
  active: boolean;
  learnedAt: string;
}

/**
 * One query per store rather than a union in SQL.
 *
 * The five tables have almost nothing in common beyond an agent id, and a
 * UNION over them would be five casts and a column order nobody could read.
 * Five small indexed reads, merged and sorted here, is the same work and can be
 * followed.
 */
export async function whatItLearned(agentId: string, limit = 200): Promise<LearnedItem[]> {
  const per = Math.max(10, Math.floor(limit / 5));

  const [memories, relationships, stances, entities, commitments] = await Promise.all([
    query<LearnedItem>(
      `SELECT 'MEMORY' AS kind, id, coalesce(nullif(summary, ''), left(content, 200)) AS summary,
              content AS detail, scope, coalesce(origin ->> 'sourceName', 'a conversation') AS source,
              importance AS confidence,
              (expires_at IS NULL OR expires_at > now()) AS active, created_at AS "learnedAt"
         FROM memories WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [agentId, per],
    ),
    query<LearnedItem>(
      `SELECT 'RELATIONSHIP' AS kind, id,
              coalesce(nullif(summary, ''), 'Has spoken with @' || handle) AS summary,
              owner_note AS detail, NULL AS scope, '@' || handle AS source,
              NULL::numeric AS confidence, true AS active, created_at AS "learnedAt"
         FROM relationships WHERE agent_id = $1 ORDER BY updated_at DESC LIMIT $2`,
      [agentId, per],
    ),
    query<LearnedItem>(
      `SELECT 'STANCE' AS kind, id, subject || ': ' || summary AS summary,
              NULL AS detail, NULL AS scope, 'what it has said' AS source,
              confidence, status = 'ACTIVE' AS active, created_at AS "learnedAt"
         FROM stances WHERE agent_id = $1 ORDER BY updated_at DESC LIMIT $2`,
      [agentId, per],
    ),
    query<LearnedItem>(
      `SELECT 'ENTITY' AS kind, id, name AS summary, NULL AS detail, NULL AS scope,
              'seen in conversation' AS source, NULL::numeric AS confidence,
              true AS active, created_at AS "learnedAt"
         FROM entities WHERE agent_id = $1 ORDER BY last_seen_at DESC NULLS LAST LIMIT $2`,
      [agentId, per],
    ),
    query<LearnedItem>(
      `SELECT 'COMMITMENT' AS kind, id, promise AS summary, outcome AS detail, NULL AS scope,
              coalesce('@' || recipient_handle, 'a conversation') AS source,
              confidence, status IN ('OPEN','DUE') AS active, created_at AS "learnedAt"
         FROM commitments WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [agentId, per],
    ),
  ]);

  // Column names come back as written, except the snake_case ones, which the
  // mapper turns into the shape the rest of the app expects.
  return mapRows<LearnedItem>([...memories, ...relationships, ...stances, ...entities, ...commitments] as never[])
    .sort((a, b) => (a.learnedAt < b.learnedAt ? 1 : -1))
    .slice(0, limit);
}
