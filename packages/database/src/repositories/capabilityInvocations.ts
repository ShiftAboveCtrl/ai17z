import type { InvocationOutcome } from '@xbam/shared/contracts';
import { query } from '../pool';

/**
 * What an agent did with its capabilities.
 *
 * Separate from `capabilities.ts`, which is about `agent_account_capabilities`
 * -- what an agent is permitted to do on a channel. Two things called
 * capability in one product is one too many, so the names here are always the
 * long ones.
 */
export interface CapabilityInvocationRow {
  id: string;
  agentId: string;
  jobId: string | null;
  accountId: string | null;
  capabilityId: string;
  step: number;
  outcome: InvocationOutcome;
  detail: string;
  input: unknown;
  output: unknown;
  durationMs: number;
  createdAt: string;
}

interface Raw extends Record<string, unknown> {
  id: string;
  agent_id: string;
  job_id: string | null;
  account_id: string | null;
  capability_id: string;
  step: number;
  outcome: InvocationOutcome;
  detail: string;
  input: unknown;
  output: unknown;
  duration_ms: number;
  created_at: string;
}

const shape = (row: Raw): CapabilityInvocationRow => ({
  id: row.id,
  agentId: row.agent_id,
  jobId: row.job_id,
  accountId: row.account_id,
  capabilityId: row.capability_id,
  step: row.step,
  outcome: row.outcome,
  detail: row.detail,
  input: row.input,
  output: row.output,
  durationMs: row.duration_ms,
  createdAt: row.created_at,
});

export interface RecordInvocation {
  agentId: string;
  jobId: string | null;
  accountId: string | null;
  capabilityId: string;
  step: number;
  outcome: InvocationOutcome;
  detail: string;
  input: unknown;
  output: unknown;
  durationMs: number;
}

/**
 * Records one invocation.
 *
 * Every outcome is recorded, including a refusal. A capability the owner
 * switched off and the model kept asking for is exactly the kind of thing worth
 * seeing, and a table that only holds successes answers no question anybody has
 * when something went wrong.
 */
export async function recordInvocation(input: RecordInvocation): Promise<CapabilityInvocationRow> {
  const rows = await query<Raw>(
    `INSERT INTO capability_invocations
       (agent_id, job_id, account_id, capability_id, step, outcome, detail, input, output, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)
     RETURNING *`,
    [
      input.agentId,
      input.jobId,
      input.accountId,
      input.capabilityId,
      input.step,
      input.outcome,
      input.detail,
      JSON.stringify(input.input ?? {}),
      input.output === null || input.output === undefined ? null : JSON.stringify(input.output),
      input.durationMs,
    ],
  );
  return shape(rows[0]!);
}

/** Everything one job did, oldest first, which is the order it happened in. */
export async function listForJob(jobId: string): Promise<CapabilityInvocationRow[]> {
  const rows = await query<Raw>(
    `SELECT * FROM capability_invocations WHERE job_id = $1 ORDER BY created_at, step`,
    [jobId],
  );
  return rows.map(shape);
}

/** The agent's recent use, newest first, for the owner's screen. */
export async function listForAgent(agentId: string, limit = 50): Promise<CapabilityInvocationRow[]> {
  const rows = await query<Raw>(
    `SELECT * FROM capability_invocations WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [agentId, Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map(shape);
}

/**
 * How many times an agent used a capability inside a rolling window.
 *
 * The count a limit is checked against. Refusals are excluded: an attempt the
 * owner's own settings stopped is not use of the capability, and counting it
 * would let a model exhaust a budget by asking for something it may not have.
 */
export async function countRecent(agentId: string, capabilityId: string, sinceMs: number): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM capability_invocations
      WHERE agent_id = $1
        AND capability_id = $2
        AND outcome <> 'REFUSED'
        AND created_at > now() - make_interval(secs => $3)`,
    [agentId, capabilityId, Math.max(1, Math.round(sinceMs / 1000))],
  );
  return Number(rows[0]?.n ?? 0);
}
