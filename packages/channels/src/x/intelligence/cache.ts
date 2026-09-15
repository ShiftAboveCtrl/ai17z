import { FRESHNESS_SECONDS, type XFreshness, type XReadResult } from './contract';

/**
 * Not asking X something it answered a moment ago.
 *
 * Two screens open on the same person, a tool reading a profile the persona
 * import just read, a refresh pressed twice -- each of those is the same
 * question, and asking X again costs a request against a session the agent
 * needs for its actual work. The requirement is plain: do not refetch hundreds
 * of old posts every time a screen opens.
 *
 * ## Why freshness is the caller's decision
 *
 * There is no single right age for an answer. An engagement chance goes stale
 * in minutes; a follower count is fine for hours; the posts a persona is built
 * from describe a voice just as well next month as today. A cache with one
 * expiry would be wrong for almost everything, so the caller says which kind of
 * question it is asking and `FRESHNESS_SECONDS` decides.
 *
 * ## What it never does
 *
 * It never serves a refusal. A rate limit, a challenge, a signed-out browser
 * and a protected account are states of the world that change on their own, and
 * a cached "you are rate limited" would go on being true for ten minutes after
 * it stopped being true. Only answers are kept.
 *
 * And a cached answer says it was cached. The provenance keeps the time the
 * data was actually read from X -- not the time it was handed over -- so a
 * caller deciding how much to claim from it is looking at the real age.
 *
 * In process and bounded. This is a desktop application with one worker; a
 * shared cache would be a second store to keep consistent, and the thing it
 * would save is one browser read.
 */

interface Entry {
  at: number;
  result: XReadResult<unknown>;
}

const MAX_ENTRIES = 400;
const entries = new Map<string, Entry>();

/** Same question, same key. The freshness is the caller's, not part of identity. */
export function cacheKey(operation: string, ...parts: (string | number | boolean | null | undefined)[]): string {
  return `${operation}:${parts.map((p) => String(p ?? '')).join(':')}`;
}

/** A fresh-enough answer, or nothing. */
export function cached<T>(key: string, freshness: XFreshness): XReadResult<T> | null {
  const entry = entries.get(key);
  if (!entry) return null;
  const ageSeconds = (Date.now() - entry.at) / 1000;
  if (ageSeconds > FRESHNESS_SECONDS[freshness]) {
    entries.delete(key);
    return null;
  }
  const result = entry.result as XReadResult<T>;
  return {
    ...result,
    provenance: {
      ...result.provenance,
      // Marked, with the original read time kept. A caller that wants to know
      // how old this really is can, and one that does not is not misled about
      // where it came from.
      cached: true,
    },
  };
}

/** Keep an answer. Refusals are not answers and are not kept. */
export function remember(key: string, result: XReadResult<unknown>): void {
  if (result.outcome !== 'OK') return;
  // Oldest out first. A bound rather than a policy: four hundred profiles is
  // far more than a session looks at, and an unbounded map in a long-running
  // worker is a leak nobody notices until it is large.
  if (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entries.set(key, { at: Date.now(), result });
}

/** For tests, and for an owner who explicitly asked for fresh data. */
export function forget(prefix?: string): void {
  if (!prefix) {
    entries.clear();
    return;
  }
  for (const key of [...entries.keys()]) {
    if (key.startsWith(prefix)) entries.delete(key);
  }
}
