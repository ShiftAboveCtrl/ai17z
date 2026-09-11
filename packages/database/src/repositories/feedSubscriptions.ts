import { XbamError } from '@xbam/shared';
import { mapRow, mapRows } from '../mapper';
import { query, queryOne } from '../pool';

/**
 * What a feed watcher remembers between polls.
 *
 * The whole of this file exists for one invariant: **a restart must not replay
 * history as new work.** Everything else here is bookkeeping.
 */

/** INSERT ... RETURNING cannot return nothing; say so rather than casting. */
function required<T>(row: T | null, what: string): T {
  if (!row) throw new XbamError('INTERNAL', `Writing the ${what} returned no row.`);
  return row;
}

export interface FeedSubscription {
  id: string;
  url: string;
  label: string;
  enabled: boolean;
  intervalSeconds: number;
  nextPollAt: string;
  etag: string | null;
  lastModified: string | null;
  seenEntryIds: string[];
  primed: boolean;
  lastPolledAt: string | null;
  lastStatus: string;
  lastError: string;
  consecutiveFailures: number;
  totalEntriesSeen: number;
  createdAt: string;
  updatedAt: string;
}

const COLUMNS = `
  id, url, label, enabled, interval_seconds, next_poll_at, etag, last_modified,
  seen_entry_ids, primed, last_polled_at, last_status, last_error,
  consecutive_failures, total_entries_seen, created_at, updated_at`;

/**
 * How many entry ids one subscription remembers.
 *
 * A feed shows its most recent entries and nothing older -- ten to fifty is
 * typical, a few hundred is unusual. Remembering more than a feed will ever show
 * again is storage spent on entries that cannot reappear, so the window is
 * generous rather than unbounded and the oldest fall off the end.
 */
export const SEEN_WINDOW = 500;

export async function listSubscriptions(): Promise<FeedSubscription[]> {
  return mapRows<FeedSubscription>(
    await query(`SELECT ${COLUMNS} FROM feed_subscriptions ORDER BY created_at`),
  );
}

export async function getSubscription(id: string): Promise<FeedSubscription | null> {
  return mapRow<FeedSubscription>(await queryOne(`SELECT ${COLUMNS} FROM feed_subscriptions WHERE id = $1`, [id]));
}

export async function subscribe(input: {
  url: string;
  label?: string;
  intervalSeconds?: number;
}): Promise<FeedSubscription> {
  // Subscribing twice to one URL is not an error worth failing a caller over,
  // and it must not create a second row that polls the same feed again.
  const row = await queryOne(
    `INSERT INTO feed_subscriptions (url, label, interval_seconds)
     VALUES ($1, $2, coalesce($3, 900))
     ON CONFLICT (url) DO UPDATE
       SET label = coalesce(nullif(excluded.label, ''), feed_subscriptions.label),
           enabled = true,
           updated_at = now()
     RETURNING ${COLUMNS}`,
    [input.url, input.label ?? '', input.intervalSeconds ?? null],
  );
  return required(mapRow<FeedSubscription>(row), 'feed subscription');
}

export async function unsubscribe(id: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>('DELETE FROM feed_subscriptions WHERE id = $1 RETURNING id', [id]);
  return row !== null;
}

export async function setEnabled(id: string, enabled: boolean): Promise<FeedSubscription | null> {
  return mapRow<FeedSubscription>(
    await queryOne(
      `UPDATE feed_subscriptions SET enabled = $2, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, enabled],
    ),
  );
}

/**
 * Feeds whose next poll is due, claimed as they are read.
 *
 * The same shape the account poller uses, and for the same reasons. The claim
 * moves `next_poll_at` forward in the statement that selects the row, so two
 * workers cannot take one feed and a restart cannot stampede every feed at once.
 * `FOR UPDATE SKIP LOCKED` is what makes the second worker step over a row the
 * first already has rather than wait behind it.
 *
 * The due time is pushed out by `holdSeconds` rather than by the feed's own
 * interval, because this is a lease: a worker that dies mid-poll must not leave
 * the feed unpolled until its interval comes round again. Finishing the poll
 * sets the real next time.
 */
export async function claimDueFeeds(limit: number, holdSeconds: number): Promise<FeedSubscription[]> {
  return mapRows<FeedSubscription>(
    await query(
      `UPDATE feed_subscriptions SET next_poll_at = now() + make_interval(secs => $2)
       WHERE id IN (
         SELECT id FROM feed_subscriptions
         WHERE enabled AND next_poll_at <= now()
         ORDER BY next_poll_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING ${COLUMNS}`,
      [limit, holdSeconds],
    ),
  );
}

/**
 * Merges what was just seen into what was already known.
 *
 * Plain, and in TypeScript rather than in SQL, because this is the cursor and
 * the cursor is the one thing in the feature that must be obviously right. An
 * array merge expressed as a UNION with ordinality is clever, unreadable, and
 * cannot be unit tested without a database.
 *
 * Newest first, duplicates dropped keeping the earliest occurrence, and the
 * tail trimmed: an entry that has fallen off the end of a feed cannot reappear
 * to be mistaken for new, so remembering it for ever buys nothing.
 */
export function mergeSeen(justSeen: readonly string[], alreadySeen: readonly string[]): string[] {
  const merged: string[] = [];
  const known = new Set<string>();
  for (const id of [...justSeen, ...alreadySeen]) {
    if (known.has(id)) continue;
    known.add(id);
    merged.push(id);
    if (merged.length >= SEEN_WINDOW) break;
  }
  return merged;
}

/** Records a successful poll, including the cursor it now carries. */
export async function recordPoll(input: {
  id: string;
  etag: string | null;
  lastModified: string | null;
  /** The full merged cursor, from `mergeSeen`. */
  seenEntryIds: string[];
  intervalSeconds: number;
  status: string;
  entriesSeen: number;
}): Promise<void> {
  await query(
    `UPDATE feed_subscriptions
        SET etag = $2,
            last_modified = $3,
            seen_entry_ids = $4::text[],
            primed = true,
            last_polled_at = now(),
            last_status = $5,
            last_error = '',
            consecutive_failures = 0,
            total_entries_seen = total_entries_seen + $6,
            next_poll_at = now() + make_interval(secs => $7),
            updated_at = now()
      WHERE id = $1`,
    [
      input.id,
      input.etag,
      input.lastModified,
      input.seenEntryIds,
      input.status,
      input.entriesSeen,
      input.intervalSeconds,
    ],
  );
}

/**
 * Records a failed poll, and backs off.
 *
 * A feed that has been broken for a week must not be asked every fifteen
 * minutes for ever: the interval doubles per consecutive failure up to a
 * ceiling. The cursor is untouched, because a failure says nothing about what
 * has been seen -- clearing it here is how a transient outage turns into a
 * replay of everything once the feed comes back.
 */
export async function recordFailure(input: { id: string; error: string; intervalSeconds: number }): Promise<void> {
  await query(
    `UPDATE feed_subscriptions
        SET last_polled_at = now(),
            last_status = 'FAILED',
            last_error = left($2, 500),
            consecutive_failures = consecutive_failures + 1,
            next_poll_at = now() + make_interval(
              secs => least($3 * power(2, least(consecutive_failures + 1, 6))::int, 86400)
            ),
            updated_at = now()
      WHERE id = $1`,
    [input.id, input.error, input.intervalSeconds],
  );
}
