import { PipelineError, sha256Hex } from '@xbam/shared';
import type { ProviderAdapter, ProviderHealth, ProviderRequest, ProviderResponse } from '../types';

const LABEL = 'Mock';

/**
 * Deterministic provider for development and tests. Same input, same output,
 * no network, no cost. Behaviour is steered through the model name:
 *
 *   mock-echo          reply that quotes the incoming message
 *   mock-fixed:TEXT    always returns TEXT
 *   mock-fail          always fails with a retryable error
 *   mock-fail-permanent  always fails permanently
 *   mock-empty         returns whitespace, exercising the empty-output path
 *   mock-long          returns text longer than a typical channel limit
 */
export const mockAdapter: ProviderAdapter = {
  kind: 'mock',
  defaultBaseUrl: 'mock://local',
  requiresApiKey: false,

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const model = request.model;
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

    if (model === 'mock-fail') {
      throw PipelineError.retryable('mock_failure', 'Mock provider was asked to fail (retryable).');
    }
    if (model === 'mock-fail-permanent') {
      throw PipelineError.permanent('mock_failure', 'Mock provider was asked to fail (permanent).');
    }

    let text: string;
    if (model.startsWith('mock-fixed:')) {
      text = model.slice('mock-fixed:'.length);
    } else if (model === 'mock-empty') {
      text = '   ';
    } else if (model === 'mock-long') {
      text = 'This mock reply is deliberately long. '.repeat(20);
    } else {
      // Deterministic: derived only from the incoming message, never random.
      const question = extractIncoming(lastUser);
      const fingerprint = sha256Hex(question).slice(0, 6);
      text = question
        ? `Noted: ${truncateWords(question, 18)} [mock:${fingerprint}]`
        : `Nothing to respond to. [mock:${fingerprint}]`;
    }

    if (!text.trim()) {
      throw PipelineError.retryable('empty_completion', `${LABEL} returned an empty completion.`);
    }
    return {
      text,
      requestId: `mock-${sha256Hex(lastUser + model).slice(0, 12)}`,
      promptTokens: Math.ceil(request.messages.reduce((n, m) => n + m.content.length, 0) / 4),
      completionTokens: Math.ceil(text.length / 4),
      raw: { provider: 'mock', model },
    };
  },

  async health(): Promise<ProviderHealth> {
    return {
      ok: true,
      detail: 'Deterministic local provider',
      models: ['mock-echo', 'mock-fixed:ok', 'mock-fail', 'mock-fail-permanent', 'mock-empty', 'mock-long'],
    };
  },
};

/** Pulls the incoming message out of the rendered IMMEDIATE CONTEXT layer. */
function extractIncoming(userMessage: string): string {
  // Stops at the next all-caps section heading, which is how the rendered
  // prompt layers are separated from one another.
  const match = userMessage.match(/INCOMING MESSAGE:\s*\n([\s\S]*?)(?:\n\s*\n[A-Z][A-Z ]{2,}\s*\n|\s*$)/);
  const raw = (match?.[1] ?? userMessage).trim();
  return raw.replace(/\s+/g, ' ').slice(0, 400);
}

function truncateWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/);
  return words.length <= maxWords ? text : `${words.slice(0, maxWords).join(' ')}...`;
}
