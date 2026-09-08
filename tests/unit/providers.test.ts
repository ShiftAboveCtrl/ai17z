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
      [
        'anthropic',
        'deepseek',
        'google',
        'mock',
        'ollama',
        'openai',
        'openai_compatible',
        'openrouter',
        'xai',
        // Animal mode. A real provider kind rather than a switch in the
        // pipeline, so it is listed here with the rest of them.
        'animal',
      ].sort(),
    );
  });

  it('gives every keyed provider a usable default base URL', () => {
    for (const adapter of listAdapters()) {
      if (adapter.kind === 'openai_compatible') {
        // The generic adapter has no default on purpose: the URL is the point.
        expect(adapter.defaultBaseUrl).toBe('');
        continue;
      }
      // `mock://` and `animal://` are the two that answer without a network.
      // The check is that every adapter names *somewhere*, so a missing default
      // shows up here rather than as a request to an empty URL.
      expect(adapter.defaultBaseUrl, adapter.kind).toMatch(/^(https?:\/\/|mock:\/\/|animal:\/\/)/);
    }
  });

  it('points DeepSeek at its own API rather than making the owner remember it', () => {
    const deepseek = getAdapter('deepseek');
    expect(deepseek.defaultBaseUrl).toBe('https://api.deepseek.com/v1');
    expect(deepseek.requiresApiKey).toBe(true);
  });

  it('marks only the providers that genuinely need no account as keyless', () => {
    // Ollama runs on this machine, mock answers from a hash, and animal mode
    // answers from a list of noises. Everything else bills somebody, and a
    // provider that slipped into this list would be one the UI stops asking a
    // key for -- which fails at the first generation instead of at setup.
    const keyless = listAdapters().filter((a) => !a.requiresApiKey).map((a) => a.kind).sort();
    expect(keyless).toEqual(['animal', 'mock', 'ollama']);
  });

  it('rejects an unknown provider with a message naming it', () => {
    expect(() => getAdapter('not-a-provider' as never)).toThrow(/not-a-provider/);
  });
});
