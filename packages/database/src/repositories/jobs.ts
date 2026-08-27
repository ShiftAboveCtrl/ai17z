import type { ActionType, ChannelId, ErrorClass, JobRecord, JobStatus, ResolvedContext } from '@xbam/shared/contracts';
import { CLAIMABLE_JOB_STATUSES, IN_FLIGHT_JOB_STATUSES, IN_FLIGHT_RESUME } from '@xbam/shared/contracts';
import { NotFoundError } from '@xbam/shared';
import { query, queryOne, type Tx } from '../pool';
import { mapRow, mapRows } from '../mapper';

const COLUMNS = `
  id, event_id, agent_id, account_id, conversation_id, channel, action_type, status, requires_browser,
  attempt_count, max_attempts, priority, dry_run, run_at, locked_by, lock_expires_at,
  persona_version_id, policy_version_id, pipeline_version_id, prompt_template_version_id,
  current_node_key, resolved_context, generated_output, validated_output, error_class, last_error,
  idempotency_key, created_at, updated_at, context_resolved_at, memory_resolved_at,
  generated_at, validated_at, approved_at, executed_at`;

export interface CreateJobInput {
  eventId: string;
  agentId: string;
  accountId: string | null;
  channel: ChannelId;
  actionType: ActionType;
  idempotencyKey: string;
  dryRun: boolean;
  maxAttempts: number;
  priority?: number;
  personaVersionId: string | null;
  policyVersionId: string | null;
  pipelineVersionId: string | null;
  promptTemplateVersionId: string | null;
  conversationId?: string | null;
  /** True when advancing this job needs a browser, so only a browser-capable worker claims it. */
  requiresBrowser: boolean;
}

export interface CreateJobResult {
  job: JobRecord;
  /** False when a job for this idempotency key already existed. */
  created: boolean;
}

/**
 * One job per (channel, account, remote event, action, agent). The unique index
 * on `idempotency_key` is the guarantee; this function never creates a second.
 */
export async function createJob(tx: Tx, input: CreateJobInput): Promise<CreateJobResult> {
  const params = [
    input.eventId,
    input.agentId,
    input.accountId,
    input.channel,
    input.actionType,
    input.idempotencyKey,
    input.dryRun,
    input.maxAttempts,
    input.priority ?? 100,
    input.personaVersionId,
    input.policyVersionId,
    input.pipelineVersionId,
    input.promptTemplateVersionId,
    input.conversationId ?? null,
    input.requiresBrowser,
  ];
  const inserted = await tx.one(
    `INSERT INTO jobs (event_id, agent_id, account_id, channel, action_type, idempotency_key,
       dry_run, max_attempts, priority, persona_version_id, policy_version_id,
       pipeline_version_id, prompt_template_version_id, conversation_id, requires_browser)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING ${COLUMNS}`,
    params,
  );
  if (inserted) return { job: mapRow<JobRecord>(inserted) as JobRecord, created: true };
  const existing = await tx.one(`SELECT ${COLUMNS} FROM jobs WHERE idempotency_key = $1`, [input.idempotencyKey]);
  return { job: mapRow<JobRecord>(existing) as JobRecord, created: false };
}

export async function getJob(id: string): Promise<JobRecord | null> {
  return mapRow<JobRecord>(await queryOne(`SELECT ${COLUMNS} FROM jobs WHERE id = $1`, [id]));
}

export async function requireJob(id: string): Promise<JobRecord> {
  const job = await getJob(id);
  if (!job) throw new NotFoundError('Job');
  return job;
}

/**
 * Atomically leases up to `limit` due jobs. `FOR UPDATE SKIP LOCKED` is what lets
 * several workers run concurrently without ever handing the same job to two of them.
 */
export interface ClaimOptions {
  /**
   * What this worker can serve. A containerised worker has no browser, so it
   * must never claim a job whose next step needs one: it would fail work that
   * another worker could have completed.
   */
  browserCapable: boolean;
  /** When false, this worker claims only browser work. */
  jobsCapable: boolean;
}

