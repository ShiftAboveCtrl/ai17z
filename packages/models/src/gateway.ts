import type { ChatMessage, ModelParameters, ModelRole, PromptLayer } from '@xbam/shared/contracts';
import { PipelineError, createLogger, errorMessage, isPipelineError } from '@xbam/shared';
import { observability, providers as providersRepo } from '@xbam/database';
import { getAdapter } from './registry';

const log = createLogger('model-gateway');

/** Roles are attempted in this order; the first success wins. */
const FALLBACK_ORDER: ModelRole[] = ['primary', 'fallback_1', 'fallback_2'];

export interface GenerateRequest {
  agentId: string;
  jobId: string | null;
  purpose: string;
  messages: ChatMessage[];
  promptLayers?: PromptLayer[] | null;
  promptText?: string | null;
  /** Hard ceiling on provider calls for this request, from the budget policy. */
  maxCalls: number;
  /** Use this single role instead of walking the fallback chain. */
  role?: ModelRole;
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  provider: string;
  model: string;
  role: ModelRole;
  modelCallId: string;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
  attempts: number;
}

interface ResolvedTarget {
  role: ModelRole;
  providerCredentialId: string;
  provider: string;
  model: string;
  parameters: ModelParameters & { costPer1kPromptUsd?: number; costPer1kCompletionUsd?: number };
  baseUrl: string | null;
  timeoutMs: number;
}

export async function resolveTargets(agentId: string, only?: ModelRole): Promise<ResolvedTarget[]> {
  const configs = await providersRepo.listModelConfigs(agentId);
  const order = only ? [only] : FALLBACK_ORDER;
  const targets: ResolvedTarget[] = [];
  for (const role of order) {
    const config = configs.find((c) => c.role === role);
    if (!config) continue;
    const credential = await providersRepo.getProvider(config.providerCredentialId);
    if (!credential || !credential.enabled) continue;
    targets.push({
      role,
      providerCredentialId: config.providerCredentialId,
      provider: credential.provider,
      model: config.model,
      parameters: config.parameters as ResolvedTarget['parameters'],
      baseUrl: credential.baseUrl,
      timeoutMs: credential.timeoutMs,
    });
  }
  return targets;
}

function estimateCost(
  target: ResolvedTarget,
  promptTokens: number | null,
  completionTokens: number | null,
): number | null {
  const inRate = target.parameters.costPer1kPromptUsd;
  const outRate = target.parameters.costPer1kCompletionUsd;
  // Cost is only reported when the operator configured real rates. Guessing a
  // price per model would be worse than showing nothing.
  if (inRate === undefined && outRate === undefined) return null;
  const inCost = ((promptTokens ?? 0) / 1000) * (inRate ?? 0);
  const outCost = ((completionTokens ?? 0) / 1000) * (outRate ?? 0);
  return Number((inCost + outCost).toFixed(6));
}

/**
 * Calls the agent models in fallback order, persisting a `model_calls` row before
 * and after every attempt. A provider outage therefore costs a job nothing: the
 * attempt is on record and the next role or the next retry picks it up.
 */
