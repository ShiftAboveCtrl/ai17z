import { PROVIDER_KINDS, type ProviderKind } from './enums';

/**
 * Everything the product needs to say about a model provider, in one place.
 *
 * Adding a provider used to mean editing eight files: the kind enum, a label
 * map, a key-prefix rule, the adapter, the adapter registry, the package index,
 * the Easy Mode picker's own hard-coded list, and three hard-coded lists inside
 * one test. Six of those were presentation -- the same names and hints written
 * out again in a different shape -- and they drifted: the Easy picker called
 * Anthropic "Claude" while the label map called it "Claude (Anthropic)", and
 * the key-detection rules carried a third copy of both.
 *
 * This lives in contracts rather than beside the adapters because the browser
 * needs it and cannot import `@xbam/models`: the adapters reach the network and
 * pull in node built-ins. So the catalogue is the shared fact, and the adapter
 * is the behaviour.
 *
 * What belongs here: what a person is told, and what a key looks like.
 * What does not: how a request is made, which is the adapter's business.
 */
export interface ProviderPresentation {
  /** The name a person would recognise. Used everywhere a provider is named. */
  label: string;
  /** One line under the label. Empty when the name says enough. */
  hint: string;
  /** Whether a credential is mandatory. Ollama and the local providers are not. */
  requiresApiKey: boolean;
  /** Where requests go when nobody supplies a URL. Empty means the URL is the point. */
  defaultBaseUrl: string;
  /**
   * Whether the simplified picker offers it.
   *
   * Easy Mode deliberately shows a curated few. The generic OpenAI-compatible
   * endpoint needs a URL somebody has to know, and mock and animal mode are for
   * exercising AI17Z rather than running an agent.
   */
  inEasySetup: boolean;
  /**
   * How this vendor's keys start, most specific first, with how sure that is.
   *
   * `certain` for a prefix only one vendor issues; `likely` for one that is
   * conventional and copied -- a bare `sk-` is OpenAI's shape and also what a
   * dozen compatible services adopted. Absent when a vendor issues opaque
   * tokens, which is a real answer: the person picks from the list.
   */
  keyPattern?: { test: RegExp; confidence: 'certain' | 'likely' };
}

/**
 * Order matters for key detection: the first match wins, so a longer prefix
 * must be declared before the shorter one it starts with. `sk-ant-` and `sk-or-`
 * both begin `sk-`, which is OpenAI's.
 */
export const PROVIDER_CATALOGUE: Record<ProviderKind, ProviderPresentation> = {
  anthropic: {
    label: 'Claude (Anthropic)',
    hint: '',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    inEasySetup: true,
    // Documented since the API opened.
    keyPattern: { test: /^sk-ant-/i, confidence: 'certain' },
  },
  openrouter: {
    label: 'OpenRouter',
    hint: 'One key, most models.',
    requiresApiKey: true,
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    inEasySetup: true,
    // Documented as `sk-or-v1-`; the version segment is not relied on.
    keyPattern: { test: /^sk-or-/i, confidence: 'certain' },
  },
  xai: {
    // "xAI" rather than "Grok": Grok is the model, xAI is where the key comes
    // from, and somebody holding a SuperGrok subscription needs to know this is
    // not that.
    label: 'xAI (Grok)',
    hint: 'An API key from the xAI console. A SuperGrok subscription is not one.',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.x.ai/v1',
    inEasySetup: true,
    keyPattern: { test: /^xai-/i, confidence: 'certain' },
  },
  google: {
    label: 'Google Gemini',
    hint: 'An API key from Google AI Studio.',
    requiresApiKey: true,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    inEasySetup: true,
    // `AIza` plus 35 URL-safe characters. That prefix is a Google API key
    // generally rather than Gemini specifically, which is still the right guess:
    // it is the only Google thing AI17Z talks to.
    keyPattern: { test: /^AIza[0-9A-Za-z_-]{10,}$/, confidence: 'certain' },
  },
  deepseek: {
    label: 'DeepSeek',
    hint: '',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    inEasySetup: true,
    // A fixed-length `sk-` with no inner hyphen: not enough to be certain, and
    // enough to be worth suggesting.
    keyPattern: { test: /^sk-[0-9a-f]{32}$/i, confidence: 'likely' },
  },
  openai: {
    label: 'OpenAI',
    hint: '',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    inEasySetup: true,
    // Last of the `sk-` rules: everything that was not something more specific.
    keyPattern: { test: /^sk-/i, confidence: 'likely' },
  },
  ollama: {
    label: 'Ollama (on this machine)',
    hint: 'Runs on this machine. No key needed.',
    requiresApiKey: false,
    defaultBaseUrl: 'http://localhost:11434',
    inEasySetup: true,
  },
  openai_compatible: {
    label: 'Any OpenAI-compatible endpoint',
    hint: 'For a self-hosted or corporate gateway. You supply the URL.',
    requiresApiKey: true,
    // No default on purpose: the URL is the point.
    defaultBaseUrl: '',
    inEasySetup: false,
  },
  mock: {
    label: 'Mock (for testing AI17Z itself)',
    hint: 'Deterministic answers, no network, no cost.',
    requiresApiKey: false,
    defaultBaseUrl: 'mock://local',
    inEasySetup: false,
  },
  animal: {
    label: 'Animal mode (no key needed)',
    hint: 'Answers in animal noises. Exercises everything around generation.',
    requiresApiKey: false,
    defaultBaseUrl: 'animal://local',
    inEasySetup: false,
  },
};

/** Every kind, with the name a person would recognise. For the picker. */
export const PROVIDER_LABELS: Record<ProviderKind, string> = Object.fromEntries(
  PROVIDER_KINDS.map((kind) => [kind, PROVIDER_CATALOGUE[kind].label]),
) as Record<ProviderKind, string>;

/**
 * The curated few the simplified setup offers, in the order it offers them.
 *
 * The order is a recommendation, not the enum's: OpenRouter is first because
 * one key reaches most models, which is the least work for somebody who has
 * not chosen a vendor yet. Derived membership, declared order -- so a provider
 * cannot appear here without `inEasySetup`, and adding one does not silently
 * land it at the top.
 */
const EASY_ORDER: ProviderKind[] = ['openrouter', 'openai', 'anthropic', 'deepseek', 'xai', 'google', 'ollama'];

export const EASY_SETUP_PROVIDERS: ProviderKind[] = EASY_ORDER.filter(
  (kind) => PROVIDER_CATALOGUE[kind].inEasySetup,
);

export function providerLabel(kind: ProviderKind | string): string {
  return PROVIDER_LABELS[kind as ProviderKind] ?? kind;
}
