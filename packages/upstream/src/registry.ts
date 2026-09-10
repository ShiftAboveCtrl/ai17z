import type { AnyUpstream, Upstream } from './contract';

/**
 * Every outside service AI17Z knows how to ask, in one place.
 *
 * Registered explicitly at bootstrap rather than by scanning a directory, for
 * the same reason the capability registry and the provider catalogue are: a
 * list somebody has to edit is a list somebody reads, and an upstream that
 * appears because a file exists is an upstream nobody decided to ship.
 */
const UPSTREAMS = new Map<string, AnyUpstream>();

/**
 * Ids look like `family.name`, and the family half must match the declared one.
 *
 * Two ways of saying which family an upstream is in would eventually disagree,
 * and the one nobody reads would be the one fallback uses.
 */
const ID_SHAPE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export function registerUpstream<Q, R>(upstream: Upstream<Q, R>): void {
  if (!ID_SHAPE.test(upstream.id)) {
    throw new Error(`Upstream id "${upstream.id}" must look like family.name.`);
  }
  const [family] = upstream.id.split('.');
  if (family !== upstream.family) {
    throw new Error(
      `Upstream "${upstream.id}" says its family is "${upstream.family}", but its id says "${family}". ` +
        'Fallback reads the family, so these cannot disagree.',
    );
  }
  if (upstream.limit.perSecond <= 0 || upstream.limit.concurrent <= 0) {
    // An unlimited upstream is one nothing paces, and everything here exists to
    // ask an endpoint for less than it allows rather than as much as it will bear.
    throw new Error(`Upstream "${upstream.id}" must declare a positive rate and concurrency.`);
  }
  if (upstream.freshMs < 0) throw new Error(`Upstream "${upstream.id}" cannot have a negative freshness.`);

  const existing = UPSTREAMS.get(upstream.id);
  // Registering twice is how two implementations of one id end up in a build,
  // and the winner is whichever module loaded last. Refuse -- unless it is the
  // identical object, which is a module loaded twice.
  if (existing && existing !== (upstream as unknown as AnyUpstream)) {
    throw new Error(`Upstream "${upstream.id}" is already registered by something else.`);
  }
  UPSTREAMS.set(upstream.id, upstream as unknown as AnyUpstream);
}

export function getUpstream(id: string): AnyUpstream | null {
  return UPSTREAMS.get(id) ?? null;
}

export function listUpstreams(): AnyUpstream[] {
  return [...UPSTREAMS.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Everything that answers one question, best first.
 *
 * Ranked here rather than at every call site, because the order is a decision
 * somebody made -- cheapest, most accurate, least limited -- and a decision
 * repeated in several places is a decision that will eventually differ between
 * them. Ties break on id so the order is stable across processes.
 */
export function familyMembers(family: string): AnyUpstream[] {
  return listUpstreams()
    .filter((upstream) => upstream.family === family)
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
}

/** Every family that has at least one upstream in it. */
export function listFamilies(): string[] {
  return [...new Set(listUpstreams().map((upstream) => upstream.family))].sort();
}

/** Only for tests: the registry is process-wide and otherwise append-only. */
export function resetUpstreamsForTest(): void {
  UPSTREAMS.clear();
}
