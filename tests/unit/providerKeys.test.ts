import { describe, expect, it } from 'vitest';
import {
  PROVIDER_KINDS,
  articleFor,
  PROVIDER_LABELS,
  guessProviderFromKey,
  providerLabel,
  type ProviderKind,
} from '@xbam/shared/contracts';

/**
 * Working out whose key this is.
 *
 * The add-provider form asked which provider before it asked for the key, from
 * a list of raw enum names -- `openai_compatible`, `mock` -- when the key
 * itself usually answers the question. So the key comes first and the provider
 * is filled in from it.
 *
 * A suggestion, never an imposition. Prefixes change, private deployments
 * exist, and a wrong guess nobody can override is worse than no guess: the
 * picker stays, every kind is still selectable, and choosing by hand stops the
 * guessing.
 */
describe('guessing a provider from its API key', () => {
  it('knows the prefixes only one vendor issues', () => {
    expect(guessProviderFromKey('sk-ant-api03-abcdefghijklmnop')).toMatchObject({
      kind: 'anthropic',
      confidence: 'certain',
    });
    expect(guessProviderFromKey('sk-or-v1-abcdefghijklmnopqrst')).toMatchObject({
      kind: 'openrouter',
      confidence: 'certain',
    });
    expect(guessProviderFromKey('xai-abcdefghijklmnopqrstuvwx')).toMatchObject({
      kind: 'xai',
      confidence: 'certain',
    });
    expect(guessProviderFromKey('AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q')).toMatchObject({
      kind: 'google',
      confidence: 'certain',
    });
  });

  it('tests the specific prefixes before the general one', () => {
    // `sk-ant-` and `sk-or-` both begin `sk-`, which is OpenAI's. Order is the
    // whole correctness argument here, so it is asserted rather than assumed.
    expect(guessProviderFromKey('sk-ant-api03-abcdefghijklmnop')?.kind).not.toBe('openai');
    expect(guessProviderFromKey('sk-or-v1-abcdefghijklmnopqrst')?.kind).not.toBe('openai');
  });

  it('is honest that a bare sk- is a guess', () => {
    // Dozens of compatible services copied OpenAI's shape. Saying "that is an
    // OpenAI key" about one of those would be wrong with confidence.
    const guess = guessProviderFromKey('sk-proj-abcdefghijklmnopqrstuvwxyz');
    expect(guess?.kind).toBe('openai');
    expect(guess?.confidence).toBe('likely');
  });

  it('recognises the DeepSeek shape without claiming certainty', () => {
    const guess = guessProviderFromKey('sk-0123456789abcdef0123456789abcdef');
    expect(guess?.kind).toBe('deepseek');
    expect(guess?.confidence).toBe('likely');
  });

  it('says nothing rather than guessing at something opaque', () => {
    // A self-hosted endpoint, a corporate gateway, or any vendor issuing a
    // plain token. Null is a real answer and the form has to handle it.
    expect(guessProviderFromKey('a1b2c3d4e5f6g7h8i9j0')).toBeNull();
    expect(guessProviderFromKey('')).toBeNull();
  });

  it('says nothing until enough has been typed to be a key', () => {
    // Otherwise a provider name appears on screen after two characters and
    // changes under somebody who is still pasting.
    expect(guessProviderFromKey('sk-')).toBeNull();
    expect(guessProviderFromKey('sk-ant-')).toBeNull();
  });

  it('ignores whitespace, because a pasted key brings some', () => {
    expect(guessProviderFromKey('  xai-abcdefghijklmnopqrstuvwx\n')?.kind).toBe('xai');
  });

  it('only ever names a provider AI17Z actually has', () => {
    for (const key of ['sk-ant-api03-abcdefghijklmnop', 'xai-abcdefghijklmnopqrstuvwx', 'sk-proj-abcdefghijklmnop']) {
      const guess = guessProviderFromKey(key);
      expect(PROVIDER_KINDS as readonly string[]).toContain(guess?.kind);
    }
  });
});

describe('what each provider is called', () => {
  it('names every kind, so the picker never shows an enum', () => {
    // The list read `openai_compatible` and `mock` before this. Adding a kind
    // and forgetting to name it would put the identifier back on screen.
    for (const kind of PROVIDER_KINDS) {
      expect(PROVIDER_LABELS[kind as ProviderKind], `${kind} has no label`).toBeTruthy();
      expect(providerLabel(kind as ProviderKind)).not.toBe(kind);
    }
  });

  it('includes Google, which was missing entirely', () => {
    expect(PROVIDER_KINDS as readonly string[]).toContain('google');
    expect(providerLabel('google')).toMatch(/gemini/i);
  });
});

describe('the sentence the form actually shows', () => {
  it('picks the article by how the name is said, not how it is spelled', () => {
    // "That is a OpenRouter key" was on screen. The rule follows pronunciation,
    // which is why x is in the vowel set: "an xAI key".
    expect(articleFor('OpenRouter')).toBe('an');
    expect(articleFor('OpenAI')).toBe('an');
    expect(articleFor('xAI (Grok)')).toBe('an');
    expect(articleFor('Claude (Anthropic)')).toBe('a');
    expect(articleFor('DeepSeek')).toBe('a');
    expect(articleFor('Google Gemini')).toBe('a');
  });

  it('reads correctly for every provider AI17Z has', () => {
    for (const kind of PROVIDER_KINDS) {
      const label = providerLabel(kind as ProviderKind);
      const sentence = `That is ${articleFor(label)} ${label} key.`;
      expect(sentence).not.toMatch(/\ba [AEIOUx]/);
      expect(sentence).not.toMatch(/\ban [^AEIOUaeioux]/);
    }
  });
});
