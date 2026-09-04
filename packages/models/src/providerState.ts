/**
 * What is actually wrong with a provider, rather than that something is.
 *
 * The health check already knew: the HTTP layer classifies every response and
 * puts the status on the error. Then `health` collapsed all of it into
 * `{ ok: false, detail }`, so a rejected key, a provider having an outage, a
 * rate limit and a typo in a base URL all arrived at the interface as the same
 * red dot with a sentence underneath. They need completely different things
 * done about them, and only one of them is the owner's fault.
 *
 * The states below are the ones the providers really produce. There is no
 * "degraded" here because nothing reports it, and inventing a state nothing can
 * emit is how a status display starts lying.
 */
import { PipelineError } from '@xbam/shared';

export type ProviderState =
  /** No credential saved yet. */
  | 'NOT_CONFIGURED'
  /** A check is in flight. Set by the interface, never by a check result. */
  | 'TESTING'
  /** Answered, and listed its models. */
  | 'CONNECTED'
  /** Answered, and rejected the key. 401 or 403. */
  | 'INVALID_CREDENTIALS'
  /** Answered, and said not now. 429. */
  | 'RATE_LIMITED'
  /** Did not answer, or answered with its own failure. 5xx, timeout, network. */
  | 'UNAVAILABLE'
  /** Answered, but has no model list to give. Not a fault. */
  | 'NO_MODEL_LIST'
  /** Reachable, but the model this agent is set to use is not among its models. */
  | 'MODEL_UNAVAILABLE';

export interface ProviderVerdict {
  state: ProviderState;
  /** One sentence naming what happened, for somebody who did not read the log. */
  detail: string;
  /** What to do about it, or null when there is nothing to do. */
  fix: string | null;
  /** Models it reported, which is what a model picker offers. */
  models: string[];
  /** Whether waiting is likely to help. A rejected key never fixes itself. */
  transient: boolean;
}

/** The HTTP status behind a provider error, when there was one. */
export function statusOf(error: unknown): number | null {
  if (error instanceof PipelineError) {
    // The HTTP layer puts the status in `data` and the code in `reason`.
    const status = error.data?.status;
    if (typeof status === 'number') return status;
    const fromReason = /^http_(\d{3})$/.exec(error.reason ?? '');
    if (fromReason) return Number(fromReason[1]);
  }
  return null;
}

/**
 * Turn a failed health check into something actionable.
 *
 * `label` is the provider's own name, because "the key was rejected" is far
 * less useful than "xAI rejected the key" when three providers are configured.
 */
/**
 * Providers disagree about which status a rejected key deserves.
 *
 * xAI answers 400 with `{"code":"invalid-argument","error":"Incorrect API key
 * provided."}` -- verified against the live API, not assumed -- while OpenAI
 * and Anthropic use 401. Classifying on the status alone therefore told an xAI
 * owner with a wrong key that the provider was having an outage and to try
 * again shortly, which is the opposite of what they needed to do.
 *
 * So the body is read as well. The status is the strong signal; this is the
 * one that catches the providers which do not use it.
 */
const SAYS_BAD_KEY =
  /incorrect api[_ ]?key|invalid api[_ ]?key|invalid[_ ]authentication|authentication[_ ]failed|unauthorized|no api key provided|invalid token|api key not valid/i;

export function verdictFromError(error: unknown, label: string): ProviderVerdict {
  const status = statusOf(error);
  const message = error instanceof Error ? error.message : String(error);

  if (SAYS_BAD_KEY.test(message)) {
    return {
      state: 'INVALID_CREDENTIALS',
      detail: `${label} rejected the API key.`,
      fix: 'Replace the key. Check it was copied whole and belongs to this provider.',
      models: [],
      transient: false,
    };
  }

  if (status === 401 || status === 403) {
    return {
      state: 'INVALID_CREDENTIALS',
      detail: `${label} rejected the API key.`,
      fix: 'Replace the key. Check it was copied whole and belongs to this provider.',
      models: [],
      transient: false,
    };
  }

  if (status === 429) {
    return {
      state: 'RATE_LIMITED',
      detail: `${label} is rate limiting this key.`,
      // Nothing is wrong with the setup, so the advice is not to change it.
      fix: 'Wait and test again. Nothing needs changing here.',
      models: [],
      transient: true,
    };
  }

  if (status === 404) {
    // Reachable and answering, but with no model list at this path. Anthropic
    // is the ordinary case, and it is not a fault: models are named by hand.
    return {
      state: 'NO_MODEL_LIST',
      detail: `${label} does not publish a model list.`,
      fix: 'Type the model identifier instead. The provider documentation lists them.',
      models: [],
      transient: false,
    };
  }

  if (status !== null && status >= 500) {
    return {
      state: 'UNAVAILABLE',
      detail: `${label} returned ${status}.`,
      fix: 'This is the provider, not the configuration. Test again shortly.',
      models: [],
      transient: true,
    };
  }

  if (/timed out/i.test(message)) {
    return {
      state: 'UNAVAILABLE',
      detail: `${label} did not answer in time.`,
      fix: 'Test again. If it keeps timing out, check the base URL and any proxy.',
      models: [],
      transient: true,
    };
  }

  if (/network|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return {
      state: 'UNAVAILABLE',
      detail: `${label} could not be reached.`,
      fix: 'Check the base URL, and that this machine can reach it.',
      models: [],
      transient: true,
    };
  }

  return {
    state: 'UNAVAILABLE',
    detail: `${label}: ${message}`,
    fix: 'Test again. If it persists, check the base URL and the key.',
    models: [],
    transient: true,
  };
}

/** A successful check, with whatever models it named. */
export function verdictFromModels(label: string, models: string[]): ProviderVerdict {
  if (models.length === 0) {
    return {
      state: 'NO_MODEL_LIST',
      detail: `${label} answered but named no models.`,
      fix: 'Type the model identifier by hand.',
      models: [],
      transient: false,
    };
  }
  return {
    state: 'CONNECTED',
    detail: `${label} answered with ${models.length} model${models.length === 1 ? '' : 's'}.`,
    fix: null,
    models,
    transient: false,
  };
}

/**
 * Whether the model an agent is set to use still exists.
 *
 * The failure this prevents is quiet and expensive: a provider that tests
 * green while the agent is pointed at a model that provider retired. Every
 * screen says connected, and every generation fails.
 */
export function checkModelStillOffered(
  label: string,
  chosen: string | null,
  models: string[],
): ProviderVerdict | null {
  if (!chosen || models.length === 0) return null;
  if (models.includes(chosen)) return null;
  return {
    state: 'MODEL_UNAVAILABLE',
    detail: `${label} no longer offers "${chosen}".`,
    fix: 'Choose another model. The provider is fine; this particular model is not there.',
    models,
    transient: false,
  };
}
