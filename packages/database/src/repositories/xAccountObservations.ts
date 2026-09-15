import { mapRow, mapRows } from '../mapper';
import { query, queryOne } from '../pool';
import { withTransaction } from '../pool';

/**
 * What AI17Z has read about somebody on X.
 *
 * One row per person per owner, and "person" means the numeric id wherever one
 * was visible. Everything else -- the handle included -- is an observation of
 * what they were called when somebody looked.
 *
 * Nothing here decides what an observation *means*. Whether the agent knows
 * somebody, how well, and how it should speak to them is the relationship
 * system's business and stays there. This answers the narrower question the
 * relationship system cannot: what does their account actually say.
 */

export interface XAccountObservationRow {
  id: string;
  ownerUserId: string;
  /** Empty when the reader could not see one. Never null: see migration 0074. */
  userId: string;
  handle: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  location: string | null;
  website: string | null;
  /** Null is "not visible", never zero. */
  followers: number | null;
  following: number | null;
  posts: number | null;
  joinedAt: string | null;
  verified: boolean | null;
  protected: boolean | null;
  /** Null is "X did not say", never "no". See migration 0074. */
  weFollow: boolean | null;
  followsUs: boolean | null;
  observations: Record<string, unknown>;
  outcome: string;
  detail: string;
  backend: string;
  gaps: string[];
  observedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecordObservationInput {
  ownerUserId: string;
  userId: string | null;
  handle: string;
  displayName?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  bannerUrl?: string | null;
  location?: string | null;
  website?: string | null;
  followers?: number | null;
  following?: number | null;
  posts?: number | null;
  joinedAt?: string | null;
  verified?: boolean | null;
  protected?: boolean | null;
  weFollow?: boolean | null;
  followsUs?: boolean | null;
  observations?: Record<string, unknown>;
  outcome: string;
  detail?: string;
  backend?: string;
  gaps?: string[];
  observedAt?: string;
}

function clean(handle: string): string {
  return handle.trim().replace(/^@+/, '');
}

const COLUMNS = `id, owner_user_id, user_id, handle, display_name, bio, avatar_url, banner_url,
  location, website, followers, following, posts, joined_at, verified, protected,
  we_follow, follows_us, observations, outcome, detail, backend, gaps, observed_at,
  created_at, updated_at`;

/**
 * Store what a read found.
 *
 * Two statements inside one transaction rather than a single upsert, and the
 * reason is a rename. A person is found by their id when there is one, so a
 * read of `@alice_eth` lands on the row that was written for `@alice` and moves
 * the handle across -- one person, one row, one history. Going straight to an
 * upsert on the handle would write a second row, and the partial unique index
 * on the id would then reject it, which is the constraint doing its job and
 * producing an error where an update was wanted.
 *
 * The transaction matters because the two statements are a read and a write of
 * the same key: without it two reads of the same person arriving together can
 * both find nothing and both insert.
 */
export async function record(input: RecordObservationInput): Promise<XAccountObservationRow> {
  const handle = clean(input.handle);
  const userId = input.userId?.trim() ?? '';
  const values = [
    input.ownerUserId,
    userId,
    handle,
    input.displayName ?? null,
    input.bio ?? null,
    input.avatarUrl ?? null,
    input.bannerUrl ?? null,
    input.location ?? null,
    input.website ?? null,
    input.followers ?? null,
    input.following ?? null,
    input.posts ?? null,
    input.joinedAt ?? null,
    input.verified ?? null,
    input.protected ?? null,
    input.weFollow ?? null,
    input.followsUs ?? null,
    JSON.stringify(input.observations ?? {}),
    input.outcome,
    input.detail ?? '',
    input.backend ?? '',
    JSON.stringify(input.gaps ?? []),
    input.observedAt ?? new Date().toISOString(),
  ];

  const assignments = `user_id = $2, handle = $3, display_name = $4, bio = $5, avatar_url = $6,
      banner_url = $7, location = $8, website = $9, followers = $10, following = $11, posts = $12,
      joined_at = $13, verified = $14, protected = $15, we_follow = $16, follows_us = $17,
      observations = $18::jsonb, outcome = $19, detail = $20, backend = $21, gaps = $22::jsonb,
      observed_at = $23, updated_at = now()`;

  return withTransaction(async (tx) => {
    if (userId) {
      const existing = await tx.one<{ id: string }>(
        'SELECT id FROM x_account_observations WHERE owner_user_id = $1 AND user_id = $2',
        [input.ownerUserId, userId],
      );
      if (existing) {
        // The same person, whatever they are calling themselves today.
        // Scoped to the owner as well as to the row. Redundant given the row
        // was found by owner a statement ago, and kept because an update that
        // can only ever touch the asking owner's data is a property worth
        // having in the statement rather than in the argument for it.
        const updated = await tx.one(
          `UPDATE x_account_observations SET ${assignments}
            WHERE id = $24 AND owner_user_id = $1 RETURNING ${COLUMNS}`,
          [...values, existing.id],
        );
        return mapRow<XAccountObservationRow>(updated) as XAccountObservationRow;
      }
    }

    const row = await tx.one(
      `INSERT INTO x_account_observations
         (owner_user_id, user_id, handle, display_name, bio, avatar_url, banner_url, location,
          website, followers, following, posts, joined_at, verified, protected, we_follow,
          follows_us, observations, outcome, detail, backend, gaps, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20,$21,$22::jsonb,$23)
       ON CONFLICT (owner_user_id, lower(handle)) DO UPDATE SET ${assignments}
       RETURNING ${COLUMNS}`,
      values,
    );
    return mapRow<XAccountObservationRow>(row) as XAccountObservationRow;
  });
}

/**
 * What is known about somebody, preferring the id over what they are called.
 *
 * Same order as `relationships.find`, and for the same reason: somebody who
 * renamed themselves is the same person, and looking them up by handle first
 * would find nothing and report a stranger.
 */
export async function find(input: {
  ownerUserId: string;
  handle?: string | null;
  userId?: string | null;
}): Promise<XAccountObservationRow | null> {
  if (input.userId) {
    const byId = await queryOne(
      `SELECT ${COLUMNS} FROM x_account_observations WHERE owner_user_id = $1 AND user_id = $2`,
      [input.ownerUserId, input.userId],
    );
    if (byId) return mapRow<XAccountObservationRow>(byId);
  }
  if (!input.handle) return null;
  return mapRow<XAccountObservationRow>(
    await queryOne(
      `SELECT ${COLUMNS} FROM x_account_observations WHERE owner_user_id = $1 AND lower(handle) = lower($2)`,
      [input.ownerUserId, clean(input.handle)],
    ),
  );
}

/** Everything read for this owner, most recently looked at first. */
export async function list(
  ownerUserId: string,
  options: { limit?: number; search?: string } = {},
): Promise<XAccountObservationRow[]> {
  const params: unknown[] = [ownerUserId];
  const clauses = ['owner_user_id = $1'];
  if (options.search) {
    params.push(`%${clean(options.search)}%`);
    clauses.push(`(handle ILIKE $${params.length} OR display_name ILIKE $${params.length})`);
  }
  params.push(Math.min(Math.max(options.limit ?? 50, 1), 200));
  return mapRows<XAccountObservationRow>(
    await query(
      `SELECT ${COLUMNS} FROM x_account_observations WHERE ${clauses.join(' AND ')}
        ORDER BY observed_at DESC LIMIT $${params.length}`,
      params,
    ),
  );
}

/**
 * What is known about a list of handles, in one query.
 *
 * The bridge scores ask about a hundred accounts at once, and the whole reason
 * this table exists is that asking X a hundred times is not an option. Asking
 * Postgres a hundred times would be a smaller version of the same mistake.
 */
export async function findManyByHandle(
  ownerUserId: string,
  handles: string[],
): Promise<Map<string, XAccountObservationRow>> {
  const wanted = [...new Set(handles.map((h) => clean(h).toLowerCase()).filter(Boolean))];
  if (wanted.length === 0) return new Map();
  const rows = mapRows<XAccountObservationRow>(
    await query(
      `SELECT ${COLUMNS} FROM x_account_observations
        WHERE owner_user_id = $1 AND lower(handle) = ANY($2::text[])`,
      [ownerUserId, wanted],
    ),
  );
  return new Map(rows.map((row) => [row.handle.toLowerCase(), row]));
}

/** Forget one. For an owner who no longer wants a record of having looked. */
export async function forget(ownerUserId: string, id: string): Promise<boolean> {
  const rows = await query('DELETE FROM x_account_observations WHERE owner_user_id = $1 AND id = $2 RETURNING id', [
    ownerUserId,
    id,
  ]);
  return rows.length > 0;
}