export async function generate(request: GenerateRequest): Promise<GenerateResult> {
  const targets = await resolveTargets(request.agentId, request.role);
  if (targets.length === 0) {
    throw PipelineError.permanent(
      'no_model_configured',
      'This agent has no usable model configured. Add a model provider and set a primary model.',
    );
  }

  let calls = 0;
  let lastError: PipelineError | null = null;

  for (const target of targets) {
    // Two attempts per provider: one immediate retry absorbs a transient blip
    // without waiting for the job-level backoff.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (calls >= request.maxCalls) {
        throw (
          lastError ??
          PipelineError.retryable('model_budget_exhausted', `Model call budget (${request.maxCalls}) exhausted.`)
        );
      }
      calls += 1;

      const adapter = getAdapter(target.provider as never);
      const apiKey = await providersRepo.getDecryptedApiKey(target.providerCredentialId);
      if (adapter.requiresApiKey && !apiKey) {
        lastError = PipelineError.permanent(
          'missing_api_key',
          `Provider "${target.provider}" has no API key stored. Add one in Settings, Providers.`,
        );
        break;
      }

      const modelCallId = await observability.startModelCall({
        jobId: request.jobId,
        agentId: request.agentId,
        providerCredentialId: target.providerCredentialId,
        purpose: request.purpose,
        provider: target.provider,
        model: target.model,
        modelRole: target.role,
        attempt,
        parameters: target.parameters as Record<string, unknown>,
        promptLayers: request.promptLayers ?? null,
        promptText: request.promptText ?? null,
      });
      await observability.emitTrace({
        jobId: request.jobId,
        agentId: request.agentId,
        type: 'MODEL_REQUEST_STARTED',
        message: `${target.provider} / ${target.model} (${target.role}, attempt ${attempt})`,
        data: { modelCallId, role: target.role, provider: target.provider, model: target.model },
      });

      const startedAt = Date.now();
      try {
        const response = await adapter.generate({
          baseUrl: target.baseUrl,
          apiKey,
          model: target.model,
          messages: request.messages,
          parameters: target.parameters,
          timeoutMs: target.timeoutMs,
          signal: request.signal,
        });
        const latencyMs = Date.now() - startedAt;
        await observability.finishModelCall(modelCallId, {
          status: 'COMPLETED',
          rawOutput: response.text,
          requestId: response.requestId,
          latencyMs,
          promptTokens: response.promptTokens,
          completionTokens: response.completionTokens,
          estimatedCostUsd: estimateCost(target, response.promptTokens, response.completionTokens),
        });
        await observability.emitTrace({
          jobId: request.jobId,
          agentId: request.agentId,
          type: 'MODEL_REQUEST_COMPLETED',
          message: `${target.provider} / ${target.model} responded in ${latencyMs}ms`,
          data: { modelCallId, latencyMs, chars: response.text.length },
        });
        return {
          text: response.text,
          provider: target.provider,
          model: target.model,
          role: target.role,
          modelCallId,
          promptTokens: response.promptTokens,
          completionTokens: response.completionTokens,
          latencyMs,
          attempts: calls,
        };
      } catch (error) {
        const pipelineError = isPipelineError(error)
          ? error
          : PipelineError.retryable('provider_exception', errorMessage(error), {}, error);
        lastError = pipelineError;
        await observability.finishModelCall(modelCallId, {
          status: 'FAILED',
          latencyMs: Date.now() - startedAt,
          errorClass: pipelineError.errorClass,
          error: pipelineError.message,
        });
        await observability.emitTrace({
          jobId: request.jobId,
          agentId: request.agentId,
          type: 'MODEL_REQUEST_FAILED',
          level: 'warn',
          message: pipelineError.message,
          data: { modelCallId, role: target.role, reason: pipelineError.reason, errorClass: pipelineError.errorClass },
        });
        log.warn('model attempt failed', {
          role: target.role,
          provider: target.provider,
          reason: pipelineError.reason,
        });
        // A permanent error will not improve on a second attempt; move to the
        // next configured role instead of burning the budget.
        if (pipelineError.errorClass === 'PERMANENT') break;
      }
    }
  }

  throw lastError ?? PipelineError.retryable('model_unavailable', 'No model provider produced a response.');
}

export interface ConnectionTestResult {
  ok: boolean;
  detail: string;
  models: string[];
}

/** Used by the Test Connection button. Never returns or logs the key itself. */
export async function testProviderConnection(providerCredentialId: string): Promise<ConnectionTestResult> {
  const credential = await providersRepo.requireProvider(providerCredentialId);
  const adapter = getAdapter(credential.provider);
  const apiKey = await providersRepo.getDecryptedApiKey(providerCredentialId);
  if (adapter.requiresApiKey && !apiKey) {
    return { ok: false, detail: 'No API key stored for this provider.', models: [] };
  }
  const health = await adapter.health({
    baseUrl: credential.baseUrl,
    apiKey,
    timeoutMs: credential.timeoutMs,
  });
  await providersRepo.updateProvider(providerCredentialId, {
    lastStatus: health.ok ? 'healthy' : `error: ${health.detail}`.slice(0, 400),
    touchChecked: true,
    ...(health.ok && health.models?.length ? { availableModels: health.models.slice(0, 500) } : {}),
  });
  return { ok: health.ok, detail: health.detail, models: health.models ?? [] };
}
