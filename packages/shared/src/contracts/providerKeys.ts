import { PROVIDER_KINDS, type ProviderKind } from './enums';

/**
 * Working out whose API key this is, from the key.
 *
 * Somebody has a key. They do not necessarily know, or care, that AI17Z calls
 * the thing behind it `openai_compatible` rather than `openai`, and asking them
 * to pick from a list of eight before they can paste it is a question the
 * string usually answers itself.
 *
 * So: paste first, and the provider is a suggestion rather than a prompt. It is
 * always a suggestion -- never applied silently over a choice somebody made,
 * and never the only way in. Every provider is still selectable by hand,
 * because prefixes change, private deployments exist, and a wrong guess that
 * cannot be overridden is worse than no guess.
 *
 * The prefixes are public and documented by each vendor. Order matters: the
 * longer, more specific ones are tested first, because `sk-ant-` and `sk-or-`
 * both begin `sk-`, which is OpenAI's.
 */
export interface KeyGuess {
  kind: ProviderKind;
  /** What to say about the guess, in the words somebody would use. */
  label: string;
  /**
   * How sure this is.
   *
   * `certain` for a prefix only one vendor issues. `likely` for one that is
   * conventional but not exclusive -- a bare `sk-` is OpenAI's shape and also
   * what a dozen compatible services copied.
   */
  confidence: 'certain' | 'likely';
}

interface Rule {
  kind: ProviderKind;
  label: string;
  test: RegExp;
  confidence: 'certain' | 'likely';
}

const RULES: Rule[] = [
  // Anthropic documents `sk-ant-` and has since the API opened.
  { kind: 'anthropic', label: 'Claude (Anthropic)', test: /^sk-ant-/i, confidence: 'certain' },
  // OpenRouter documents `sk-or-v1-`; the version segment is not relied on.
  { kind: 'openrouter', label: 'OpenRouter', test: /^sk-or-/i, confidence: 'certain' },
  { kind: 'xai', label: 'xAI (Grok)', test: /^xai-/i, confidence: 'certain' },
  // Google AI Studio keys are `AIza` followed by 35 URL-safe characters. The
  // prefix is a Google API key generally rather than Gemini specifically, which
  // is still the right guess here: it is the only Google thing AI17Z talks to.
  { kind: 'google', label: 'Google Gemini', test: /^AIza[0-9A-Za-z_-]{10,}$/, confidence: 'certain' },
  // DeepSeek issues `sk-` keys of a fixed length with no inner hyphen, which is
  // not enough on its own to be certain and is enough to be worth suggesting.
  { kind: 'deepseek', label: 'DeepSeek', test: /^sk-[0-9a-f]{32}$/i, confidence: 'likely' },
  // Last: every `sk-` that was not something more specific above.
  { kind: 'openai', label: 'OpenAI', test: /^sk-/i, confidence: 'likely' },
];

/**
 * The provider a key appears to belong to, or null when nothing matches.
 *
 * Null is a real answer and the caller must handle it: a self-hosted endpoint,
 * a corporate gateway, or a vendor that issues an opaque token has no prefix to
 * read, and the person picks from the list as before.
 */
export function guessProviderFromKey(apiKey: string): KeyGuess | null {
  const key = apiKey.trim();
  // Short enough to be a typo rather than a key. Guessing from two characters
  // would put a provider name on screen before anybody had finished pasting.
  if (key.length < 12) return null;

  for (const rule of RULES) {
    if (rule.test.test(key)) {
      return { kind: rule.kind, label: rule.label, confidence: rule.confidence };
    }
  }
  return null;
}

/** Every kind, with the name a person would recognise. For the picker. */
export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  openai: 'OpenAI',
  anthropic: 'Claude (Anthropic)',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  xai: 'xAI (Grok)',
  google: 'Google Gemini',
  ollama: 'Ollama (on this machine)',
  openai_compatible: 'Any OpenAI-compatible endpoint',
  mock: 'Mock (for testing AI17Z itself)',
};

/**
 * "a" or "an" for a provider name.
 *
 * Written out because the answer follows how the name is *said*, not how it is
 * spelled: "an OpenRouter key", and "an xAI key" because the x is pronounced
 * "ex". A hardcoded "a" produced "That is a OpenRouter key" on screen, which
 * undoes the impression that anything here was read before it shipped.
 */
export function articleFor(name: string): 'a' | 'an' {
  return /^[aeioux]/i.test(name.trim()) ? 'an' : 'a';
}

/** Guards the record above against a kind being added and not named. */
export function providerLabel(kind: ProviderKind): string {
  return PROVIDER_LABELS[kind] ?? kind;
}

export const NAMED_PROVIDER_KINDS = PROVIDER_KINDS;
