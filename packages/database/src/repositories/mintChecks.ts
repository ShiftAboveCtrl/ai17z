import { mapRow, mapRows } from '../mapper';
import { query, queryOne, withTransaction } from '../pool';

export type MintCheckOutcome = 'CARD' | 'POINTER' | 'REFUSED';

export interface MintCheckRow {
  id: string;
  agentId: string;
  jobId: string;
  channel: string;
  askerKey: string;
  askerHandle: string | null;
  mint: string | null;
  chain: string | null;
  outcome: MintCheckOutcome;
  pointsTo: string | null;
  watchState: 'WATCHING' | null;
  watchedAt: string | null;
  createdAt: string;
}

/** What a pointer needs to say about the card it points at. */
export interface PointerTarget {
  askedAt: string;
  /** Where the card was published, when it was and the channel gave a link. */
  url: string | null;
}

export type ClaimResult =
  | { capped: true }
  | { capped: false; row: MintCheckRow; pointer: PointerTarget | null };

/** Jobs that never reached anybody are not a card somebody can be pointed at. */
const NEVER_SENT = `('PERMANENT_FAILURE', 'CANCELLED', 'DRY_RUN_COMPLETED')`;

async function pointerFor(row: MintCheckRow): Promise<PointerTarget | null> {
  if (row.outcome !== 'POINTER' || !row.pointsTo) return null;
  const card = await queryOne<{ created_at: Date; url: string | null }>(
    `SELECT c.created_at,
            (SELECT a.remote_action_url FROM actions a
              WHERE a.job_id = c.job_id AND a.status = 'EXECUTED' AND a.dry_run = false
              ORDER BY a.created_at DESC LIMIT 1) AS url
       FROM mint_check_requests c WHERE c.id = $1`,
    [row.pointsTo],
  );
  return card ? { askedAt: card.created_at.toISOString(), url: card.url } : null;
}

export async function forJob(jobId: string): Promise<MintCheckRow | null> {
  return mapRow<MintCheckRow>(await queryOne('SELECT * FROM mint_check_requests WHERE job_id = $1', [jobId]));
}

/** How many requests this asker has made in the last hour, answered or refused. */
export async function askerCountSince(agentId: string, askerKey: string, sinceMs: number): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM mint_check_requests
      WHERE agent_id = $1 AND asker_key = $2 AND created_at > now() - ($3::bigint * interval '1 millisecond')`,
    [agentId, askerKey, sinceMs],
  );
  return Number(row?.n ?? 0);
}

/**
 * Takes this job's place in the limits, or says the asker has used theirs.
 *
 * One transaction under an advisory lock per agent, because two workers reading
 * the count at the same moment would both see room, and a cap that two requests
 * can spend together is not a cap. The job id is unique, so a retried job reads
 * back the answer it was already given instead of taking a second place.
 *
 * A mint asked about inside the cooldown becomes a pointer at the earlier card,
 * not a second card: five people asking about one mint in a minute produce one
 * read and four short replies.
 */
export async function claim(input: {
  agentId: string;
  jobId: string;
  channel: string;
  askerKey: string;
  askerHandle: string | null;
  /** Null for a refusal, which has no mint and never earns a card. */
  mint: string | null;
  chain: string | null;
  askerCap: number;
  cooldownMs: number;
}): Promise<ClaimResult> {
  const result = await withTransaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`mint-check:${input.agentId}`]);

    const existing = await tx.one('SELECT * FROM mint_check_requests WHERE job_id = $1', [input.jobId]);
    if (existing) return { capped: false as const, row: mapRow<MintCheckRow>(existing)! };

    const recent = await tx.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM mint_check_requests
        WHERE agent_id = $1 AND asker_key = $2 AND created_at > now() - interval '1 hour'`,
      [input.agentId, input.askerKey],
    );
    if (Number(recent?.n ?? 0) >= input.askerCap) return { capped: true as const };

    let outcome: MintCheckOutcome = input.mint ? 'CARD' : 'REFUSED';
    let pointsTo: string | null = null;
    if (input.mint) {
      const earlier = await tx.one<{ id: string }>(
        `SELECT c.id FROM mint_check_requests c JOIN jobs j ON j.id = c.job_id
          WHERE c.agent_id = $1 AND c.mint = $2 AND c.outcome = 'CARD'
            AND c.created_at > now() - ($3::bigint * interval '1 millisecond')
            AND j.status NOT IN ${NEVER_SENT}
          ORDER BY c.created_at DESC LIMIT 1`,
        [input.agentId, input.mint, input.cooldownMs],
      );
      if (earlier) {
        outcome = 'POINTER';
        pointsTo = earlier.id;
      }
    }

    const inserted = await tx.one(
      `INSERT INTO mint_check_requests
         (agent_id, job_id, channel, asker_key, asker_handle, mint, chain, outcome, points_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [input.agentId, input.jobId, input.channel, input.askerKey, input.askerHandle, input.mint, input.chain, outcome, pointsTo],
    );
    return { capped: false as const, row: mapRow<MintCheckRow>(inserted)! };
  });

  if (result.capped) return result;
  return { capped: false, row: result.row, pointer: await pointerFor(result.row) };
}

/** Cards the owner has not yet decided about, newest first. */
export async function undecidedCards(agentId: string | null, limit = 10): Promise<MintCheckRow[]> {
  return mapRows<MintCheckRow>(
    await query(
      `SELECT c.* FROM mint_check_requests c JOIN jobs j ON j.id = c.job_id
        WHERE c.outcome = 'CARD' AND c.watch_state IS NULL
          AND c.created_at > now() - interval '24 hours'
          AND j.status NOT IN ${NEVER_SENT}
          AND ($1::uuid IS NULL OR c.agent_id = $1)
        ORDER BY c.created_at DESC LIMIT $2`,
      [agentId, limit],
    ),
  );
}

export async function byId(id: string): Promise<MintCheckRow | null> {
  return mapRow<MintCheckRow>(await queryOne('SELECT * FROM mint_check_requests WHERE id = $1', [id]));
}

/**
 * Records that the owner confirmed a watch on this card's mint.
 *
 * The only writer of the watch columns, and called from the owner's own
 * surfaces: nothing that handles a stranger's text reaches it.
 */
export async function markWatching(id: string): Promise<boolean> {
  const row = await queryOne(
    `UPDATE mint_check_requests SET watch_state = 'WATCHING', watched_at = now()
      WHERE id = $1 AND outcome = 'CARD' AND watch_state IS NULL RETURNING id`,
    [id],
  );
  return row !== null;
}
