import { query, queryOne } from '../pool';

/**
 * One browser profile, one operation at a time.
 *
 * A Chromium profile cannot be driven by two things at once, and two jobs
 * navigating the same page is how automation ends up replying to the wrong post.
 * This is a lease rather than a lock: a worker that dies releases it by expiry.
 */
export interface AccountLease {
  accountId: string;
  workerId: string;
  reason: string;
  expiresAt: string;
}

export async function acquireAccountLease(input: {
  accountId: string;
  workerId: string;
  reason: string;
  ttlMs: number;
}): Promise<AccountLease | null> {
  const row = await queryOne<{ busy_until: Date }>(
    `UPDATE accounts
        SET busy_by = $2,
            busy_reason = $3,
            busy_until = now() + ($4::int * interval '1 millisecond')
      WHERE id = $1
        AND (busy_by IS NULL OR busy_until < now() OR busy_by = $2)
      RETURNING busy_until`,
    [input.accountId, input.workerId, input.reason, input.ttlMs],
  );
  if (!row) return null;
  return {
    accountId: input.accountId,
    workerId: input.workerId,
    reason: input.reason,
    expiresAt: new Date(row.busy_until).toISOString(),
  };
}

export async function extendAccountLease(accountId: string, workerId: string, ttlMs: number): Promise<void> {
  await query(
    `UPDATE accounts SET busy_until = now() + ($3::int * interval '1 millisecond')
      WHERE id = $1 AND busy_by = $2`,
    [accountId, workerId, ttlMs],
  );
}

export async function releaseAccountLease(accountId: string, workerId: string): Promise<void> {
  await query(
    'UPDATE accounts SET busy_by = NULL, busy_until = NULL, busy_reason = NULL WHERE id = $1 AND busy_by = $2',
    [accountId, workerId],
  );
}

export async function currentAccountLease(accountId: string): Promise<AccountLease | null> {
  const row = await queryOne<{ busy_by: string | null; busy_reason: string | null; busy_until: Date | null }>(
    'SELECT busy_by, busy_reason, busy_until FROM accounts WHERE id = $1 AND busy_until > now()',
    [accountId],
  );
  if (!row?.busy_by || !row.busy_until) return null;
  return {
    accountId,
    workerId: row.busy_by,
    reason: row.busy_reason ?? 'busy',
    expiresAt: new Date(row.busy_until).toISOString(),
  };
}

/**
 * Runs `fn` while holding the account. Returns null without running when the
 * account is already busy, so the caller can retry rather than queue behind it.
 */
export async function withAccountLease<T>(
  input: { accountId: string; workerId: string; reason: string; ttlMs: number },
  fn: () => Promise<T>,
): Promise<{ held: true; value: T } | { held: false; heldBy: AccountLease | null }> {
  const lease = await acquireAccountLease(input);
  if (!lease) return { held: false, heldBy: await currentAccountLease(input.accountId) };

  const renew = setInterval(() => {
    void extendAccountLease(input.accountId, input.workerId, input.ttlMs).catch(() => undefined);
  }, Math.max(5_000, Math.floor(input.ttlMs / 3)));

  try {
    return { held: true, value: await fn() };
  } finally {
    clearInterval(renew);
    await releaseAccountLease(input.accountId, input.workerId).catch(() => undefined);
  }
}
