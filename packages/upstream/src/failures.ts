/**
 * Why an upstream could not answer, in terms the runtime can act on.
 *
 * "It failed" is not enough to decide anything. A timeout should be tried
 * again; a malformed response from the same endpoint probably should not. A 404
 * means the thing is not there and asking a sibling will not conjure it; a 429
 * means the operator has named a time and everything sharing that budget needs
 * to know. Collapsing those into one bucket is how a system ends up hammering an
 * endpoint that already said stop, and giving up on one that was merely slow.
 *
 * ### Two things that are not failures
 *
 * **A missing optional key.** An upstream nobody has given a key to is not
 * broken. Counting it as broken cools off a service that has never been asked,
 * and hides the one thing the owner could actually do about it.
 *
 * **An upstream the owner turned off.** That is a decision, and reporting a
 * decision as a fault teaches people to ignore the health screen.
 *
 * Both are states, not failures, and neither reaches the breaker.
 */

export const UPSTREAM_FAILURES = [
  /** The operator said stop, and usually said until when. */
  'RATE_LIMITED',
  /** It did not answer inside the upstream's own timeout. */
  'TIMEOUT',
  /** It could not be reached at all: DNS, connection, TLS. */
  'NETWORK',
  /** It answered, with a 5xx. Its problem, and probably temporary. */
  'UPSTREAM_5XX',
  /** It answered with something that is not the shape it promised. */
  'BAD_RESPONSE',
  /** We asked wrongly: a URL, a chain id, a missing required setting. */
  'BAD_CONFIGURATION',
  /** It is serving a different chain or network than it claims. */
  'WRONG_NETWORK',
  /** A key was rejected, or one is required and none was accepted. */
  'UNAUTHORIZED',
  /** The thing asked about does not exist. A sibling will not have it either. */
  'NOT_FOUND',
  /** It does not do this. Asking again, anywhere, will not change that. */
  'UNSUPPORTED',
  /** The caller went away, or the job was abandoned. */
  'CANCELLED',
] as const;
export type UpstreamFailureKind = (typeof UPSTREAM_FAILURES)[number];

/**
 * Whether trying a different member of the family is worth doing.
 *
 * `NOT_FOUND` and `UNSUPPORTED` are about the question rather than the
 * answerer, so walking the whole family to be told the same thing four times
 * spends four budgets to learn nothing. `CANCELLED` means nobody is waiting any
 * more. Everything else is about this endpoint, and a sibling may be fine.
 */
export function worthTryingSibling(kind: UpstreamFailureKind): boolean {
  return kind !== 'NOT_FOUND' && kind !== 'UNSUPPORTED' && kind !== 'CANCELLED';
}

/**
 * Whether this counts towards cooling an upstream off.
 *
 * A rate limit does not: the coordinator already knows when to try again, and
 * counting it here would cool off a perfectly healthy endpoint for being
 * popular. Nor does a question it could not answer -- `NOT_FOUND` says the
 * upstream worked.
 */
export function countsAgainstHealth(kind: UpstreamFailureKind): boolean {
  return kind !== 'RATE_LIMITED' && kind !== 'NOT_FOUND' && kind !== 'CANCELLED' && kind !== 'UNSUPPORTED';
}

export class UpstreamFailure extends Error {
  readonly kind: UpstreamFailureKind;
  /** When the upstream named a time, how long until it may be asked again. */
  readonly retryAfterMs: number | null;
  /**
   * Whether the upstream said this, or we did.
   *
   * Both look like RATE_LIMITED and they mean opposite things. When the operator
   * refuses, everything sharing that budget has to hear about it. When our own
   * scheduler refuses -- the budget we set is spent -- recording it as an
   * announcement blocks the whole origin on the strength of our own accounting,
   * and the next request is turned away by a limit nobody imposed.
   *
   * Found by the first weighted-budget test: a request that did not fit locally
   * put a sixty-second block on a perfectly willing endpoint.
   */
  readonly fromUpstream: boolean;

  constructor(
    kind: UpstreamFailureKind,
    message: string,
    retryAfterMs: number | null = null,
    fromUpstream = true,
  ) {
    super(message);
    this.name = 'UpstreamFailure';
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
    this.fromUpstream = fromUpstream;
  }
}

