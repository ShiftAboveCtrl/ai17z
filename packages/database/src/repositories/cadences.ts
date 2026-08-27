import type { CadenceConfig } from '@xbam/shared/contracts';
import { defaultCadence } from '@xbam/shared/contracts';
import { XbamError } from '@xbam/shared';
import { mapRow, mapRows } from '../mapper';
import { query, queryOne, withTransaction } from '../pool';

/** INSERT ... RETURNING cannot return nothing; say so rather than casting. */
function required<T>(row: T | null, what: string): T {
  if (!row) throw new XbamError('INTERNAL', `Writing the ${what} returned no row.`);
  return row;
}

export interface CadenceVersionRow {
  id: string;
  cadenceId: string;
  version: number;
  config: CadenceConfig;
  changeNote: string;
  createdBy: string | null;
  createdAt: string;
}

/**
 * The cadence in force for an account.
 *
 * An account with no cadence row yet runs on the defaults rather than not being
 * polled at all, so adding cadence to an existing install changes nothing until
 * someone edits it.
 */
export async function activeCadence(accountId: string): Promise<CadenceConfig> {
  const row = await queryOne<{ config: CadenceConfig }>(
    `SELECT cv.config FROM accounts a
       JOIN cadence_versions cv ON cv.id = a.cadence_version_id
      WHERE a.id = $1`,
    [accountId],
  );
  return row ? row.config : defaultCadence();
}

export async function listVersions(accountId: string): Promise<CadenceVersionRow[]> {
  const rows = await query(
    `SELECT cv.* FROM cadences c JOIN cadence_versions cv ON cv.cadence_id = c.id
      WHERE c.account_id = $1 ORDER BY cv.version DESC`,
    [accountId],
  );
  return mapRows<CadenceVersionRow>(rows);
}

/** Writes a new version and points the account at it. Never edits one in place. */
export async function saveVersion(
  accountId: string,
  config: CadenceConfig,
  changeNote: string,
  createdBy: string | null,
): Promise<CadenceVersionRow> {
  return withTransaction(async (tx) => {
    const cadence = required(
      await tx.one<{ id: string }>(
        `INSERT INTO cadences (account_id) VALUES ($1)
         ON CONFLICT (account_id) DO UPDATE SET account_id = EXCLUDED.account_id
         RETURNING id`,
        [accountId],
      ),
      'cadence',
    );
    const next = required(
      await tx.one<{ version: number }>(
        'SELECT coalesce(max(version), 0) + 1 AS version FROM cadence_versions WHERE cadence_id = $1',
        [cadence.id],
      ),
      'cadence version number',
    );
    const row = required(
      await tx.one(
        `INSERT INTO cadence_versions (cadence_id, version, config, change_note, created_by)
         VALUES ($1,$2,$3::jsonb,$4,$5) RETURNING *`,
        [cadence.id, next.version, JSON.stringify(config), changeNote, createdBy],
      ),
      'cadence version',
    );
    // A cadence change takes effect now, not after the old interval expires.
    await tx.query(
      'UPDATE accounts SET cadence_version_id = $2, next_poll_at = now(), empty_poll_streak = 0 WHERE id = $1',
      [accountId, row.id as string],
    );
    return required(mapRow<CadenceVersionRow>(row), 'cadence version');
  });
}

export interface DueAccount {
  id: string;
  ownerId: string;
  channel: string;
  handle: string;
  emptyPollStreak: number;
  config: CadenceConfig;
}

/**
 * Accounts whose next poll is due.
 *
 * The schedule lives in the database, not in a timer, so a worker restart does
 * not reset every account to "poll now" and two workers cannot both decide an
 * account is due: the claim moves next_poll_at forward in the same statement.
 */
export async function claimDueAccounts(limit: number, holdSeconds: number): Promise<DueAccount[]> {
  const rows = await query(
    `UPDATE accounts SET next_poll_at = now() + make_interval(secs => $2)
      WHERE id IN (
        SELECT id FROM accounts
         WHERE enabled AND status = 'CONNECTED' AND channel <> 'mock'
           AND (next_poll_at IS NULL OR next_poll_at <= now())
         ORDER BY next_poll_at NULLS FIRST
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, owner_id, channel, handle, empty_poll_streak,
                (SELECT config FROM cadence_versions cv WHERE cv.id = accounts.cadence_version_id) AS config`,
    [limit, holdSeconds],
  );
  return mapRows<{ config: CadenceConfig | null } & Omit<DueAccount, 'config'>>(rows).map((row) => ({
    ...row,
    config: row.config ?? defaultCadence(),
  }));
}

/** Records the outcome of a poll and sets the next due time. */
export async function recordPoll(accountId: string, nextPollAt: Date, foundEvents: boolean): Promise<void> {
  await query(
    `UPDATE accounts
        SET last_polled_at = now(),
            next_poll_at = $2,
            empty_poll_streak = CASE WHEN $3 THEN 0 ELSE empty_poll_streak + 1 END
      WHERE id = $1`,
    [accountId, nextPollAt, foundEvents],
  );
}

/** Scheduling state for the UI: when this account was last read and when next. */
export async function pollState(accountId: string): Promise<{
  lastPolledAt: string | null;
  nextPollAt: string | null;
  emptyPollStreak: number;
} | null> {
  return mapRow(
    await queryOne('SELECT last_polled_at, next_poll_at, empty_poll_streak FROM accounts WHERE id = $1', [accountId]),
  );
}
