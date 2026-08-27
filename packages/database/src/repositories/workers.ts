import { mapRows } from '../mapper';
import { query, queryOne } from '../pool';

export interface WorkerRow {
  id: string;
  role: string;
  browserCapable: boolean;
  jobsCapable: boolean;
  hostname: string | null;
  version: string | null;
  startedAt: string;
  lastSeenAt: string;
}

/**
 * A worker is considered present for this long after its last heartbeat.
 *
 * Generous relative to the beat itself: a worker busy driving a slow browser
 * page should not be declared missing, because the consequence of that is
 * telling somebody their sign-in cannot run when it can.
 */
export const WORKER_PRESENT_SECONDS = 90;

export async function heartbeat(input: {
  id: string;
  role: string;
  browserCapable: boolean;
  jobsCapable: boolean;
  hostname?: string | null;
  version?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO workers (id, role, browser_capable, jobs_capable, hostname, version)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (id) DO UPDATE
       SET role = excluded.role,
           browser_capable = excluded.browser_capable,
           jobs_capable = excluded.jobs_capable,
           hostname = excluded.hostname,
           version = excluded.version,
           last_seen_at = now()`,
    [input.id, input.role, input.browserCapable, input.jobsCapable, input.hostname ?? null, input.version ?? null],
  );
}

export async function goodbye(id: string): Promise<void> {
  await query('DELETE FROM workers WHERE id = $1', [id]);
}

export async function present(): Promise<WorkerRow[]> {
  return mapRows<WorkerRow>(
    await query(
      `SELECT * FROM workers WHERE last_seen_at > now() - ($1::int * interval '1 second')
        ORDER BY last_seen_at DESC`,
      [WORKER_PRESENT_SECONDS],
    ),
  );
}

/**
 * Whether anything that can open a browser is currently running.
 *
 * The API asks this before queueing browser work, so "nothing here can do that"
 * is said at the moment of asking rather than becoming a task that waits
 * forever for a worker that does not exist.
 */
export async function browserWorkerPresent(): Promise<boolean> {
  const row = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM workers
      WHERE browser_capable AND last_seen_at > now() - ($1::int * interval '1 second')`,
    [WORKER_PRESENT_SECONDS],
  );
  return (row?.n ?? 0) > 0;
}
