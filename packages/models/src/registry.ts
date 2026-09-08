import { PROVIDER_CATALOGUE, type ProviderKind } from '@xbam/shared/contracts';
import { BadRequestError } from '@xbam/shared';
import { anthropicAdapter } from './providers/anthropic';
import { ollamaAdapter } from './providers/ollama';
import { mockAdapter } from './providers/mock';
import { animalAdapter } from './providers/animal';
import { createOpenAiCompatibleAdapter } from './providers/openaiCompatible';
import { xaiAdapter } from './providers/xai';
import type { ProviderAdapter } from './types';

/**
 * A provider's endpoint and display name, from the one place that owns them.
 *
 * Both were written out here as literals and again in the catalogue every
 * screen reads, which is two places to change and one to forget.
 */
const base = (kind: ProviderKind) => PROVIDER_CATALOGUE[kind].defaultBaseUrl;
const title = (kind: ProviderKind) => PROVIDER_CATALOGUE[kind].label;

const ADAPTERS: Record<ProviderKind, ProviderAdapter> = {
  openai: createOpenAiCompatibleAdapter('openai', base('openai'), title('openai')),
  openrouter: createOpenAiCompatibleAdapter('openrouter', base('openrouter'), title('openrouter'), {
    'x-title': 'XBAM',
  }),
  deepseek: createOpenAiCompatibleAdapter('deepseek', base('deepseek'), title('deepseek')),
  // Generation is the OpenAI chat-completions shape, verified against
  // docs.x.ai. The separate adapter exists for the half that is not shared:
  // search xAI runs on its own side, during the call, with citations.
  xai: xaiAdapter,
  // Google's OpenAI-compatible endpoint: same Bearer key, same
  // chat-completions shape, same GET /models. The native
  // :generateContent API is a different shape and is not used.
  google: createOpenAiCompatibleAdapter('google', base('google'), title('google')),
  openai_compatible: createOpenAiCompatibleAdapter(
    'openai_compatible',
    base('openai_compatible'),
    title('openai_compatible'),
  ),
  anthropic: anthropicAdapter,
  ollama: ollamaAdapter,
  mock: mockAdapter,
  animal: animalAdapter,
};

export function getAdapter(kind: ProviderKind): ProviderAdapter {
  const adapter = ADAPTERS[kind];
  if (!adapter) throw new BadRequestError(`Unknown model provider: ${kind}`);
  return adapter;
}

export function listAdapters(): ProviderAdapter[] {
  return Object.values(ADAPTERS);
}
