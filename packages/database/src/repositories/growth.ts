import { query } from '../pool';

/**
 * The reads the growth screens are built from.
 *
 * Every one of these answers a question out of rows that already exist --
 * events the radar discovered, actions the agent published, relationships it
 * has. There is no growth table and there should not be one: a second store of
 * "what happened" would drift from the first, and the first is the one the
 * pipeline writes.
 *
 * `repositories/mentions.ts` makes the same argument about the inbox being a
 * read model rather than a table. This is that argument applied to what an
 * owner is shown about how their agent is doing.
 */

export interface DiscoveredPostRow extends Record<string, unknown> {
  remote_event_id: string;
  handle: string | null;
  text: string;
  occurred_at: string | null;
  conversation_id: string | null;
}

/**
 * What this account has seen recently, whoever found it.
 *
 * Ordered by when the post was written rather than when it was ingested,
 * because a narrative is about when people said things. A post with no
 * timestamp is still returned: whatever reads this has to decide what to do
 * about an undated post, and dropping it here would hide how many there were.
 */
export async function discoveredPosts(
  accountId: string,
  options: { sinceIso?: string; limit?: number } = {},
): Promise<DiscoveredPostRow[]> {
  const params: unknown[] = [accountId];
  const clauses = ['account_id = $1'];
  if (options.sinceIso) {
    params.push(options.sinceIso);
    clauses.push(`COALESCE(occurred_at, ingested_at) >= $${params.length}`);
  }
  params.push(Math.min(Math.max(options.limit ?? 300, 1), 1_000));
  return query<DiscoveredPostRow>(
    `SELECT remote_event_id,
            remote_author_handle AS handle,
            text,
            occurred_at,
            remote_conversation_id AS conversation_id
       FROM events
      WHERE ${clauses.join(' AND ')}
      ORDER BY COALESCE(occurred_at, ingested_at) DESC
      LIMIT $${params.length}`,
    params,
  );
}

export interface NeighbourRow extends Record<string, unknown> {
  handle: string;
  neighbours: number;
  neighbours_we_know: number;
}

/**
 * Who has been seen in the same conversations as whom.
 *
 * This is the only "graph" here, and it is deliberately the thinnest possible
 * one: two accounts appeared in one conversation. `docs/ENGINEERING.md` says
 * the entity graph records that two things were named together and makes no
 * other claim, and the same restraint belongs to people.
 *
 * `neighbours_we_know` is how many of those the agent already has a
 * relationship with, which is what makes a bridge score mean anything -- an
 * account whose whole neighbourhood is already ours leads nowhere new.
 */
export async function neighbourCounts(input: {
  agentId: string;
  accountId: string;
  sinceIso?: string;
  limit?: number;
}): Promise<NeighbourRow[]> {
  const params: unknown[] = [input.accountId, input.agentId];
  const since = input.sinceIso ? `AND COALESCE(e.occurred_at, e.ingested_at) >= $3` : '';
  if (input.sinceIso) params.push(input.sinceIso);
  params.push(Math.min(Math.max(input.limit ?? 200, 1), 1_000));

  return query<NeighbourRow>(
    `WITH seen AS (
        SELECT DISTINCT lower(e.remote_author_handle) AS handle, e.remote_conversation_id AS conversation
          FROM events e
         WHERE e.account_id = $1
           AND e.remote_author_handle IS NOT NULL
           AND e.remote_conversation_id IS NOT NULL
           ${since}
      ),
      pairs AS (
        SELECT a.handle, b.handle AS neighbour
          FROM seen a
          JOIN seen b ON a.conversation = b.conversation AND a.handle <> b.handle
      )
      SELECT p.handle,
             count(DISTINCT p.neighbour)::int AS neighbours,
             count(DISTINCT p.neighbour) FILTER (
               WHERE EXISTS (
                 SELECT 1 FROM relationships r
                  WHERE r.agent_id = $2 AND lower(r.handle) = p.neighbour
               )
             )::int AS neighbours_we_know
        FROM pairs p
       GROUP BY p.handle
       ORDER BY neighbours DESC
       LIMIT $${params.length}`,
    params,
  );
}

/**
 * Accounts this agent has published something to since a moment.
 *
 * Real actions only, and executed ones only. A dry run is not a public
 * position, so it is not a reason to hold off approaching somebody -- and a
 * draft that was never sent has not used anybody's attention.
 */
export async function handlesEngagedSince(agentId: string, sinceIso: string): Promise<string[]> {
  const rows = await query<{ handle: string }>(
    `SELECT DISTINCT lower(substring(target_ref from 'x\\.com/([A-Za-z0-9_]{1,15})/')) AS handle
       FROM actions
      WHERE agent_id = $1
        AND dry_run = false
        AND status = 'EXECUTED'
        AND executed_at >= $2
        AND target_ref IS NOT NULL`,
    [agentId, sinceIso],
  );
  return rows.map((row) => row.handle).filter((handle): handle is string => Boolean(handle));
}
