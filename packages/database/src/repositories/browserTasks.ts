import { ConflictError } from '@xbam/shared';
import { isUniqueViolation, query, queryOne } from '../pool';
import { mapRow, mapRows } from '../mapper';

/**
 * How long a RUNNING task may go without finishing before it is presumed dead.
 *
 * Longer than any real browser operation: an OPEN_AUTH holds a window open
 * while a person signs in. Shorter than a person's patience with a stuck
 * account.
 */
export const RUNNING_LEASE_MINUTES = 12;

export type BrowserTaskKind =
  | 'CONNECT'
  | 'HEALTH_CHECK'
  | 'OPEN_AUTH'
  | 'SCREENSHOT'
  | 'CLEAR'
  | 'DISCONNECT'
  | 'INGEST'
  | 'PREFLIGHT'
  | 'CANCEL_AUTH';

export interface BrowserTaskRow {
  id: string;
  accountId: string | null;
  kind: BrowserTaskKind;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  requestedBy: string | null;
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * Queues a browser intent.
 *
 * Pressing the button again is a request to do the thing now, not a mistake to
 * be refused. A task nobody has started yet is superseded rather than treated as
 * work in progress: the earlier one represents an intention, not an operation,
 * and refusing on its behalf is how an account ends up permanently stuck behind
 * a task that will never run.
 *
 * A task that is genuinely RUNNING still blocks, because a second browser on the
 * same profile is a real conflict. Its lease is what decides whether "running"
 * is still true.
 */
export async function enqueueBrowserTask(input: {
  /** Null for system-level tasks such as preflight, which belong to no account. */
  accountId: string | null;
  kind: BrowserTaskKind;
  requestedBy: string | null;
  params?: Record<string, unknown>;
}): Promise<BrowserTaskRow> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const row = await queryOne(
        `INSERT INTO browser_tasks (account_id, kind, requested_by, params)
         VALUES ($1,$2,$3,$4::jsonb) RETURNING *`,
        [input.accountId, input.kind, input.requestedBy, JSON.stringify(input.params ?? {})],
      );
      return mapRow<BrowserTaskRow>(row) as BrowserTaskRow;
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === 1) throw error;

      // Free whatever is standing in the way, if it is not actually working.
      const cleared = await clearBlockingTask(input.accountId, input.kind);
      if (!cleared.freed) {
        throw new ConflictError(cleared.message, { taskId: cleared.taskId });
      }
    }
  }
  // The loop either returns or throws; this satisfies the compiler.
  throw new ConflictError('That browser task could not be queued.');
}

/**
 * Decides whether an active task is really in the way.
 *
 * Superseded and expired tasks are settled here rather than left for the
 * recovery sweep, because the person is waiting now.
 */
async function clearBlockingTask(
  accountId: string | null,
  kind: BrowserTaskKind,
): Promise<{ freed: boolean; message: string; taskId: string | null }> {
  const active = mapRow<BrowserTaskRow>(
    await queryOne(
      accountId === null
        ? `SELECT * FROM browser_tasks WHERE account_id IS NULL AND kind = $1 AND status IN ('PENDING','RUNNING')`
        : `SELECT * FROM browser_tasks WHERE account_id = $1 AND status IN ('PENDING','RUNNING')`,
      [accountId === null ? kind : accountId],
    ),
  );

  // The index said something was there; if it has since settled, just retry.
  if (!active) return { freed: true, message: '', taskId: null };

  if (active.status === 'PENDING') {
    await query(
      `UPDATE browser_tasks
          SET status = 'SUPERSEDED', finished_at = now(),
              error = 'Replaced by a newer request for the same account.'
        WHERE id = $1`,
      [active.id],
    );
    return { freed: true, message: '', taskId: active.id };
  }

  // RUNNING. Only a live lease is a real conflict.
  const stale = await queryOne<{ stale: boolean }>(
    `SELECT started_at < now() - ($2::int * interval '1 minute') AS stale FROM browser_tasks WHERE id = $1`,
    [active.id, RUNNING_LEASE_MINUTES],
  );
  if (stale?.stale) {
    await query(
      `UPDATE browser_tasks
          SET status = 'FAILED', finished_at = now(), locked_by = NULL,
              error = 'The worker running this stopped without finishing it.'
        WHERE id = $1`,
      [active.id],
    );
    return { freed: true, message: '', taskId: active.id };
  }

  return {
    freed: false,
    message:
      accountId === null
        ? `A ${active.kind} is running right now. It will finish shortly.`
        : `A ${active.kind} is running on this account right now. It will finish shortly, or you can cancel it.`,
    taskId: active.id,
  };
}

