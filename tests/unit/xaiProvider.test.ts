import { describe, expect, it } from 'vitest';
import { PROVIDER_KINDS } from '@xbam/shared/contracts';
import { getAdapter, listAdapters } from '@xbam/models';

/**
 * xAI, checked against the official documentation before it was added.
 *
 * docs.x.ai describes POST /v1/chat/completions at https://api.x.ai/v1, taking
 * a Bearer key, with the OpenAI request and response shape -- messages, model,
 * choices, usage. So it needs no adapter of its own, and claiming otherwise
 * would have meant a second implementation of the same protocol.
 */
describe('xAI is a first-class provider', () => {
  it('is in the contract', () => {
    expect(PROVIDER_KINDS).toContain('xai');
  });

  it('has an adapter that reports itself as xAI', () => {
    const adapter = getAdapter('xai');
    expect(adapter.kind).toBe('xai');
    expect(adapter.defaultBaseUrl).toBe('https://api.x.ai/v1');
  });

  it('every provider kind in the contract has an adapter', () => {
    // A kind offered in the interface with nothing behind it is a provider
    // somebody can select and never use.
    for (const kind of PROVIDER_KINDS) {
      expect(() => getAdapter(kind), kind).not.toThrow();
    }
    expect(listAdapters().length).toBe(PROVIDER_KINDS.length);
  });

  it('is named after where the key comes from, not after the model', () => {
    // Grok is the model; xAI is the account. Somebody holding a SuperGrok
    // subscription has to be able to tell that this is not that, because a
    // consumer subscription is not documented to grant API access.
    const ui = require('node:fs').readFileSync(
      require('node:path').resolve(__dirname, '../../apps/web/src/routes/EasySetup.tsx'),
      'utf8',
    ) as string;
    expect(ui).toContain("kind: 'xai'");
    expect(ui).toMatch(/SuperGrok subscription is not one/i);
  });
});
