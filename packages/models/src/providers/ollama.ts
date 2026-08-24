import { PipelineError } from '@xbam/shared';
import { postJson } from '../http';
import type { ProviderAdapter, ProviderHealth, ProviderRequest, ProviderResponse } from '../types';

interface OllamaChatResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

const LABEL = 'Ollama';

/** Local models. No API key, and being offline must never fail the whole platform. */
export const ollamaAdapter: ProviderAdapter = {
  kind: 'ollama',
  defaultBaseUrl: 'http://localhost:11434',
  requiresApiKey: false,

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const base = (request.baseUrl || ollamaAdapter.defaultBaseUrl).replace(/\/+$/, '');
    const { data } = await postJson<OllamaChatResponse>({
      url: `${base}/api/chat`,
      providerLabel: LABEL,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      body: {
        model: request.model,
        messages: request.messages,
        stream: false,
        options: {
          temperature: request.parameters.temperature,
          top_p: request.parameters.topP,
          num_predict: request.parameters.maxTokens,
          stop: request.parameters.stop,
        },
      },
    });
    if (data.error) throw PipelineError.permanent('provider_error', `${LABEL}: ${data.error}`);
    const text = data.message?.content ?? '';
    if (!text.trim()) throw PipelineError.retryable('empty_completion', `${LABEL} returned an empty completion.`);
    return {
      text,
      requestId: null,
      promptTokens: data.prompt_eval_count ?? null,
      completionTokens: data.eval_count ?? null,
      raw: data,
    };
  },

  async health(request): Promise<ProviderHealth> {
    const base = (request.baseUrl || ollamaAdapter.defaultBaseUrl).replace(/\/+$/, '');
    try {
      const { data } = await postJson<{ models?: Array<{ name?: string }> }>({
        url: `${base}/api/tags`,
        method: 'GET',
        providerLabel: LABEL,
        timeoutMs: Math.min(request.timeoutMs, 8_000),
      });
      const models = (data.models ?? []).map((m) => m.name).filter((n): n is string => Boolean(n));
      return { ok: true, detail: `${models.length} local models`, models };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  },
};
