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

/**
 * Every browser intent the code can record.
 *
 * A list rather than a bare union because `browser_tasks.kind` has a CHECK
 * behind it: adding a kind here without widening that constraint fails at the
 * database and passes every unit test, which is the failure this shape lets
 * `tests/integration/statusConstraints.test.ts` catch.
 */
export const BROWSER_TASK_KINDS = [
  'CONNECT',
  'HEALTH_CHECK',
  'OPEN_AUTH',
  'SCREENSHOT',
  'CLEAR',
  'DISCONNECT',
  'INGEST',
  'PREFLIGHT',
  'CANCEL_AUTH',
  'SHUTDOWN_BROWSER',
  /** Type the account's stored sign-in details into the form. Opt-in. */
  'CREDENTIAL_SIGN_IN',
  /**
   * Read a public account's own writing, to learn a voice from it.
   *
   * Browser work, so it belongs here rather than in the API: the API owns
   * no browsers. The feature used to shell out to a Python library from
   * the API process, which no packaged installation has.
   */
  'COLLECT_PERSONA',
  /**
   * Read a public account, so the owner can be shown who somebody is.
   *
   * Here for the same reason as COLLECT_PERSONA: it needs the signed-in
   * browser, and only the worker has one. Read-only and structurally unable to
   * be anything else -- it calls the X intelligence layer, which has no write
   * in it.
   */
  'READ_X_ACCOUNT',
  /**
   * Read one real post, so an agent can be tried against it without publishing.
   *
   * Here for the same reason as the two above: the lab needs the signed-in
   * browser and only the worker has one. What it does with what it read is
   * manufacture an event and run the ordinary pipeline as a dry run, so the
   * read is the only part that touches X at all.
   */
  'REHEARSE_X_POST',
] as const;
export type BrowserTaskKind = (typeof BROWSER_TASK_KINDS)[number];

/**
 * Kinds where a second request is a *different* intention, so it waits rather
 * than replacing the one before it.
 *
 * Every one of these names a target in its parameters: a handle to read, a
 * handle to learn a voice from, a post to rehearse against. Asking to read
 * Alice and then Bob is two requests and has to stay two.
 *
 * Everything not listed keeps replacing: pressing Connect again means "do it
 * now", not "do it twice", and a newer sign-in request genuinely supersedes an
 * older one.
 */
export const QUEUEABLE_BROWSER_TASK_KINDS: readonly BrowserTaskKind[] = ['READ_X_ACCOUNT', 'COLLECT_PERSONA', 'REHEARSE_X_POST'];

/**
 * How deep one account's queue may get.
 *
 * A bound rather than a policy: a loop that asks for a thousand reads is a bug
 * somewhere else, and a queue that accepts them turns it into a browser holding
 * an account's X budget for a day. Refused with a sentence rather than
 * silently dropped, which is the fault this whole change is about.
 */
export const MAX_QUEUED_BROWSER_TASKS = 20;

/**
 * What a queueable task is *about*, so two requests for the same thing coalesce.
 *
 * Read off the parameters each route already sends rather than from a new
 * column, because the target is already there and a second place to record it
 * is a second thing to keep in step. A kind with no target never coalesces,
 * which is the safe direction: it queues.
 */
export function browserTaskTarget(kind: BrowserTaskKind, params: Record<string, unknown> | null | undefined): string | null {
  const read = (key: string): string | null => {
    const value = (params ?? {})[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim().toLowerCase() : null;
  };
  switch (kind) {
    case 'READ_X_ACCOUNT':
    case 'COLLECT_PERSONA':
      return read('handle');
    case 'REHEARSE_X_POST':
      return read('postRef');
    default:
      return null;
  }
}

export interface BrowserTaskRow {
  id: string;
  accountId: string | null;
  kind: BrowserTaskKind;
  status: 'QUEUED' | 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'SUPERSEDED';
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
  // A system task belongs to no account and has no lane to queue in, so only an
  // account-bound task of a target-carrying kind can wait.
  const queueableAccount = QUEUEABLE_BROWSER_TASK_KINDS.includes(input.kind) ? input.accountId : null;

  // Two requests for the same thing are one request. Checked before inserting
  // rather than after colliding, because the existing one may be QUEUED and so
  // would not collide at all.
  if (queueableAccount !== null) {
    const existing = await sameTargetAlreadyWaiting(queueableAccount, input.kind, input.params ?? {});
    if (existing) return existing;
  }

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

      // Something is already active on this account. For a kind that names a
      // target, this request is a different one and waits its turn; the worker
      // promotes it when the account has nothing active. For everything else
      // the older task is an intention rather than an operation, and is
      // replaced.
      if (queueableAccount !== null) return await queueBehind({ ...input, accountId: queueableAccount });

      const cleared = await clearBlockingTask(input.accountId, input.kind);
      if (!cleared.freed) {
        throw new ConflictError(cleared.message, { taskId: cleared.taskId });
      }
    }
  }
  // The loop either returns or throws; this satisfies the compiler.
  throw new ConflictError('That browser task could not be queued.');
}

