import { PipelineError } from '@xbam/shared';
import type { ProviderKind } from '@xbam/shared/contracts';
import { postJson } from '../http';
import type { ProviderAdapter, ProviderHealth, ProviderRequest, ProviderResponse } from '../types';
import type { ChatMessage } from '@xbam/shared/contracts';

interface ChatCompletionResponse {
  id?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      /**
       * Where a reasoning model puts its thinking. DeepSeek, and now several
       * others, return the visible answer in `content` and the working in
       * `reasoning_content` -- and both are charged against `max_tokens`.
       */
      reasoning_content?: string | null;
    };
    finish_reason?: string;
  }>;
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

  /**
   * The OpenAI chat format carries images as content parts rather than as a
   * plain string. A message with no images keeps the string form, because some
   * compatible endpoints only accept that.
   */
  function toWireMessage(message: ChatMessage): Record<string, unknown> {
    if (!message.images || message.images.length === 0) {
      return { role: message.role, content: message.content };
    }
    return {
      role: message.role,
      content: [
        { type: 'text', text: message.content },
        ...message.images.map((image) => ({ type: 'image_url', image_url: { url: image.url } })),
      ],
    };
  }

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
          messages: request.messages.map(toWireMessage),
          temperature: request.parameters.temperature,
          top_p: request.parameters.topP,
          max_tokens: request.parameters.maxTokens,
          frequency_penalty: request.parameters.frequencyPenalty,
          presence_penalty: request.parameters.presencePenalty,
          stop: request.parameters.stop,
          // Reasoning models read this; the rest ignore an unknown field.
          ...(request.parameters.reasoningEffort ? { reasoning_effort: request.parameters.reasoningEffort } : {}),
        },
      });

      if (data.error?.message) {
        throw PipelineError.permanent('provider_error', `${label}: ${data.error.message}`);
      }
      const choice = data.choices?.[0];
      const text = choice?.message?.content ?? '';
      if (!text.trim()) {
        // Empty, but not necessarily silent.
        //
        // A reasoning model charges its thinking to the same budget as its
        // answer, so a ceiling set for the answer alone gets spent before the
        // answer starts. `deepseek-v4-flash-vision-exp` read an image
        // perfectly, wrote four hundred tokens of correct analysis into
        // `reasoning_content`, hit the cap, and returned `content: ""`. The
        // report said "returned an empty completion", which is true and sends
        // whoever reads it looking in exactly the wrong place.
        const thinking = (choice?.message?.reasoning_content ?? '').trim();
        const ranOut = choice?.finish_reason === 'length';
        const detail =
          thinking && ranOut
            ? `${label} spent its whole token budget thinking and never began the answer. Raise max tokens for this role.`
            : thinking
              ? `${label} returned reasoning but no answer.`
              : `${label} returned an empty completion.`;
        throw PipelineError.retryable('empty_completion', detail, {
          finishReason: choice?.finish_reason ?? null,
          reasoningChars: thinking.length,
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
