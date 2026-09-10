import { query, withTransaction } from '../pool';

/**
 * The half of an upstream's budget that belongs to this installation.
 *
 * Two of this installation's processes can be spending it at once, so the sum
 * and the spend have to happen without a gap between them. An advisory lock
 * taken on the budget's own name does that: it serialises reservations for one
 * key across every process on this database, and it is released when the
 * transaction ends however the transaction ends -- including a worker being
 * killed mid-request, which a row-based lock would leave stuck.
 *
 * Deliberately not the place for a budget an endpoint scopes to the source
 * address. Two installations have two databases; see `MACHINE` scope.
 */

/** Rows older than this are of no use to any window and are swept. */
const KEEP_MS = 25 * 60 * 60_000;

export interface ReserveInput {
  quotaKey: string;
  /** Every window sharing this budget: capacity and interval, all checked. */
  windows: { capacity: number; intervalMs: number; label: string }[];
  weight: number;
}

export type ReserveOutcome = { granted: true } | { granted: false; retryAfterMs: number; window: string };

export async function reserve(input: ReserveInput): Promise<ReserveOutcome> {
  return withTransaction(async (tx) => {
    // Serialises this budget across processes for the length of the
    // transaction. `hashtext` because the lock takes a bigint and the key is a
    // name; a collision costs two unrelated budgets a little contention and
    // never correctness.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.quotaKey]);

    for (const window of input.windows) {
      const { rows } = await tx.query<{ used: string }>(
        `SELECT coalesce(sum(weight), 0)::text AS used
           FROM upstream_quota_spends
          WHERE quota_key = $1
            AND interval_ms = $2
            AND spent_at > now() - make_interval(secs => $3::double precision)`,
        [input.quotaKey, window.intervalMs, window.intervalMs / 1000],
      );
      const used = Number(rows[0]?.used ?? '0');
      if (used + input.weight > window.capacity) {
        // When the oldest spend in the window falls out, there is room again.
        const { rows: oldest } = await tx.query<{ ms: string | null }>(
          `SELECT (extract(epoch from (min(spent_at) + make_interval(secs => $3::double precision) - now())) * 1000)::text AS ms
             FROM upstream_quota_spends
            WHERE quota_key = $1
              AND interval_ms = $2
              AND spent_at > now() - make_interval(secs => $3::double precision)`,
          [input.quotaKey, window.intervalMs, window.intervalMs / 1000],
        );
        const retryAfterMs = Math.max(1, Math.ceil(Number(oldest[0]?.ms ?? window.intervalMs)));
        return { granted: false, retryAfterMs, window: window.label };
      }
    }

    // Every window is checked before any is spent, so a request that cannot
    // afford the daily budget does not spend the per-second one finding out.
    for (const window of input.windows) {
      await tx.query(
        'INSERT INTO upstream_quota_spends (quota_key, interval_ms, weight) VALUES ($1,$2,$3)',
        [input.quotaKey, window.intervalMs, input.weight],
      );
    }
    return { granted: true };
  });
}

export async function blockUntil(input: { quotaKey: string; until: Date; why: string }): Promise<void> {
  await query(
    `INSERT INTO upstream_blocks (quota_key, until, why)
     VALUES ($1,$2,$3)
     ON CONFLICT (quota_key) DO UPDATE
       -- A second refusal arriving while the first is in force must not shorten
       -- it. The operator asking for longer is the one to believe.
       SET until = GREATEST(upstream_blocks.until, excluded.until),
           why = excluded.why,
           updated_at = now()`,
    [input.quotaKey, input.until.toISOString(), input.why.slice(0, 500)],
  );
}

/** How long until this budget may be used again, in milliseconds. */
export async function blockedFor(quotaKey: string): Promise<number> {
  const rows = await query<{ ms: string | null }>(
    `SELECT (extract(epoch from (until - now())) * 1000)::text AS ms
       FROM upstream_blocks WHERE quota_key = $1 AND until > now()`,
    [quotaKey],
  );
  const ms = Number(rows[0]?.ms ?? '0');
  return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms) : 0;
}

/**
 * Drops spends no window can still be counting, and blocks that have expired.
 *
 * Called from the recovery sweep rather than on a timer of its own: this is a
 * worker that runs for weeks, and an unbounded ledger is a slow leak that only
 * shows up on somebody's machine after a fortnight.
 */
export async function sweepQuota(): Promise<{ spends: number; blocks: number }> {
  const spends = await query<{ n: string }>(
    `WITH gone AS (
       DELETE FROM upstream_quota_spends
        WHERE spent_at < now() - make_interval(secs => $1::double precision)
      RETURNING 1
     ) SELECT count(*)::text AS n FROM gone`,
    [KEEP_MS / 1000],
  );
  const blocks = await query<{ n: string }>(
    `WITH gone AS (
       DELETE FROM upstream_blocks WHERE until < now() - interval '1 hour' RETURNING 1
     ) SELECT count(*)::text AS n FROM gone`,
  );
  return { spends: Number(spends[0]?.n ?? '0'), blocks: Number(blocks[0]?.n ?? '0') };
}
