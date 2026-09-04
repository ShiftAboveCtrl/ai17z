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
  | { outcome: 'CLAIMED'; action: ActionRecord; retakenFromStale?: boolean }
  | { outcome: 'ALREADY_EXECUTED'; action: ActionRecord }
  | { outcome: 'IN_PROGRESS'; action: ActionRecord };

/**
 * How long an action may sit EXECUTING before it is assumed abandoned.
 *
 * Longer than any real action: a reply is seconds, and the browser timeouts
 * around it are tens of seconds. Ten minutes means the worker is gone.
 *
 * Retaking is not the same as re-sending. A worker can die after X accepted the
 * reply and before the row was updated, so a retaken action is checked against
 * the remote before it is performed again — see `wasAlreadyDone` on the channel
 * adapter. Without that check this would be a duplicate-post machine.
 */
const STALE_EXECUTING_MS = 10 * 60_000;

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

    // An action left EXECUTING by a worker that died. Nothing recovered these,
    // so one interrupted reply made its job permanently unrunnable: every later
    // attempt was told another worker was already on it, forever.
    if (action.status === 'EXECUTING') {
      const stale = await queryOne(
        `UPDATE actions
            SET last_error = NULL, error_class = NULL
          WHERE id = $1
            AND status = 'EXECUTING'
            AND updated_at < now() - ($2::int * interval '1 millisecond')
        RETURNING ${COLUMNS}`,
        [action.id, STALE_EXECUTING_MS],
      );
      if (stale) {
        return {
          outcome: 'CLAIMED',
          action: mapRow<ActionRecord>(stale) as ActionRecord,
          // The caller must check the remote before acting. This flag is the
          // difference between recovering an action and sending it twice.
          retakenFromStale: true,
        };
      }
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

/**
 * Closes off an action whose job has stopped for good.
 *
 * A job that goes to review or fails permanently used to leave its action row
 * saying EXECUTING, which is untrue in two ways: nothing is executing, and the
 * UI shows a job parked for a person next to an action that claims to be in
 * flight. It also makes the next claim on that key report "another worker is
 * already on it" until the stale window passes.
 *
 * Marked FAILED rather than deleted. Whether the reply reached X is exactly
 * what a person coming to this job needs to decide, and the row is the evidence.
 */
export async function failInFlightForJob(jobId: string, message: string): Promise<number> {
  const rows = await query(
    `UPDATE actions SET status = 'FAILED', error_class = 'REVIEW_REQUIRED', last_error = $2
      WHERE job_id = $1 AND status = 'EXECUTING'
      RETURNING id`,
    [jobId, message],
  );
  return rows.length;
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

/**
 * Unprompted approaches this agent has actually made.
 *
 * Counted from what was published, not from what was decided or drafted: a
 * dry run said nothing to anybody, and a job that was cancelled approached
 * nobody. The same rule as stances and relationships, and for the same reason.
 *
 * An approach is identified by the event that produced it -- KEYWORD_MATCH is
 * what the radar assigns to a post found by watching rather than by being
 * addressed -- so this needs no column of its own and cannot drift from what
 * the engagement step calls unprompted.
 */
export async function approachesSince(agentId: string, sinceIso: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM actions a
       JOIN jobs j ON j.id = a.job_id
       JOIN events e ON e.id = j.event_id
      WHERE a.agent_id = $1
        AND a.dry_run = false
        AND a.status = 'EXECUTED'
        AND e.type = 'KEYWORD_MATCH'
        AND a.executed_at >= $2`,
    [agentId, sinceIso],
  );
  return row?.n ?? 0;
}

/** When this agent last approached a given person unasked, if it ever has. */
export async function lastApproachTo(agentId: string, handle: string): Promise<string | null> {
  const row = await queryOne<{ executed_at: string }>(
    `SELECT a.executed_at
       FROM actions a
       JOIN jobs j ON j.id = a.job_id
       JOIN events e ON e.id = j.event_id
      WHERE a.agent_id = $1
        AND a.dry_run = false
        AND a.status = 'EXECUTED'
        AND e.type = 'KEYWORD_MATCH'
        AND lower(e.remote_author_handle) = lower($2)
      ORDER BY a.executed_at DESC
      LIMIT 1`,
    [agentId, handle.replace(/^@+/, '')],
  );
  return row?.executed_at ?? null;
}
