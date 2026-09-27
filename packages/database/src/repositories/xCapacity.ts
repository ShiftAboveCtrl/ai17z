import type { CapacityClass } from '@xbam/shared/contracts';
import { mapRow } from '../mapper';
import { query, queryOne } from '../pool';
import type { AccountHealth } from './autonomy';

/**
 * The meter behind one account's X budget.
 *
 * Two things are kept, both on purpose small. The account row holds where the
 * breaker stands (its health, until when, how many times it has tripped in a
 * row), because that is what every reader already looks at. The ledger holds
 * the last day of reads and pushback, because every question asked of it is
 * about the last hour and a count read off rows cannot drift the way a counter
 * can.
 */

export type XSignal = 'RATE_LIMITED' | 'STALLED' | 'BROKEN';

export interface CapacityStateRow {
  status: string;
  health: AccountHealth;
  healthReason: string | null;
  healthUntil: string | null;
  healthChangedAt: string | null;
  healthStrikes: number;
  healthSignal: string | null;
  healthSignalAt: string | null;
}

export async function getState(accountId: string): Promise<CapacityStateRow | null> {
  return mapRow<CapacityStateRow>(
    await queryOne(
      `SELECT status, health, health_reason, health_until, health_changed_at,
              health_strikes, health_signal, health_signal_at
         FROM accounts WHERE id = $1`,
      [accountId],
    ),
  );
}

/**
 * Moves the breaker.
 *
 * `health_changed_at` moves only when the state does, for the same reason
 * `setAccountHealth` gives: "cooling down for the last forty minutes" has to
 * stay answerable, and it is also where the next count starts from.
 */
export async function setState(input: {
  accountId: string;
  health: AccountHealth;
  reason: string | null;
  until: Date | null;
  strikes: number;
}): Promise<void> {
  await query(
    `UPDATE accounts
        SET health = $2,
            health_reason = $3,
            health_until = $4,
            health_strikes = $5,
            health_changed_at = CASE WHEN health IS DISTINCT FROM $2 THEN now() ELSE health_changed_at END
      WHERE id = $1`,
    [input.accountId, input.health, input.reason?.slice(0, 300) ?? null, input.until, Math.max(0, input.strikes)],
  );
}

/** Keeps the ledger a meter rather than a history. One day is far more than any question needs. */
async function prune(accountId: string): Promise<void> {
  await query(`DELETE FROM x_capacity_ledger WHERE account_id = $1 AND at < now() - interval '1 day'`, [accountId]);
}

export async function recordRead(accountId: string, klass: CapacityClass): Promise<void> {
  await query(`INSERT INTO x_capacity_ledger (account_id, entry, class) VALUES ($1, 'READ', $2)`, [accountId, klass]);
  // Roughly one prune in fifty writes: enough to keep the table to a day, not
  // so often that every read pays for a delete.
  if (Math.random() < 0.02) await prune(accountId);
}

export async function recordSignal(
  accountId: string,
  klass: CapacityClass,
  signal: XSignal,
  detail: string,
): Promise<void> {
  await query(
    `INSERT INTO x_capacity_ledger (account_id, entry, class, signal, detail) VALUES ($1, 'SIGNAL', $2, $3, $4)`,
    [accountId, klass, signal, detail.slice(0, 300)],
  );
  await query(`UPDATE accounts SET health_signal = $2, health_signal_at = now() WHERE id = $1`, [
    accountId,
    `${signal}: ${detail}`.slice(0, 300),
  ]);
}

export interface CapacityUsage {
  /** Reads in the trailing ten minutes, every class together. */
  readsLast10Minutes: number;
  /** Reads in the trailing ten minutes spent for each class. */
  readsByClass: Record<CapacityClass, number>;
  /** Pushback since `since`, by kind. */
  rateLimits: number;
  stalled: number;
  broken: number;
  /** When the oldest read in the ten-minute window will age out of it. */
  oldestReadAt: string | null;
}

/**
 * What the account has asked of X lately, and how X answered.
 *
 * Pushback is counted from `since`, never from a fixed hour. A cooldown that
 * has just ended would otherwise meet the very signals that caused it still
 * sitting in the trailing hour and trip again on the spot, which is a breaker
 * that can never close.
 */
export async function usage(accountId: string, since: Date): Promise<CapacityUsage> {
  const reads = await query<{ class: CapacityClass; n: number; oldest: string | null }>(
    `SELECT class, count(*)::int AS n, min(at) AS oldest
       FROM x_capacity_ledger
      WHERE account_id = $1 AND entry = 'READ' AND at > now() - interval '10 minutes'
      GROUP BY class`,
    [accountId],
  );
  const signals = await query<{ signal: XSignal; n: number }>(
    `SELECT signal, count(*)::int AS n
       FROM x_capacity_ledger
      WHERE account_id = $1 AND entry = 'SIGNAL' AND at > $2
      GROUP BY signal`,
    [accountId, since],
  );
  const readsByClass: Record<CapacityClass, number> = { DIRECT: 0, TARGET: 0, BROAD: 0 };
  let oldest: string | null = null;
  for (const row of reads) {
    readsByClass[row.class] = row.n;
    if (row.oldest && (!oldest || new Date(row.oldest) < new Date(oldest))) oldest = row.oldest;
  }
  const count = (kind: XSignal) => signals.find((row) => row.signal === kind)?.n ?? 0;
  return {
    readsLast10Minutes: readsByClass.DIRECT + readsByClass.TARGET + readsByClass.BROAD,
    readsByClass,
    rateLimits: count('RATE_LIMITED'),
    stalled: count('STALLED'),
    broken: count('BROKEN'),
    oldestReadAt: oldest,
  };
}

/** How many of this account's radar sources are failing right now. */
export async function failingSources(accountId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM radar_sources
      WHERE account_id = $1 AND enabled AND consecutive_failures > 0`,
    [accountId],
  );
  return row?.n ?? 0;
}

/** Pushback recorded in the trailing day, newest first, for the owner's screen. */
export async function recentSignals(
  accountId: string,
  limit = 10,
): Promise<{ at: string; class: CapacityClass; signal: XSignal; detail: string | null }[]> {
  return query<{ at: string; class: CapacityClass; signal: XSignal; detail: string | null }>(
    `SELECT at, class, signal, detail FROM x_capacity_ledger
      WHERE account_id = $1 AND entry = 'SIGNAL'
      ORDER BY at DESC LIMIT $2`,
    [accountId, limit],
  );
}
