import type { ProviderKind } from '@xbam/shared/contracts';
import { BadRequestError } from '@xbam/shared';
import { anthropicAdapter } from './providers/anthropic';
import { ollamaAdapter } from './providers/ollama';
import { mockAdapter } from './providers/mock';
import { createOpenAiCompatibleAdapter } from './providers/openaiCompatible';
import type { ProviderAdapter } from './types';

const ADAPTERS: Record<ProviderKind, ProviderAdapter> = {
  openai: createOpenAiCompatibleAdapter('openai', 'https://api.openai.com/v1', 'OpenAI'),
  openrouter: createOpenAiCompatibleAdapter('openrouter', 'https://openrouter.ai/api/v1', 'OpenRouter', {
    'x-title': 'XBAM',
  }),
  deepseek: createOpenAiCompatibleAdapter('deepseek', 'https://api.deepseek.com/v1', 'DeepSeek'),
  // Verified against docs.x.ai: POST /v1/chat/completions, Bearer key, the
  // OpenAI request and response shape. No separate adapter needed.
  xai: createOpenAiCompatibleAdapter('xai', 'https://api.x.ai/v1', 'xAI'),
  openai_compatible: createOpenAiCompatibleAdapter('openai_compatible', '', 'OpenAI-compatible endpoint'),
  anthropic: anthropicAdapter,
  ollama: ollamaAdapter,
  mock: mockAdapter,
};

export function getAdapter(kind: ProviderKind): ProviderAdapter {
  const adapter = ADAPTERS[kind];
  if (!adapter) throw new BadRequestError(`Unknown model provider: ${kind}`);
  return adapter;
}

export function listAdapters(): ProviderAdapter[] {
  return Object.values(ADAPTERS);
}
