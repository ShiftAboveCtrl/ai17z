import { ConflictError } from '@xbam/shared';
import { isUniqueViolation, query, queryOne } from '../pool';
import { mapRow, mapRows } from '../mapper';

export type BrowserTaskKind =
  | 'CONNECT'
  | 'HEALTH_CHECK'
  | 'OPEN_AUTH'
  | 'SCREENSHOT'
  | 'CLEAR'
  | 'DISCONNECT'
  | 'INGEST';

export interface BrowserTaskRow {
  id: string;
  accountId: string;
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

export async function enqueueBrowserTask(input: {
  accountId: string;
  kind: BrowserTaskKind;
  requestedBy: string | null;
  params?: Record<string, unknown>;
}): Promise<BrowserTaskRow> {
  try {
    const row = await queryOne(
      `INSERT INTO browser_tasks (account_id, kind, requested_by, params)
       VALUES ($1,$2,$3,$4::jsonb) RETURNING *`,
      [input.accountId, input.kind, input.requestedBy, JSON.stringify(input.params ?? {})],
    );
    return mapRow<BrowserTaskRow>(row) as BrowserTaskRow;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const active = await queryOne(
      `SELECT * FROM browser_tasks WHERE account_id = $1 AND status IN ('PENDING','RUNNING')`,
      [input.accountId],
    );
    const existing = mapRow<BrowserTaskRow>(active);
    throw new ConflictError(
      `A ${existing?.kind ?? 'browser'} task is already running for this account. Wait for it to finish.`,
      { taskId: existing?.id ?? null },
    );
  }
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

/** Frees tasks abandoned by a worker that died mid-run. */
export async function recoverStaleBrowserTasks(olderThanMinutes = 10): Promise<number> {
  const rows = await query(
    `UPDATE browser_tasks SET status = 'FAILED', error = 'Worker stopped before the task finished.',
            finished_at = now(), locked_by = NULL
      WHERE status = 'RUNNING' AND started_at < now() - ($1::int * interval '1 minute')
      RETURNING id`,
    [olderThanMinutes],
  );
  return rows.length;
}
