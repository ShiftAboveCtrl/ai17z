import { createLogger } from '@xbam/shared';
import {
  DEFAULT_BUDGET,
  STOP_ASKING,
  WORTH_ANOTHER_BACKEND,
  emptyResult,
  type XBackendReadiness,
  type XCapability,
  type XId,
  type XIntelligenceBackend,
  type XPostRecord,
  type XPostsRequest,
  type XReadBudget,
  type XFreshness,
  type XReadContext,
  type XReadResult,
  type XUser,
} from './contract';
import { pageGraphqlBackend } from './pageGraphql';
import { pageDomBackend } from './pageDom';
import { cacheKey, cached, remember } from './cache';

export * from './contract';
export {
  pageGraphqlBackend,
  // The parsing, exported because it is pure and it is where X's own
  // shape actually bites -- nested wrappers, long-form text, cursors.
  tweetsFrom,
  toUser,
  toPost,
  nextCursor,
  classifyDetailed,
  findUserResult,
} from './pageGraphql';
export { pageDomBackend } from './pageDom';
export { forget as forgetXReads } from './cache';

const log = createLogger('x-intelligence');

/**
 * One place AI17Z reads X from.
 *
 * Everything that wants to know something about an account, a post or a
 * conversation asks here, and gets an answer that says where it came from. The
 * features do not know, and must not know, whether it arrived as X's own JSON,
 * as articles read off a rendered page, or from something read ten minutes ago.
 *
 * ## The order, and why it is this order
 *
 * `pageGraphql` first, because it gives immutable ids, exact counts,
 * conversation ids and long-form text -- none of which can be had reliably from
 * a drawn page. `pageDom` second, because it keeps working when X changes its
 * own API surface.
 *
 * Both run inside the browser the owner already signed in to. Neither needs a
 * cookie exported, a token pasted, a second X login, a Python package, or an
 * account pool. That is not an accident of implementation: it is the constraint
 * that decided the design, because the feature this replaces died of exactly
 * those requirements going unmet on every packaged installation.
 *
 * ## Falling back is a decision, not a reflex
 *
 * A backend is tried again only for outcomes where a different reader could
 * plausibly do better -- the API shape changed, the backend could not run, the
 * answer was empty. A protected account is protected however it is read; a
 * challenge is a person's to answer; a rate limit means stop. Retrying those
 * elsewhere is how a read turns into hammering, so `STOP_ASKING` ends it.
 *
 * And when a fallback does happen, **the answer says so**. A caller that got
 * approximate data from a rendered page is told, because a persona built from
 * it is a smaller claim than one built from exact data, and the difference has
 * to survive the trip.
 */

/** In order of preference. Capability by capability, not all-or-nothing. */
const BACKENDS: XIntelligenceBackend[] = [pageGraphqlBackend, pageDomBackend];

/** Exported so a test can drive routing without a browser. */
export function backendsForTest(list: XIntelligenceBackend[]): XIntelligenceBackend[] {
  return list;
}

export interface XIntelligenceOptions {
  /** A browser-capable channel context, when the caller has one. */
  channel?: unknown | null;
  budget?: Partial<XReadBudget>;
  /** Overridden in tests. Production uses the two real ones. */
  backends?: XIntelligenceBackend[];
  /**
   * How old an answer may be for what this caller is doing.
   *
   * Defaults to MODERATE, which suits the common case of looking somebody up.
   * A caller acting on what it reads should ask for LIVE; one building a
   * persona can take ARCHIVAL, because last month's posts describe a voice just
   * as well as today's.
   */
  freshness?: XFreshness;
  /** Read it again whatever is held. For an owner who pressed refresh. */
  refresh?: boolean;
}

function contextFor(options: XIntelligenceOptions): XReadContext {
  return {
    channel: options.channel ?? null,
    budget: { ...DEFAULT_BUDGET, ...(options.budget ?? {}) },
  };
}

/**
 * Ask each backend that can do this, in order, until one answers usefully.
 *
 * The routing is the whole of the fallback design and it is deliberately small:
 * ask, decide whether the answer is worth another attempt, move on or stop.
 * Everything clever lives in the backends, so a new one is added by writing it
 * rather than by teaching this function about it.
 */
async function route<T>(
  capability: XCapability,
  options: XIntelligenceOptions,
  empty: T,
  ask: (backend: XIntelligenceBackend, ctx: XReadContext) => Promise<XReadResult<T>>,
): Promise<XReadResult<T>> {
  const ctx = contextFor(options);
  const backends = options.backends ?? BACKENDS;
  let last: XReadResult<T> | null = null;
  const tried: string[] = [];

  for (const backend of backends) {
    if (typeof (backend as unknown as Record<string, unknown>)[capability] !== 'function') continue;

    let readiness: XBackendReadiness;
    try {
      readiness = await backend.readiness(ctx);
    } catch (error) {
      log.warn('a backend could not say whether it was ready', { backend: backend.name, message: (error as Error).message });
      continue;
    }
    if (readiness.state === 'UNAVAILABLE') continue;
    // A backend that says it cannot do this one thing is skipped for this one
    // thing, and still used for everything else it can do.
    if (readiness.can.length > 0 && !readiness.can.includes(capability)) continue;

    tried.push(backend.name);
    let result: XReadResult<T>;
    try {
      result = await ask(backend, ctx);
    } catch (error) {
      log.warn('a backend threw', { backend: backend.name, capability, message: (error as Error).message });
      result = emptyResult(backend.name, 'UNAVAILABLE', `${backend.name} could not complete the read.`, empty);
    }

    if (result.outcome === 'OK') {
      if (tried.length > 1) {
        // Recorded on the answer, not only in a log: a caller deciding how much
        // to claim from this data needs to know it came from the second choice.
        result.provenance.gaps = [...result.provenance.gaps, `${tried[0]} could not answer; read by ${backend.name}`];
      }
      return result;
    }

    last = result;
    if (STOP_ASKING.includes(result.outcome)) return result;
    if (!WORTH_ANOTHER_BACKEND.includes(result.outcome)) return result;
  }

  return (
    last ?? emptyResult('x-intelligence', 'UNAVAILABLE', 'Nothing here can read X at the moment.', empty)
  );
}

