import { describe, expect, it } from 'vitest';
import {
  EASY_SETUP_PROVIDERS,
  PROVIDER_CATALOGUE,
  PROVIDER_KINDS,
  guessProviderFromKey,
  providerLabel,
  type ProviderKind,
} from '@xbam/shared/contracts';
import { getAdapter, listAdapters } from '@xbam/models';

/**
 * Adding a provider used to mean editing eight files, six of which were saying
 * the same things again in a different shape -- and they had already drifted:
 * the Easy Mode picker called Anthropic "Claude" while every other screen said
 * "Claude (Anthropic)".
 *
 * The catalogue is now the one declaration. These tests are what stops a second
 * one growing back: each asserts that some other place still *derives* from it
 * rather than repeating it, so re-hardcoding a label or a URL fails here.
 */
describe('the provider catalogue', () => {
  it('covers every provider kind the enum declares', () => {
    // The failing case this exists for: somebody adds a kind to the enum, wires
    // an adapter, and ships a picker showing the raw enum name because nothing
    // told them a catalogue entry was required.
    for (const kind of PROVIDER_KINDS) {
      expect(PROVIDER_CATALOGUE[kind], kind).toBeDefined();
      expect(PROVIDER_CATALOGUE[kind].label, kind).not.toBe('');
    }
    expect(Object.keys(PROVIDER_CATALOGUE).sort()).toEqual([...PROVIDER_KINDS].sort());
  });

  it('names no provider by its enum key', () => {
    // `openai_compatible` on screen is the symptom this catches: a label that
    // is the identifier means somebody added an entry without writing the name
    // a person would recognise.
    for (const kind of PROVIDER_KINDS) {
      expect(PROVIDER_CATALOGUE[kind].label, kind).not.toBe(kind);
      expect(providerLabel(kind), kind).toBe(PROVIDER_CATALOGUE[kind].label);
    }
  });

  it('is where the adapters get their endpoint and their name', () => {
    // Both were literals in the registry and again in the catalogue. Derived
    // now, so this passes trivially -- which is the point: it fails the day
    // somebody writes a URL back into an adapter.
    for (const adapter of listAdapters()) {
      const entry = PROVIDER_CATALOGUE[adapter.kind];
      expect(adapter.defaultBaseUrl, adapter.kind).toBe(entry.defaultBaseUrl);
      expect(adapter.requiresApiKey, adapter.kind).toBe(entry.requiresApiKey);
    }
  });

  it('agrees with the adapters about which providers need an account', () => {
    const catalogueKeyless = PROVIDER_KINDS.filter((k) => !PROVIDER_CATALOGUE[k].requiresApiKey).sort();
    // Stated independently rather than derived, because the whole risk is the
    // two sides agreeing on something wrong. A provider that slipped in here is
    // one the interface stops asking a key for, which fails at the first
    // generation instead of at setup.
    expect(catalogueKeyless).toEqual(['animal', 'mock', 'ollama']);
    for (const kind of catalogueKeyless) {
      expect(getAdapter(kind as ProviderKind).requiresApiKey, kind).toBe(false);
    }
  });

  it('offers exactly the providers marked for the simplified setup', () => {
    // EASY_SETUP_PROVIDERS carries the *order* by hand and takes membership
    // from the catalogue. Without this, a provider flagged `inEasySetup` but
    // left out of the order list simply never appears, and nothing says so.
    const flagged = PROVIDER_KINDS.filter((k) => PROVIDER_CATALOGUE[k].inEasySetup).sort();
    expect([...EASY_SETUP_PROVIDERS].sort()).toEqual(flagged);
    expect(EASY_SETUP_PROVIDERS[0]).toBe('openrouter');
  });

  it('keeps the endpoint-you-supply providers out of the simplified setup', () => {
    // Easy Mode asks eleven questions and none of them is "what is your base
    // URL". Mock and animal mode exercise AI17Z rather than run an agent.
    for (const kind of ['openai_compatible', 'mock', 'animal'] as ProviderKind[]) {
      expect(PROVIDER_CATALOGUE[kind].inEasySetup, kind).toBe(false);
    }
  });

  it('tells somebody what a keyless provider is before they pick it', () => {
    // "No key needed" is the one thing that changes what the next screen asks
    // for, so it may not be left to the label alone.
    for (const kind of PROVIDER_KINDS) {
      if (PROVIDER_CATALOGUE[kind].requiresApiKey) continue;
      expect(PROVIDER_CATALOGUE[kind].hint, kind).not.toBe('');
    }
  });

  it('is where key detection gets its rules and its wording', () => {
    const guess = guessProviderFromKey('sk-ant-api03-abcdefghijklmnop');
    expect(guess?.kind).toBe('anthropic');
    expect(guess?.label).toBe(PROVIDER_CATALOGUE.anthropic.label);
  });

  it('never claims a keyless provider from a pasted key', () => {
    // Ollama and mock have no prefix because they issue no keys. A pattern on
    // one of them would put "that looks like an Ollama key" under a paste of
    // somebody's real OpenAI credential.
    for (const kind of PROVIDER_KINDS) {
      if (PROVIDER_CATALOGUE[kind].requiresApiKey) continue;
      expect(PROVIDER_CATALOGUE[kind].keyPattern, kind).toBeUndefined();
    }
  });
});
