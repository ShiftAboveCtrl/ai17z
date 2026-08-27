import { describe, expect, it } from 'vitest';
import { PROVIDER_KINDS } from '@xbam/shared/contracts';
import { getAdapter, listAdapters } from '@xbam/models';

/**
 * Every provider the UI can offer must resolve to a real adapter with sensible
 * defaults. A name in a dropdown that has no working implementation behind it is
 * the exact failure this project is meant to avoid.
 */
describe('provider registry', () => {
  it('has an adapter for every declared provider kind', () => {
    for (const kind of PROVIDER_KINDS) {
      expect(() => getAdapter(kind), kind).not.toThrow();
    }
  });

  it('offers the providers the product promises', () => {
    const kinds = listAdapters().map((a) => a.kind).sort();
    expect(kinds).toEqual(
      ['anthropic', 'deepseek', 'mock', 'ollama', 'openai', 'openai_compatible', 'openrouter'].sort(),
    );
  });

  it('gives every keyed provider a usable default base URL', () => {
    for (const adapter of listAdapters()) {
      if (adapter.kind === 'openai_compatible') {
        // The generic adapter has no default on purpose: the URL is the point.
        expect(adapter.defaultBaseUrl).toBe('');
        continue;
      }
      expect(adapter.defaultBaseUrl, adapter.kind).toMatch(/^(https?:\/\/|mock:\/\/)/);
    }
  });

  it('points DeepSeek at its own API rather than making the owner remember it', () => {
    const deepseek = getAdapter('deepseek');
    expect(deepseek.defaultBaseUrl).toBe('https://api.deepseek.com/v1');
    expect(deepseek.requiresApiKey).toBe(true);
  });

  it('marks only the local and mock providers as keyless', () => {
    const keyless = listAdapters().filter((a) => !a.requiresApiKey).map((a) => a.kind).sort();
    expect(keyless).toEqual(['mock', 'ollama']);
  });

  it('rejects an unknown provider with a message naming it', () => {
    expect(() => getAdapter('not-a-provider' as never)).toThrow(/not-a-provider/);
  });
});