/**
 * How long an HTTP `Retry-After` is asking for, or nothing.
 *
 * Both forms, because both are in the standard and services use both. A number
 * is seconds; anything else is an HTTP date, which has to be turned into a
 * duration from now rather than trusted as a clock -- a machine whose time is
 * ten minutes fast would otherwise read every date as already passed and carry
 * straight on into the limit.
 */
export function retryAfterMs(header: string | null | undefined, now = Date.now()): number | null {
  if (!header) return null;
  const text = header.trim();
  if (!text) return null;

  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    if (!Number.isFinite(seconds)) return null;
    return Math.min(seconds, MAX_RETRY_AFTER_SECONDS) * 1_000;
  }

  const when = Date.parse(text);
  if (Number.isNaN(when)) return null;
  const ms = when - now;
  if (ms <= 0) return 0;
  return Math.min(ms, MAX_RETRY_AFTER_SECONDS * 1_000);
}

/**
 * The longest a `Retry-After` is honoured as given.
 *
 * A day. Beyond that the header is more likely wrong -- a misconfigured
 * gateway, a date in the wrong year -- than an operator genuinely asking to be
 * left alone until next month, and an upstream silently disabled for a fortnight
 * looks exactly like a bug in AI17Z.
 */
const MAX_RETRY_AFTER_SECONDS = 86_400;

/**
 * Reads an HTTP response into a verdict.
 *
 * One place, so thirty adapters do not each decide what a 503 means.
 */
export function classifyStatus(status: number, headers?: Headers, now = Date.now()): UpstreamFailure | null {
  if (status >= 200 && status < 300) return null;
  if (status === 429) {
    const wait = retryAfterMs(headers?.get('retry-after'), now);
    return new UpstreamFailure(
      'RATE_LIMITED',
      wait === null ? 'It asked us to slow down.' : `It asked us to wait ${Math.ceil(wait / 1000)}s.`,
      wait,
    );
  }
  if (status === 401 || status === 403) return new UpstreamFailure('UNAUTHORIZED', `It refused with ${status}.`);
  if (status === 404 || status === 410) return new UpstreamFailure('NOT_FOUND', `It has no such thing (${status}).`);
  if (status === 501 || status === 405) return new UpstreamFailure('UNSUPPORTED', `It does not do that (${status}).`);
  if (status === 408 || status === 504) return new UpstreamFailure('TIMEOUT', `It timed out (${status}).`);
  if (status === 503) {
    // Some services use 503 with Retry-After for load shedding, which is a rate
    // limit wearing a different number.
    const wait = retryAfterMs(headers?.get('retry-after'), now);
    if (wait !== null) return new UpstreamFailure('RATE_LIMITED', `It asked us to wait ${Math.ceil(wait / 1000)}s.`, wait);
    return new UpstreamFailure('UPSTREAM_5XX', 'It answered 503.');
  }
  if (status >= 500) return new UpstreamFailure('UPSTREAM_5XX', `It answered ${status}.`);
  return new UpstreamFailure('BAD_RESPONSE', `It answered ${status}.`);
}

/** Turns whatever was thrown into a verdict, so nothing escapes unclassified. */
export function classifyThrown(error: unknown): UpstreamFailure {
  if (error instanceof UpstreamFailure) return error;
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';

  if (name === 'AbortError' || /abort/i.test(message)) return new UpstreamFailure('TIMEOUT', message);
  if (name === 'UnsafeUrlError') return new UpstreamFailure('BAD_CONFIGURATION', message);
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ETIMEDOUT|certificate|TLS|socket/i.test(message)) {
    return new UpstreamFailure('NETWORK', message);
  }
  if (/not JSON|not a JSON-RPC|unexpected token/i.test(message)) return new UpstreamFailure('BAD_RESPONSE', message);
  if (/says it is chain|different chain|wrong network/i.test(message)) {
    return new UpstreamFailure('WRONG_NETWORK', message);
  }
  return new UpstreamFailure('BAD_RESPONSE', message);
}
