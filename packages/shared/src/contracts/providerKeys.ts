import { type ProviderKind } from './enums';
import { PROVIDER_CATALOGUE } from './providerCatalogue';

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

/**
 * The rules, in the order they are tested, taken from the catalogue.
 *
 * They used to be written out here a second time, with a third copy of every
 * provider's display name beside them. The catalogue's declaration order is the
 * test order, which is why it puts `sk-ant-` and `sk-or-` before the bare `sk-`
 * they both begin with.
 */
const RULES: { kind: ProviderKind; label: string; test: RegExp; confidence: 'certain' | 'likely' }[] = (
  Object.entries(PROVIDER_CATALOGUE) as [ProviderKind, (typeof PROVIDER_CATALOGUE)[ProviderKind]][]
)
  .filter(([, entry]) => entry.keyPattern)
  .map(([kind, entry]) => ({
    kind,
    label: entry.label,
    test: entry.keyPattern!.test,
    confidence: entry.keyPattern!.confidence,
  }));

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
