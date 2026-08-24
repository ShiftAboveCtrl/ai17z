import type { ModelCallRecord, PromptLayer, TraceEvent, TraceEventType } from '@xbam/shared/contracts';
import { createLogger, redact } from '@xbam/shared';
import { query, queryOne } from '../pool';
import { mapRow, mapRows } from '../mapper';

const log = createLogger('trace');

const MODEL_CALL_COLUMNS = `
  id, job_id, agent_id, provider_credential_id, purpose, provider, model, model_role, attempt,
  status, parameters, prompt_layers, prompt_text, raw_output, request_id, latency_ms,
  prompt_tokens, completion_tokens, estimated_cost_usd, error_class, error, created_at, completed_at`;

export async function startModelCall(input: {
  jobId: string | null;
  agentId: string | null;
  providerCredentialId: string | null;
  purpose: string;
  provider: string;
  model: string;
  modelRole: string | null;
  attempt: number;
  parameters: Record<string, unknown>;
  promptLayers: PromptLayer[] | null;
  promptText: string | null;
}): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO model_calls (job_id, agent_id, provider_credential_id, purpose, provider, model,
       model_role, attempt, parameters, prompt_layers, prompt_text, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,'STARTED') RETURNING id`,
    [
      input.jobId,
      input.agentId,
      input.providerCredentialId,
      input.purpose,
      input.provider,
      input.model,
      input.modelRole,
      input.attempt,
      JSON.stringify(input.parameters),
      input.promptLayers ? JSON.stringify(input.promptLayers) : null,
      input.promptText,
    ],
  );
  return row!.id;
}

export async function finishModelCall(
  id: string,
  input: {
    status: 'COMPLETED' | 'FAILED';
    rawOutput?: string | null;
    requestId?: string | null;
    latencyMs?: number | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    estimatedCostUsd?: number | null;
    errorClass?: string | null;
    error?: string | null;
  },
): Promise<void> {
  await query(
    `UPDATE model_calls SET status = $2, raw_output = $3, request_id = $4, latency_ms = $5,
       prompt_tokens = $6, completion_tokens = $7, estimated_cost_usd = $8,
       error_class = $9, error = $10, completed_at = now()
     WHERE id = $1`,
    [
      id,
      input.status,
      input.rawOutput ?? null,
      input.requestId ?? null,
      input.latencyMs ?? null,
      input.promptTokens ?? null,
      input.completionTokens ?? null,
      input.estimatedCostUsd ?? null,
      input.errorClass ?? null,
      input.error ?? null,
    ],
  );
}

export async function listModelCalls(jobId: string): Promise<ModelCallRecord[]> {
  return mapRows<ModelCallRecord>(
    await query(`SELECT ${MODEL_CALL_COLUMNS} FROM model_calls WHERE job_id = $1 ORDER BY created_at`, [jobId]),
  );
}

export async function getModelCall(id: string): Promise<ModelCallRecord | null> {
  return mapRow<ModelCallRecord>(await queryOne(`SELECT ${MODEL_CALL_COLUMNS} FROM model_calls WHERE id = $1`, [id]));
}

export async function spendToday(agentId: string): Promise<number> {
  const row = await queryOne<{ total: number | null }>(
    `SELECT coalesce(sum(estimated_cost_usd), 0) AS total FROM model_calls
      WHERE agent_id = $1 AND created_at > date_trunc('day', now())`,
    [agentId],
  );
  return Number(row?.total ?? 0);
}

/**
 * Structured trace. Every significant runtime step writes one of these against a
 * job id, which is what makes "why did the agent do that" answerable after the fact.
 */
export async function emitTrace(input: {
  jobId: string | null;
  agentId: string | null;
  type: TraceEventType;
  level?: 'debug' | 'info' | 'warn' | 'error';
  message?: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  try {
    await query('INSERT INTO trace_events (job_id, agent_id, type, level, message, data) VALUES ($1,$2,$3,$4,$5,$6::jsonb)', [
      input.jobId,
      input.agentId,
      input.type,
      input.level ?? 'info',
      input.message ?? '',
      JSON.stringify(redact(input.data ?? {})),
    ]);
  } catch (error) {
    // Trace writes must never take down the pipeline, but a failure to record one
    // is itself a problem worth surfacing, so it is logged rather than swallowed.
    log.error('failed to write trace event', { type: input.type, message: (error as Error).message });
  }
}

export async function listTrace(jobId: string): Promise<TraceEvent[]> {
  return mapRows<TraceEvent>(
    await query('SELECT id::text, job_id, agent_id, type, level, message, data, at FROM trace_events WHERE job_id = $1 ORDER BY id', [
      jobId,
    ]),
  );
}

export async function listAgentTrace(agentId: string, limit = 100): Promise<TraceEvent[]> {
  return mapRows<TraceEvent>(
    await query(
      'SELECT id::text, job_id, agent_id, type, level, message, data, at FROM trace_events WHERE agent_id = $1 ORDER BY id DESC LIMIT $2',
      [agentId, limit],
    ),
  );
}