export async function claimJobs(
  workerId: string,
  limit: number,
  leaseMs: number,
  options: ClaimOptions = { browserCapable: true, jobsCapable: true },
): Promise<JobRecord[]> {
  if (!options.browserCapable && !options.jobsCapable) return [];

  const capability = options.browserCapable && options.jobsCapable
    ? 'TRUE'
    : options.browserCapable
      ? 'requires_browser'
      : 'NOT requires_browser';

  const rows = await query(
    `UPDATE jobs SET locked_by = $1,
                     lock_expires_at = now() + make_interval(secs => $2::double precision),
                     updated_at = now()
      WHERE id IN (
        SELECT id FROM jobs
         WHERE status = ANY($3::text[])
           AND run_at <= now()
           AND ${capability}
           AND (locked_by IS NULL OR lock_expires_at < now())
         ORDER BY priority ASC, run_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $4
      )
      RETURNING ${COLUMNS}`,
    [workerId, leaseMs / 1000, [...CLAIMABLE_JOB_STATUSES], limit],
  );
  return mapRows<JobRecord>(rows);
}

export async function extendLease(jobId: string, workerId: string, leaseMs: number): Promise<void> {
  await query(
    `UPDATE jobs SET lock_expires_at = now() + make_interval(secs => $3::double precision), updated_at = now()
      WHERE id = $1 AND locked_by = $2`,
    [jobId, workerId, leaseMs / 1000],
  );
}

export async function releaseLease(jobId: string): Promise<void> {
  await query('UPDATE jobs SET locked_by = NULL, lock_expires_at = NULL, updated_at = now() WHERE id = $1', [jobId]);
}

/**
 * Returns jobs whose worker died mid-step to the settled state before that step.
 * This is what makes `docker compose restart` safe.
 */
export async function recoverExpiredLeases(): Promise<JobRecord[]> {
  const cases = Object.entries(IN_FLIGHT_RESUME)
    .map(([from, to]) => `WHEN '${from}' THEN '${to}'`)
    .join(' ');
  const rows = await query(
    `UPDATE jobs
        SET status = CASE status ${cases} ELSE status END,
            locked_by = NULL,
            lock_expires_at = NULL,
            updated_at = now()
      WHERE locked_by IS NOT NULL
        AND lock_expires_at < now()
        AND status = ANY($1::text[])
      RETURNING ${COLUMNS}`,
    [[...IN_FLIGHT_JOB_STATUSES]],
  );
  return mapRows<JobRecord>(rows);
}

export interface JobPatch {
  status?: JobStatus;
  currentNodeKey?: string | null;
  resolvedContext?: ResolvedContext | null;
  generatedOutput?: string | null;
  validatedOutput?: string | null;
  conversationId?: string | null;
  errorClass?: ErrorClass | null;
  lastError?: string | null;
  attemptCount?: number;
  runAt?: string;
  releaseLock?: boolean;
  touch?: Array<'contextResolvedAt' | 'memoryResolvedAt' | 'generatedAt' | 'validatedAt' | 'approvedAt' | 'executedAt'>;
}

const TOUCH_COLUMNS: Record<string, string> = {
  contextResolvedAt: 'context_resolved_at',
  memoryResolvedAt: 'memory_resolved_at',
  generatedAt: 'generated_at',
  validatedAt: 'validated_at',
  approvedAt: 'approved_at',
  executedAt: 'executed_at',
};

export async function updateJob(id: string, patch: JobPatch, executor?: Tx): Promise<JobRecord> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const push = (fragment: string, value: unknown) => {
    params.push(value);
    sets.push(fragment.replace('$?', `$${params.length}`));
  };
  if (patch.status !== undefined) push('status = $?', patch.status);
  if (patch.currentNodeKey !== undefined) push('current_node_key = $?', patch.currentNodeKey);
  if (patch.resolvedContext !== undefined) push('resolved_context = $?::jsonb', JSON.stringify(patch.resolvedContext));
  if (patch.generatedOutput !== undefined) push('generated_output = $?', patch.generatedOutput);
  if (patch.validatedOutput !== undefined) push('validated_output = $?', patch.validatedOutput);
  if (patch.conversationId !== undefined) push('conversation_id = $?', patch.conversationId);
  if (patch.errorClass !== undefined) push('error_class = $?', patch.errorClass);
  if (patch.lastError !== undefined) push('last_error = $?', patch.lastError);
  if (patch.attemptCount !== undefined) push('attempt_count = $?', patch.attemptCount);
  if (patch.runAt !== undefined) push('run_at = $?', patch.runAt);
  if (patch.releaseLock) sets.push('locked_by = NULL, lock_expires_at = NULL');
  for (const key of patch.touch ?? []) {
    const column = TOUCH_COLUMNS[key];
    if (column) sets.push(`${column} = now()`);
  }
  if (sets.length === 0) return requireJob(id);

  const sql = `UPDATE jobs SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`;
  const row = executor ? await executor.one(sql, params) : await queryOne(sql, params);
  if (!row) throw new NotFoundError('Job');
  return mapRow<JobRecord>(row) as JobRecord;
}

