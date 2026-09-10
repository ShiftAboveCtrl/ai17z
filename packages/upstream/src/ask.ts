import { PipelineError } from '@xbam/shared';
import type { AnyUpstream, Answer, Provenance, Upstream, UpstreamHealth } from './contract';
import { familyMembers } from './registry';
import { recordRateLimit, takeSlot } from './limiter';
import { UpstreamFailure, classifyThrown, countsAgainstHealth, worthTryingSibling } from './failures';
import { isCoolingOff, healthOf, recordFailure, recordSuccess } from './breaker';
import { coalesce, lookup, remember } from './cache';

/**
 * Asking a family a question, and getting an answer that says where it is from.
 *
 * This is the only way anything calls an upstream, which is the point: an
 * upstream author writes `fetch` and nothing else, and cannot accidentally opt
 * out of being paced, cached, coalesced, given up on, or attributed. Every one
 * of those is here, once.
 *
 * The order, and why:
 *
 *   1. **the cache**, so a question answered a moment ago costs nothing;
 *   2. **the breaker**, so an upstream known to be failing is skipped before
 *      any time is spent on it rather than after a timeout;
 *   3. **coalescing**, so four agents waking together make one request;
 *   4. **the limiter**, so what is left is paced to what the operator allows;
 *   5. **the call**, with the upstream's own timeout;
 *   6. **the next member**, if that one could not answer.
 *
 * Coalescing sits inside the breaker and outside the limiter deliberately. A
 * joiner should not take a rate slot -- it is not making a request -- and it
 * should not join a request to an upstream that is already known to be down.
 */

export interface AskOptions {
  /**
   * Fetches the secret an upstream declared, by key.
   *
   * Injected rather than imported, so this package never reaches the encrypted
   * store and a secret exists only for the length of one call. Nothing here
   * puts it in provenance, in a log line or in an error -- and because the
   * value arrives through a function the caller supplies, that is a property of
   * the boundary rather than a rule somebody has to remember.
   */
  secretFor?(key: string): Promise<string | undefined>;
  log?(message: string, data?: Record<string, unknown>): void;
  /** Overridden in tests. Everything here reads the clock exactly once. */
  now?: number;
}

/** Why one member could not answer, kept so the failure can say what it tried. */
interface Attempt {
  upstreamId: string;
  why: string;
}

function provenanceFor(input: {
  upstream: AnyUpstream;
  fetchedAt: number;
  now: number;
  source: Provenance['source'];
  fellBackFrom: string[];
}): Provenance {
  return {
    upstreamId: input.upstream.id,
    family: input.upstream.family,
    origin: input.upstream.origin,
    fetchedAt: new Date(input.fetchedAt).toISOString(),
    source: input.source,
    ageMs: Math.max(0, input.now - input.fetchedAt),
    fellBackFrom: input.fellBackFrom,
  };
}

/**
 * Whether this upstream can be asked at all, before anything is spent on it.
 *
 * A missing secret is not a failure and must never reach the breaker: an
 * upstream nobody has given a key to is not broken, and counting it as broken
 * would cool off a service that has never been asked.
 */
async function unavailable(upstream: AnyUpstream, options: AskOptions, now: number): Promise<string | null> {
  if (isCoolingOff(upstream.id, now)) {
    const health = healthOf(upstream.id, now);
    return `cooling off until ${health.retryAt}`;
  }
  if (upstream.secret?.required) {
    const secret = await options.secretFor?.(upstream.secret.key);
    if (!secret) return `needs a ${upstream.secret.key} key, which is not stored`;
  }
  return null;
}