/**
 * What AI17Z can read from X.
 *
 * Read-only, permanently. There is no post, like, follow or message here and
 * there must never be: acting on X belongs to the engagement pipeline, behind
 * its policies, approvals and audit trail, and a read layer that grew a write
 * would route around all of it.
 */
export const xIntelligence = {
  /**
   * Handle to identity. Every other read should take the id this returns.
   *
   * Cached, because this is the question that repeats: the persona import, the
   * account tool and any screen showing somebody all ask it, often within
   * seconds of each other, and the answer changes about as often as somebody
   * renames themselves.
   *
   * The timeline read deliberately is not cached. A collection asks for two
   * hundred posts once; a second identical request is rare enough that holding
   * megabytes to serve it would cost more than the request it saves.
   */
  async resolveUser(handle: string, options: XIntelligenceOptions = {}): Promise<XReadResult<XUser | null>> {
    const key = cacheKey('resolveUser', handle.replace(/^@+/, '').toLowerCase());
    if (!options.refresh) {
      const held = cached<XUser | null>(key, options.freshness ?? 'MODERATE');
      if (held) return held;
    }
    const result = await route('resolveUser', options, null, (backend, ctx) => backend.resolveUser(ctx, handle));
    remember(key, result);
    return result;
  },

  async getUser(userId: XId, options: XIntelligenceOptions = {}): Promise<XReadResult<XUser | null>> {
    return route('getUser', options, null, (backend, ctx) => backend.getUser!(ctx, userId));
  },

  async getUserPosts(request: XPostsRequest, options: XIntelligenceOptions = {}): Promise<XReadResult<XPostRecord[]>> {
    return route('getUserPosts', options, [] as XPostRecord[], (backend, ctx) => backend.getUserPosts!(ctx, request));
  },

  async getPost(postId: XId, options: XIntelligenceOptions = {}): Promise<XReadResult<XPostRecord | null>> {
    return route('getPost', options, null, (backend, ctx) => backend.getPost!(ctx, postId));
  },

  async getThread(postId: XId, options: XIntelligenceOptions = {}): Promise<XReadResult<XPostRecord[]>> {
    return route('getThread', options, [] as XPostRecord[], (backend, ctx) => backend.getThread!(ctx, postId));
  },

  async searchPosts(
    request: { query: string; limit: number; latest?: boolean },
    options: XIntelligenceOptions = {},
  ): Promise<XReadResult<XPostRecord[]>> {
    return route('searchPosts', options, [] as XPostRecord[], (backend, ctx) => backend.searchPosts!(ctx, request));
  },

  /**
   * What each backend can do right now, for diagnostics.
   *
   * Per capability rather than per backend, because that is how the routing
   * works and a health screen that said "x-graphql: degraded" would not tell
   * anybody whether their persona import was going to work.
   */
  async health(options: XIntelligenceOptions = {}): Promise<XIntelligenceHealth> {
    const ctx = contextFor(options);
    const backends = options.backends ?? BACKENDS;
    const rows: XBackendHealthRow[] = [];

    for (const backend of backends) {
      try {
        const readiness = await backend.readiness(ctx);
        rows.push({ backend: backend.name, ...readiness });
      } catch (error) {
        rows.push({
          backend: backend.name,
          state: 'UNAVAILABLE',
          detail: `It could not be asked: ${(error as Error).message}`,
          can: [],
        });
      }
    }

    const capabilities: Record<XCapability, XCapabilityHealth> = {} as Record<XCapability, XCapabilityHealth>;
    for (const capability of ALL_CAPABILITIES) {
      const serving = rows.filter((row) => row.state !== 'UNAVAILABLE' && row.can.includes(capability));
      capabilities[capability] = {
        state: serving.length === 0 ? 'UNAVAILABLE' : serving.some((r) => r.state === 'READY') ? 'READY' : 'DEGRADED',
        by: serving.map((r) => r.backend),
      };
    }

    return { backends: rows, capabilities };
  },
};

const ALL_CAPABILITIES: XCapability[] = [
  'resolveUser',
  'getUser',
  'getUserPosts',
  'getPost',
  'getThread',
  'searchPosts',
];

export interface XBackendHealthRow extends XBackendReadiness {
  backend: string;
}

export interface XCapabilityHealth {
  state: 'READY' | 'DEGRADED' | 'UNAVAILABLE';
  /** Which backends could serve it, best first. */
  by: string[];
}

export interface XIntelligenceHealth {
  backends: XBackendHealthRow[];
  capabilities: Record<XCapability, XCapabilityHealth>;
}