export async function recordAttempt(input: {
  jobId: string;
  attempt: number;
  step: string;
  workerId: string | null;
  outcome: 'OK' | 'RETRYABLE' | 'PERMANENT' | 'REVIEW_REQUIRED';
  errorClass?: string | null;
  error?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO job_attempts (job_id, attempt, step, worker_id, finished_at, outcome, error_class, error)
     VALUES ($1,$2,$3,$4, now(), $5,$6,$7)
     ON CONFLICT (job_id, attempt, step) DO UPDATE
       SET finished_at = now(), outcome = excluded.outcome,
           error_class = excluded.error_class, error = excluded.error`,
    [input.jobId, input.attempt, input.step, input.workerId, input.outcome, input.errorClass ?? null, input.error ?? null],
  );
}

export interface JobAttemptRow {
  id: string;
  jobId: string;
  attempt: number;
  step: string;
  workerId: string | null;
  startedAt: string;
  finishedAt: string | null;
  outcome: string | null;
  errorClass: string | null;
  error: string | null;
}

export async function listJobAttempts(jobId: string): Promise<JobAttemptRow[]> {
  return mapRows<JobAttemptRow>(
    await query('SELECT * FROM job_attempts WHERE job_id = $1 ORDER BY started_at', [jobId]),
  );
}

export interface JobListFilters {
  agentId?: string;
  accountId?: string;
  statuses?: JobStatus[];
  channel?: ChannelId;
  dryRun?: boolean;
  limit?: number;
  offset?: number;
}

export interface JobSummary extends JobRecord {
  agentName: string;
  authorHandle: string | null;
  incomingText: string;
  remoteUrl: string | null;
}

const SUMMARY_COLUMNS = `
  ${COLUMNS.split(',').map((c) => `j.${c.trim()}`).join(', ')},
  a.name AS agent_name,
  e.remote_author_handle AS author_handle,
  e.text AS incoming_text,
  e.remote_url`;

export async function listJobs(filters: JobListFilters): Promise<{ items: JobSummary[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const add = (fragment: string, value: unknown) => {
    params.push(value);
    conditions.push(fragment.replace('$?', `$${params.length}`));
  };
  if (filters.agentId) add('j.agent_id = $?', filters.agentId);
  if (filters.accountId) add('j.account_id = $?', filters.accountId);
  if (filters.channel) add('j.channel = $?', filters.channel);
  if (filters.dryRun !== undefined) add('j.dry_run = $?', filters.dryRun);
  if (filters.statuses?.length) add('j.status = ANY($?::text[])', filters.statuses);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const totalRow = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM jobs j ${where}`,
    params,
  );
  params.push(filters.limit ?? 50, filters.offset ?? 0);
  const rows = await query(
    `SELECT ${SUMMARY_COLUMNS}
       FROM jobs j
       JOIN agents a ON a.id = j.agent_id
       JOIN events e ON e.id = j.event_id
       ${where}
      ORDER BY j.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { items: mapRows<JobSummary>(rows), total: totalRow?.count ?? 0 };
}

export async function countJobsByStatus(agentId?: string): Promise<Record<string, number>> {
  const rows = agentId
    ? await query<{ status: string; count: number }>(
        'SELECT status, count(*)::int AS count FROM jobs WHERE agent_id = $1 GROUP BY status',
        [agentId],
      )
    : await query<{ status: string; count: number }>('SELECT status, count(*)::int AS count FROM jobs GROUP BY status');
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}

/** Actions executed in the trailing window, used by the rate-limit policy. */
export async function countRecentActions(agentId: string, sinceMinutes: number): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM actions
      WHERE agent_id = $1 AND dry_run = false AND status = 'EXECUTED'
        AND executed_at > now() - ($2::int * interval '1 minute')`,
    [agentId, sinceMinutes],
  );
  return row?.count ?? 0;
}

export async function lastExecutedActionAt(agentId: string): Promise<string | null> {
  const row = await queryOne<{ at: Date | null }>(
    `SELECT max(executed_at) AS at FROM actions WHERE agent_id = $1 AND dry_run = false AND status = 'EXECUTED'`,
    [agentId],
  );
  return row?.at ? new Date(row.at).toISOString() : null;
}
