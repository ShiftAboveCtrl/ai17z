import { PipelineError } from '@xbam/shared';
import { postJson } from '../http';
import type { ProviderAdapter, ProviderHealth, ProviderRequest, ProviderResponse } from '../types';

interface AnthropicResponse {
  id?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
  stop_reason?: string;
}

const LABEL = 'Anthropic';

/** Anthropic separates the system prompt from the message array, so we split it here. */
export const anthropicAdapter: ProviderAdapter = {
  kind: 'anthropic',
  defaultBaseUrl: 'https://api.anthropic.com/v1',
  requiresApiKey: true,

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const base = (request.baseUrl || anthropicAdapter.defaultBaseUrl).replace(/\/+$/, '');
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const messages = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        // Content blocks are only needed when there are images; a plain string
        // is the simpler and equally valid form otherwise.
        content:
          m.images && m.images.length > 0
            ? [
                { type: 'text', text: m.content },
                ...m.images.map((image) => ({
                  type: 'image',
                  // A remote URL is the only form available here: AI17Z does not
                  // download social media assets unless retention says to.
                  source: { type: 'url', url: image.url },
                })),
              ]
            : m.content,
      }));

    const { data, headers } = await postJson<AnthropicResponse>({
      url: `${base}/messages`,
      headers: {
        'x-api-key': request.apiKey ?? '',
        'anthropic-version': '2023-06-01',
      },
      providerLabel: LABEL,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      body: {
        model: request.model,
        system: system || undefined,
        messages: messages.length > 0 ? messages : [{ role: 'user', content: '(no content)' }],
        max_tokens: request.parameters.maxTokens ?? 1024,
        temperature: request.parameters.temperature,
        top_p: request.parameters.topP,
        stop_sequences: request.parameters.stop,
      },
    });

    if (data.error?.message) throw PipelineError.permanent('provider_error', `${LABEL}: ${data.error.message}`);
    const text = (data.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
    if (!text.trim()) {
      throw PipelineError.retryable('empty_completion', `${LABEL} returned an empty completion.`, {
        stopReason: data.stop_reason ?? null,
      });
    }
    return {
      text,
      requestId: data.id ?? headers.get('request-id'),
      promptTokens: data.usage?.input_tokens ?? null,
      completionTokens: data.usage?.output_tokens ?? null,
      raw: data,
    };
  },

  async health(request): Promise<ProviderHealth> {
    const base = (request.baseUrl || anthropicAdapter.defaultBaseUrl).replace(/\/+$/, '');
    try {
      const { data } = await postJson<{ data?: Array<{ id?: string }> }>({
        url: `${base}/models`,
        method: 'GET',
        headers: { 'x-api-key': request.apiKey ?? '', 'anthropic-version': '2023-06-01' },
        providerLabel: LABEL,
        timeoutMs: Math.min(request.timeoutMs, 15_000),
      });
      const models = (data.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
      return { ok: true, detail: `${models.length} models available`, models };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  },
};