/** Cancels a task that has not finished. Safe to call on one already settled. */
export async function cancelBrowserTask(id: string, reason: string): Promise<boolean> {
  const rows = await query(
    `UPDATE browser_tasks
        SET status = 'CANCELLED', finished_at = now(), locked_by = NULL, error = $2
      WHERE id = $1 AND status IN ('PENDING','RUNNING')
      RETURNING id`,
    [id, reason],
  );
  return rows.length > 0;
}

/** Cancels every unfinished task on an account. Used when a person gives up. */
export async function cancelAccountTasks(accountId: string, reason: string): Promise<number> {
  const rows = await query(
    `UPDATE browser_tasks
        SET status = 'CANCELLED', finished_at = now(), locked_by = NULL, error = $2
      WHERE account_id = $1 AND status IN ('PENDING','RUNNING')
      RETURNING id`,
    [accountId, reason],
  );
  return rows.length;
}

export async function getBrowserTask(id: string): Promise<BrowserTaskRow | null> {
  return mapRow<BrowserTaskRow>(await queryOne('SELECT * FROM browser_tasks WHERE id = $1', [id]));
}

export async function listBrowserTasks(accountId: string, limit = 20): Promise<BrowserTaskRow[]> {
  return mapRows<BrowserTaskRow>(
    await query('SELECT * FROM browser_tasks WHERE account_id = $1 ORDER BY created_at DESC LIMIT $2', [
      accountId,
      limit,
    ]),
  );
}

/** Claims one pending task. Only the worker calls this. */
export async function claimBrowserTask(workerId: string): Promise<BrowserTaskRow | null> {
  const row = await queryOne(
    `UPDATE browser_tasks SET status = 'RUNNING', started_at = now(), locked_by = $1
      WHERE id = (
        SELECT id FROM browser_tasks WHERE status = 'PENDING'
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
      )
      RETURNING *`,
    [workerId],
  );
  return mapRow<BrowserTaskRow>(row);
}

export async function finishBrowserTask(
  id: string,
  status: 'COMPLETED' | 'FAILED',
  result: Record<string, unknown> | null,
  error?: string | null,
): Promise<void> {
  await query(
    `UPDATE browser_tasks SET status = $2, result = $3::jsonb, error = $4, finished_at = now(), locked_by = NULL
      WHERE id = $1`,
    [id, status, result ? JSON.stringify(result) : null, error ?? null],
  );
}

/**
 * Frees tasks that are not going to finish.
 *
 * Two different failures, deliberately reported differently:
 *
 * A RUNNING task outlived its lease, which means the worker holding it died.
 *
 * A PENDING task was never claimed at all. That is not a crash — it is nothing
 * being able to run it, and saying so is the difference between a person
 * checking their worker and a person pressing the button again forever.
 */
export async function recoverStaleBrowserTasks(
  runningLeaseMinutes = RUNNING_LEASE_MINUTES,
  unclaimedMinutes = 5,
): Promise<{ abandoned: number; unclaimed: number }> {
  const abandoned = await query(
    `UPDATE browser_tasks SET status = 'FAILED', error = 'The worker running this stopped without finishing it.',
            finished_at = now(), locked_by = NULL
      WHERE status = 'RUNNING' AND started_at < now() - ($1::int * interval '1 minute')
      RETURNING id`,
    [runningLeaseMinutes],
  );

  const unclaimed = await query(
    `UPDATE browser_tasks SET status = 'FAILED',
            error = 'No worker able to open a browser picked this up. Start one on the machine with the browser.',
            finished_at = now()
      WHERE status = 'PENDING' AND created_at < now() - ($1::int * interval '1 minute')
      RETURNING id`,
    [unclaimedMinutes],
  );

  return { abandoned: abandoned.length, unclaimed: unclaimed.length };
}
