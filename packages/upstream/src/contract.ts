/**
 * What an upstream is, and what an answer from one carries with it.
 *
 * ### The word
 *
 * The mission that asked for this calls these *providers*, and everywhere else
 * in AI17Z a provider is the thing that runs a model -- `provider_credentials`,
 * `providerCatalogue.ts`, `packages/models/src/providers`. Two things called
 * provider in one product would be the same mistake as two things called
 * capability, which has already cost this codebase a field name. So: an
 * **upstream** is an outside service a capability reads from, and a *family* is
 * a set of upstreams that answer the same question, so one can stand in for
 * another. Where the mission says "provider family", the code says
 * `UpstreamFamily`.
 *
 * ### An answer is evidence, not knowledge
 *
 * The same rule the research step already follows. Nothing here returns a bare
 * value: every answer says which upstream produced it, when, and whether it came
 * off the wire or out of the cache. A price with no source is a number the agent
 * will state as confidently as a right one, and a stale number presented as
 * fresh is worse than no number.
 *
 * ### Being a good guest
 *
 * The limits, the breaker and the coalescing here exist so AI17Z asks an
 * endpoint for less than it is allowed, and stops asking one that is failing.
 * They are politeness and resilience. None of this is for getting around a
 * limit, and nothing in this package rotates an identity, spoofs an origin or
 * retries past a refusal to make one request look like several.
 */
import { z } from 'zod';
import type { UpstreamLimit } from './quota';

/** How an answer reached the caller. Always said, never inferred. */
export const UPSTREAM_SOURCES = ['LIVE', 'CACHED', 'COALESCED'] as const;
export type UpstreamSource = (typeof UPSTREAM_SOURCES)[number];

/**
 * Where a value came from and when, travelling with the value.
 *
 * Kept on the answer rather than logged beside it, because the prompt layer has
 * to be able to say "DexScreener, a minute ago" in the same breath as the
 * number. A finding whose provenance is in a log file is a finding the model
 * cannot attribute.
 */
export interface Provenance {
  /** The upstream that answered, by id. */
  upstreamId: string;
  /** The family the question was asked of. */
  family: string;
  /** The host, for a person to read. Never a full URL: those carry queries. */
  origin: string;
  /** When the value was actually fetched -- not when it was served. */
  fetchedAt: string;
  source: UpstreamSource;
  /** How old the value was when it was handed over, in milliseconds. */
  ageMs: number;
  /**
   * Upstreams that were asked first and could not answer, in order.
   *
   * Present even when one eventually did. "Ankr was down so this came from
   * Llama" is worth knowing, and an answer that hides its fallbacks looks
   * healthier than the system actually is.
   */
  fellBackFrom: string[];
}

export const Provenance: z.ZodType<Provenance> = z.object({
  upstreamId: z.string(),
  family: z.string(),
  origin: z.string(),
  fetchedAt: z.string(),
  source: z.enum(UPSTREAM_SOURCES),
  ageMs: z.number().int().nonnegative(),
  fellBackFrom: z.array(z.string()),
});

/** An answer, with the note of where it came from that makes it evidence. */
export interface Answer<T> {
  value: T;
  provenance: Provenance;
}

// What an operator allows lives in `quota.ts`, because it grew from two numbers
// into a model that can hold what endpoints actually publish -- several windows,
// a weight per request, and whose budget each window is.
export type { QuotaCoordinator, QuotaScope, QuotaWindow, UpstreamLimit } from './quota';

/** A secret an upstream needs, named rather than carried. */
export interface UpstreamSecret {
  /**
   * The key it is stored under, in the existing encrypted-secret store.
   *
   * Named, never valued. Nothing in this package holds a secret in a field, and
   * the value is fetched at the moment of the call and never returned, logged
   * or put in provenance.
   */
  key: string;
  /** What it is for, so a person deciding whether to add one can tell. */
  why: string;
  /**
   * Whether the upstream is useless without it.
   *
   * Many upstreams have a free tier that works unauthenticated and a better one
   * with a key. Those are `false`: an installation with no key still gets
   * answers, and the interface says what a key would add rather than refusing.
   */
  required: boolean;
}

/** Why an upstream cannot be asked right now. */
export const UPSTREAM_STATES = ['READY', 'NEEDS_SECRET', 'COOLING_OFF', 'DISABLED'] as const;
export type UpstreamState = (typeof UPSTREAM_STATES)[number];

export interface UpstreamHealth {
  state: UpstreamState;
  /** A sentence for a person. Empty when READY. */
  why: string;
  /** Consecutive failures. Reset by one success, not decayed. */
  failures: number;
  /** When it may be tried again, when it is cooling off. */
  retryAt: string | null;
  lastOkAt: string | null;
  lastFailedAt: string | null;
}

/**
 * One outside service.
 *
 * `fetch` is deliberately the only thing an upstream implements. Everything
 * else -- limiting, caching, coalescing, the breaker, falling back to a sibling
 * -- happens around it, so an upstream author writes the request and reads the
 * response and nothing else, and cannot accidentally opt out of being a good
 * guest.
 */
export interface Upstream<TQuery = unknown, TResult = unknown> {
  readonly id: string;
  /**
   * Which question it answers. Fallback happens inside a family.
   *
   * Two upstreams in one family must be interchangeable to the caller: same
   * query, same shape of result. If they are not, they are two families.
   */
  readonly family: string;
  readonly name: string;
  readonly description: string;
  /** The host, for provenance and for a person reading a list. */
  readonly origin: string;
  readonly limit: UpstreamLimit;
  readonly timeoutMs: number;
  /**
   * How long an answer stays good.
   *
   * Per upstream because it is a property of the thing being asked, not of the
   * asking. A chain's block height is stale in seconds; a contract's ABI is not
   * stale in a week.
   */
  readonly freshMs: number;
  readonly secret?: UpstreamSecret;
  /**
   * Preference within a family, lowest first.
   *
   * Order is a decision somebody made -- cheapest, most accurate, least
   * rate-limited -- and it belongs in one place rather than in every caller.
   */
  readonly rank: number;
  /**
   * The key an answer is cached and coalesced under.
   *
   * Derived from the query rather than the URL, so two upstreams in a family
   * share nothing and one upstream asked the same question twice shares
   * everything. Must not contain a secret.
   */
  cacheKey(query: TQuery): string;
  fetch(query: TQuery, ctx: UpstreamCallContext): Promise<TResult>;
}

export interface UpstreamCallContext {
  /** Abandoned when the upstream's own timeout expires. */
  signal: AbortSignal;
  /**
   * The secret this upstream declared, if one is stored.
   *
   * Handed in at the moment of the call and never held. Absent when none is
   * stored, which for an upstream whose secret is not `required` is an ordinary
   * state and not a failure.
   */
  secret?: string;
  log(message: string, data?: Record<string, unknown>): void;
}

export type AnyUpstream = Upstream<never, unknown>;

/**
 * Declares an upstream with its types intact.
 *
 * The same reason `defineCapability` exists: a plain object literal loses the
 * relationship between the query type and `fetch`.
 */
export function defineUpstream<TQuery, TResult>(upstream: Upstream<TQuery, TResult>): Upstream<TQuery, TResult> {
  return upstream;
}