/** An unfinished request for the same target, which this one would duplicate. */
async function sameTargetAlreadyWaiting(
  accountId: string,
  kind: BrowserTaskKind,
  params: Record<string, unknown>,
): Promise<BrowserTaskRow | null> {
  const target = browserTaskTarget(kind, params);
  if (target === null) return null;
  const rows = mapRows<BrowserTaskRow>(
    await query(
      `SELECT * FROM browser_tasks
        WHERE account_id = $1 AND kind = $2 AND status IN ('QUEUED','PENDING','RUNNING')
        ORDER BY created_at`,
      [accountId, kind],
    ),
  );
  return rows.find((row) => browserTaskTarget(row.kind, row.params) === target) ?? null;
}

/**
 * Records a request that has to wait, without taking the browser lane.
 *
 * QUEUED is outside `browser_tasks_active_key`, so this cannot collide with the
 * active task, and exclusivity stays the index's to enforce.
 */
async function queueBehind(input: {
  accountId: string;
  kind: BrowserTaskKind;
  requestedBy: string | null;
  params?: Record<string, unknown>;
}): Promise<BrowserTaskRow> {
  const waiting = await queryOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM browser_tasks WHERE account_id = $1 AND status = 'QUEUED'`,
    [input.accountId],
  );
  if (Number(waiting?.n ?? '0') >= MAX_QUEUED_BROWSER_TASKS) {
    throw new ConflictError(
      `${MAX_QUEUED_BROWSER_TASKS} browser requests are already waiting on this account. ` +
        'Let those finish before asking for more.',
    );
  }
  const row = await queryOne(
    `INSERT INTO browser_tasks (account_id, kind, requested_by, params, status)
     VALUES ($1,$2,$3,$4::jsonb,'QUEUED') RETURNING *`,
    [input.accountId, input.kind, input.requestedBy, JSON.stringify(input.params ?? {})],
  );
  return mapRow<BrowserTaskRow>(row) as BrowserTaskRow;
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

/**
 * Claims one task. Only the worker calls this.
 *
 * A QUEUED task is claimable only while its account has nothing PENDING or
 * RUNNING, which is what makes waiting in line safe: one browser per profile
 * throughout. The `NOT EXISTS` is belt as well as braces, because
 * `browser_tasks_active_key` would refuse the update anyway -- but a unique
 * violation on every poll is a worker fighting the database rather than
 * reading it, so the condition is stated here too.
 *
 * Ordered by creation across both statuses, so a queued read that has been
 * waiting is served before a request that arrived a moment ago.
 */
export async function claimBrowserTask(workerId: string): Promise<BrowserTaskRow | null> {
  const row = await queryOne(
    `UPDATE browser_tasks SET status = 'RUNNING', started_at = now(), locked_by = $1
      WHERE id = (
        SELECT t.id FROM browser_tasks t
         WHERE t.status = 'PENDING'
            OR (
              t.status = 'QUEUED'
              AND NOT EXISTS (
                SELECT 1 FROM browser_tasks active
                 WHERE active.account_id IS NOT DISTINCT FROM t.account_id
                   AND active.status IN ('PENDING', 'RUNNING')
              )
            )
         ORDER BY t.created_at FOR UPDATE SKIP LOCKED LIMIT 1
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
