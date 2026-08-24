import { PipelineError } from '@xbam/shared';
import type { ProviderKind } from '@xbam/shared/contracts';
import { postJson } from '../http';
import type { ProviderAdapter, ProviderHealth, ProviderRequest, ProviderResponse } from '../types';

interface ChatCompletionResponse {
  id?: string;
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

interface ModelListResponse {
  data?: Array<{ id?: string }>;
}

/**
 * The OpenAI chat-completions shape, which OpenAI, OpenRouter, and most
 * self-hosted gateways all speak. One implementation, three registered kinds.
 */
export function createOpenAiCompatibleAdapter(
  kind: ProviderKind,
  defaultBaseUrl: string,
  label: string,
  extraHeaders: Record<string, string> = {},
): ProviderAdapter {
  const buildHeaders = (apiKey: string | null): Record<string, string> => ({
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...extraHeaders,
  });

  return {
    kind,
    defaultBaseUrl,
    requiresApiKey: true,

    async generate(request: ProviderRequest): Promise<ProviderResponse> {
      const base = (request.baseUrl || defaultBaseUrl).replace(/\/+$/, '');
      const { data, headers } = await postJson<ChatCompletionResponse>({
        url: `${base}/chat/completions`,
        headers: buildHeaders(request.apiKey),
        providerLabel: label,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
        body: {
          model: request.model,
          messages: request.messages,
          temperature: request.parameters.temperature,
          top_p: request.parameters.topP,
          max_tokens: request.parameters.maxTokens,
          frequency_penalty: request.parameters.frequencyPenalty,
          presence_penalty: request.parameters.presencePenalty,
          stop: request.parameters.stop,
        },
      });

      if (data.error?.message) {
        throw PipelineError.permanent('provider_error', `${label}: ${data.error.message}`);
      }
      const text = data.choices?.[0]?.message?.content ?? '';
      if (!text.trim()) {
        // An empty completion is a real failure, not something to quietly drop.
        throw PipelineError.retryable('empty_completion', `${label} returned an empty completion.`, {
          finishReason: data.choices?.[0]?.finish_reason ?? null,
        });
      }
      return {
        text,
        requestId: data.id ?? headers.get('x-request-id'),
        promptTokens: data.usage?.prompt_tokens ?? null,
        completionTokens: data.usage?.completion_tokens ?? null,
        raw: data,
      };
    },

    async health(request): Promise<ProviderHealth> {
      const base = (request.baseUrl || defaultBaseUrl).replace(/\/+$/, '');
      try {
        const { data } = await postJson<ModelListResponse>({
          url: `${base}/models`,
          method: 'GET',
          headers: buildHeaders(request.apiKey),
          providerLabel: label,
          timeoutMs: Math.min(request.timeoutMs, 15_000),
        });
        const models = (data.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
        return { ok: true, detail: `${models.length} models available`, models };
      } catch (error) {
        return { ok: false, detail: (error as Error).message };
      }
    },
  };
}