export async function ask<Q, R>(family: string, query: Q, options: AskOptions = {}): Promise<Answer<R>> {
  const now = options.now ?? Date.now();
  const members = familyMembers(family);
  if (members.length === 0) {
    throw PipelineError.permanent(
      'no_upstream',
      `Nothing is registered that can answer a "${family}" question.`,
    );
  }

  const tried: Attempt[] = [];

  for (const member of members) {
    const upstream = member as unknown as Upstream<Q, R>;
    const key = `${upstream.id}:${upstream.cacheKey(query)}`;

    const cached = lookup<R>(key, upstream.freshMs, now);
    if (cached) {
      return {
        value: cached.value,
        provenance: provenanceFor({
          upstream: member,
          fetchedAt: cached.fetchedAt,
          now,
          source: 'CACHED',
          fellBackFrom: tried.map((a) => a.upstreamId),
        }),
      };
    }

    const why = await unavailable(member, options, now);
    if (why) {
      tried.push({ upstreamId: upstream.id, why });
      continue;
    }

    try {
      const fetchedAt = Date.now();
      const { value, joined } = await coalesce<R>(key, async () => {
        // A budget is not waited for. Holding the call open until a daily quota
        // refills is how one exhausted upstream keeps a job open for eleven
        // hours; the family is told to try somebody else instead, which is the
        // whole reason a family has more than one member.
        const slot = await takeSlot({
          upstreamId: upstream.id,
          origin: upstream.origin,
          limit: upstream.limit,
          query,
          now: Date.now(),
        });
        if (!slot.granted) {
          throw new UpstreamFailure('RATE_LIMITED', `Not asking yet: ${slot.why}.`, slot.retryAfterMs);
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), upstream.timeoutMs);
        try {
          const secret = upstream.secret ? await options.secretFor?.(upstream.secret.key) : undefined;
          return await upstream.fetch(query, {
            signal: controller.signal,
            ...(secret ? { secret } : {}),
            log: (message, data) => options.log?.(message, { upstreamId: upstream.id, ...data }),
          });
        } finally {
          clearTimeout(timer);
          slot.slot.release();
        }
      });

      recordSuccess(upstream.id, fetchedAt);
      if (!joined) remember(key, value, fetchedAt);
      return {
        value,
        provenance: provenanceFor({
          upstream: member,
          fetchedAt,
          now: Date.now(),
          source: joined ? 'COALESCED' : 'LIVE',
          fellBackFrom: tried.map((a) => a.upstreamId),
        }),
      };
    } catch (error) {
      const failure = classifyThrown(error);

      // A named time is a fact about the endpoint, not a fault of this caller.
      // It goes to the coordinator so every process sharing that budget knows,
      // rather than to the breaker, which would cool off a healthy service for
      // being popular.
      if (failure.kind === 'RATE_LIMITED' && failure.retryAfterMs !== null) {
        await recordRateLimit({
          upstreamId: upstream.id,
          origin: upstream.origin,
          limit: upstream.limit,
          until: Date.now() + failure.retryAfterMs,
          why: failure.message,
        });
      }
      if (countsAgainstHealth(failure.kind)) recordFailure(upstream.id, failure.message, now);

      tried.push({ upstreamId: upstream.id, why: `${failure.kind}: ${failure.message}` });
      options.log?.('upstream could not answer', {
        upstreamId: upstream.id,
        family,
        kind: failure.kind,
        message: failure.message,
      });

      // Some answers are about the question rather than the answerer. Walking
      // the rest of the family to be told the same thing spends four budgets to
      // learn nothing.
      if (!worthTryingSibling(failure.kind)) break;
    }
  }

  // Nothing answered. Retryable rather than permanent: the question was
  // probably fine and every source was busy, cooling off, or unconfigured --
  // and saying which is the difference between a fault somebody can fix and a
  // fault somebody can only stare at.
  throw PipelineError.retryable(
    'upstreams_exhausted',
    `Nothing could answer that "${family}" question. Tried: ${tried
      .map((attempt) => `${attempt.upstreamId} (${attempt.why})`)
      .join('; ')}.`,
    { family, tried },
  );
}

/**
 * What is known about every member of a family, for a screen.
 *
 * `NEEDS_SECRET` is decided here rather than in the breaker, because it depends
 * on what is stored and the breaker deliberately cannot see that.
 */
export async function familyHealth(
  family: string,
  options: AskOptions = {},
): Promise<{ upstream: AnyUpstream; health: UpstreamHealth }[]> {
  const now = options.now ?? Date.now();
  const out: { upstream: AnyUpstream; health: UpstreamHealth }[] = [];
  for (const upstream of familyMembers(family)) {
    const health = healthOf(upstream.id, now);
    if (health.state === 'READY' && upstream.secret?.required) {
      const secret = await options.secretFor?.(upstream.secret.key);
      if (!secret) {
        out.push({
          upstream,
          health: { ...health, state: 'NEEDS_SECRET', why: `Needs a ${upstream.secret.key} key. ${upstream.secret.why}` },
        });
        continue;
      }
    }
    out.push({ upstream, health });
  }
  return out;
}
