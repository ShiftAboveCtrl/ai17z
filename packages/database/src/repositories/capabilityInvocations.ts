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

/** One capability's path from being on the menu to being used, for one agent over a window. */
export interface CapabilityLifecycleRow {
  capabilityId: string;
  /** Times it was on the shortlist a model was shown. */
  offered: number;
  /** Times the model chose it, including choices the owner's settings refused. */
  selected: number;
  /** Times it actually ran: chosen and not refused. */
  executed: number;
  /** Times it ran and returned a result. */
  returned: number;
  /** Times a result it returned went into a job that went on to publish. */
  used: number;
  lastSelectedAt: string | null;
}

/**
 * Registered is not offered, offered is not selected, selected is not
 * executed, executed is not returned, and returned is not used. Each step is
 * counted from what was recorded when it happened: offers from the trace the
 * capability loop writes, the rest from the invocation rows, and "used" only
 * when the job a successful result fed went on to publish. Anything weaker
 * would be a guess about whether the model relied on it.
 */
export async function lifecycleForAgent(agentId: string, sinceDays = 30): Promise<CapabilityLifecycleRow[]> {
  const offers = await query<{ capability_id: string; n: number }>(
    `SELECT o.id AS capability_id, count(*)::int AS n
       FROM trace_events t, jsonb_array_elements_text(t.data->'offered') AS o(id)
      WHERE t.agent_id = $1 AND t.type = 'CAPABILITY_OFFERED' AND t.at > now() - ($2::int * interval '1 day')
      GROUP BY o.id`,
    [agentId, sinceDays],
  );
  const runs = await query<{ capability_id: string; selected: number; executed: number; returned: number; used: number; last_at: Date | null }>(
    `SELECT ci.capability_id,
            count(*)::int AS selected,
            count(*) FILTER (WHERE ci.outcome <> 'REFUSED')::int AS executed,
            count(*) FILTER (WHERE ci.outcome = 'SUCCEEDED')::int AS returned,
            count(*) FILTER (WHERE ci.outcome = 'SUCCEEDED' AND j.status = 'EXECUTED')::int AS used,
            max(ci.created_at) AS last_at
       FROM capability_invocations ci
       LEFT JOIN jobs j ON j.id = ci.job_id
      WHERE ci.agent_id = $1 AND ci.created_at > now() - ($2::int * interval '1 day')
      GROUP BY ci.capability_id`,
    [agentId, sinceDays],
  );
  const rows = new Map<string, CapabilityLifecycleRow>();
  const row = (id: string) => {
    let r = rows.get(id);
    if (!r) {
      r = { capabilityId: id, offered: 0, selected: 0, executed: 0, returned: 0, used: 0, lastSelectedAt: null };
      rows.set(id, r);
    }
    return r;
  };
  for (const o of offers) row(o.capability_id).offered = o.n;
  for (const r of runs) {
    Object.assign(row(r.capability_id), {
      selected: r.selected,
      executed: r.executed,
      returned: r.returned,
      used: r.used,
      lastSelectedAt: r.last_at ? new Date(r.last_at).toISOString() : null,
    });
  }
  return [...rows.values()].sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
}
