import type { ActionRecord, ActionStatus, Approval, ErrorClass } from '@xbam/shared/contracts';
import { NotFoundError } from '@xbam/shared';
import { query, queryOne, isUniqueViolation } from '../pool';
import { mapRow, mapRows } from '../mapper';

const COLUMNS = `
  id, job_id, agent_id, account_id, channel, type, status, dry_run, payload, target_ref,
  remote_action_id, remote_action_url, verification, idempotency_key, content_signature,
  error_class, last_error, created_at, executed_at`;

export interface ClaimActionInput {
  jobId: string;
  agentId: string;
  accountId: string | null;
  channel: string;
  type: string;
  dryRun: boolean;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  targetRef: string | null;
}

export type ClaimActionResult =
  | { outcome: 'CLAIMED'; action: ActionRecord }
  | { outcome: 'ALREADY_EXECUTED'; action: ActionRecord }
  | { outcome: 'IN_PROGRESS'; action: ActionRecord };

/**
 * Reserves the right to perform a remote action. The partial unique index on
 * `idempotency_key` (real actions only) means a second caller can never get a
 * second PENDING row for the same event: it sees the existing one instead.
 */
export async function claimAction(input: ClaimActionInput): Promise<ClaimActionResult> {
  const insertParams = [
    input.jobId,
    input.agentId,
    input.accountId,
    input.channel,
    input.type,
    input.dryRun,
    JSON.stringify(input.payload),
    input.targetRef,
    input.idempotencyKey,
  ];
  try {
    const row = await queryOne(
      `INSERT INTO actions (job_id, agent_id, account_id, channel, type, dry_run, payload, target_ref, idempotency_key, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,'EXECUTING')
       RETURNING ${COLUMNS}`,
      insertParams,
    );
    return { outcome: 'CLAIMED', action: mapRow<ActionRecord>(row) as ActionRecord };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await queryOne(
      `SELECT ${COLUMNS} FROM actions WHERE idempotency_key = $1 AND dry_run = false`,
      [input.idempotencyKey],
    );
    if (!existing) throw error;
    const action = mapRow<ActionRecord>(existing) as ActionRecord;
    if (action.status === 'EXECUTED') return { outcome: 'ALREADY_EXECUTED', action };
    if (action.status === 'FAILED' || action.status === 'PENDING') {
      // A previous attempt failed; take the row back and retry against the same key.
      const retaken = await queryOne(
        `UPDATE actions SET status = 'EXECUTING', last_error = NULL, error_class = NULL WHERE id = $1 RETURNING ${COLUMNS}`,
        [action.id],
      );
      return { outcome: 'CLAIMED', action: mapRow<ActionRecord>(retaken) as ActionRecord };
    }
    return { outcome: 'IN_PROGRESS', action };
  }
}

export async function completeAction(
  id: string,
  input: {
    status: ActionStatus;
    remoteActionId?: string | null;
    remoteActionUrl?: string | null;
    verification?: Record<string, unknown> | null;
    contentSignature?: string | null;
    errorClass?: ErrorClass | null;
    lastError?: string | null;
  },
): Promise<ActionRecord> {
  const row = await queryOne(
    `UPDATE actions
        SET status = $2,
            remote_action_id = coalesce($3, remote_action_id),
            remote_action_url = coalesce($4, remote_action_url),
            verification = coalesce($5::jsonb, verification),
            content_signature = coalesce($6, content_signature),
            error_class = $7,
            last_error = $8,
            executed_at = CASE WHEN $2 IN ('EXECUTED','DRY_RUN') THEN now() ELSE executed_at END
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [
      id,
      input.status,
      input.remoteActionId ?? null,
      input.remoteActionUrl ?? null,
      input.verification ? JSON.stringify(input.verification) : null,
      input.contentSignature ?? null,
      input.errorClass ?? null,
      input.lastError ?? null,
    ],
  );
  if (!row) throw new NotFoundError('Action');
  return mapRow<ActionRecord>(row) as ActionRecord;
}

export async function recordActionAttempt(input: {
  actionId: string;
  attempt: number;
  outcome: string;
  errorClass?: string | null;
  error?: string | null;
  diagnosticId?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO action_attempts (action_id, attempt, finished_at, outcome, error_class, error, diagnostic_id)
     VALUES ($1,$2, now(), $3,$4,$5,$6)
     ON CONFLICT (action_id, attempt) DO UPDATE
       SET finished_at = now(), outcome = excluded.outcome, error_class = excluded.error_class,
           error = excluded.error, diagnostic_id = excluded.diagnostic_id`,
    [input.actionId, input.attempt, input.outcome, input.errorClass ?? null, input.error ?? null, input.diagnosticId ?? null],
  );
}

export async function listJobActions(jobId: string): Promise<ActionRecord[]> {
  return mapRows<ActionRecord>(
    await query(`SELECT ${COLUMNS} FROM actions WHERE job_id = $1 ORDER BY created_at`, [jobId]),
  );
}

/** True when this exact text was already executed at this target by this agent. */
export async function contentAlreadySent(agentId: string, contentSignature: string): Promise<boolean> {
  const row = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM actions
      WHERE agent_id = $1 AND content_signature = $2 AND dry_run = false AND status = 'EXECUTED'`,
    [agentId, contentSignature],
  );
  return (row?.count ?? 0) > 0;
}

export async function createApproval(jobId: string, originalOutput: string): Promise<Approval> {
  const row = await queryOne(
    `INSERT INTO approvals (job_id, original_output) VALUES ($1,$2)
     ON CONFLICT (job_id) DO UPDATE SET original_output = excluded.original_output,
       status = 'PENDING', decided_at = NULL, decided_by = NULL, requested_at = now()
     RETURNING *`,
    [jobId, originalOutput],
  );
  return mapRow<Approval>(row) as Approval;
}

export async function decideApproval(input: {
  jobId: string;
  status: 'APPROVED' | 'REJECTED';
  editedOutput?: string | null;
  note?: string | null;
  decidedBy: string | null;
}): Promise<Approval> {
  const row = await queryOne(
    `UPDATE approvals SET status = $2, edited_output = $3, note = $4, decided_by = $5, decided_at = now()
      WHERE job_id = $1 AND status = 'PENDING' RETURNING *`,
    [input.jobId, input.status, input.editedOutput ?? null, input.note ?? null, input.decidedBy],
  );
  if (!row) throw new NotFoundError('Pending approval');
  return mapRow<Approval>(row) as Approval;
}

export async function getApproval(jobId: string): Promise<Approval | null> {
  return mapRow<Approval>(await queryOne('SELECT * FROM approvals WHERE job_id = $1', [jobId]));
}

/**
 * How many times this agent has replied to somebody recently.
 *
 * Counts by the target's handle rather than by conversation, because six
 * replies to one person across six threads is the same behaviour as six in one.
 */
export async function countRecentRepliesToHandle(
  agentId: string,
  handle: string,
  sinceMinutes: number,
): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM actions a
       JOIN jobs j ON j.id = a.job_id
       JOIN events e ON e.id = j.event_id
      WHERE a.agent_id = $1 AND a.dry_run = false AND a.status = 'EXECUTED'
        AND lower(e.remote_author_handle) = lower($2)
        AND a.executed_at > now() - ($3::int * interval '1 minute')`,
    [agentId, handle, sinceMinutes],
  );
  return row?.count ?? 0;
}
