/**
 * What an upstream's operator allows, in a shape that can hold what they
 * actually publish.
 *
 * The first version of this was `{ perSecond, concurrent }`, which is what one
 * family needed and what nothing else does. Real endpoints publish requests a
 * minute, a day, compute units a month, weights per method, a different budget
 * per key and a different one per address. An adapter that cannot express its
 * limit centrally ends up keeping its own timer, and then there are thirty
 * limiters and no way to answer "are we being a good guest".
 *
 * So: **one declaration per upstream, and one scheduler that reads it.**
 *
 * ### The three things a limit is made of
 *
 * A **window** is a budget that refills: capacity, an interval, and whose
 * budget it is. Requests a second, a minute and a day are three windows, and
 * all three apply.
 *
 * A **weight** is what one request costs against those windows. Usually one.
 * Compute-unit endpoints charge more for some methods than others, and a
 * scheduler that counts requests cannot pace those.
 *
 * **Concurrency** is how many may be in the air, which is a live gauge rather
 * than a budget, and is deliberately named for the scope it actually has.
 */

/**
 * Whose budget a window is.
 *
 * The distinction is not academic. An installation has its own database and can
 * coordinate its own processes through it. Two installations on one machine have
 * two databases and no shared table -- and a public endpoint that limits by
 * source address sees one caller, because they share an IP.
 */
export const QUOTA_SCOPES = ['INSTALLATION', 'MACHINE'] as const;
export type QuotaScope = (typeof QUOTA_SCOPES)[number];

export interface QuotaWindow {
  /**
   * Counts this window separately for each value this returns.
   *
   * Some operators publish a budget per *method* as well as an overall one --
   * Solana's public RPC allows 100 requests per ten seconds per address and
   * only 40 of any single RPC. Without this, a family respecting the overall
   * rate can still spend it all on one method and break the tighter limit.
   *
   * Derived from the normalised query, so the discriminator is whatever the
   * upstream's own limit is keyed by rather than something an adapter invents.
   * Absent means one budget for everything, which is the common case.
   *
   * Deliberately central: the alternative is a private timer inside an adapter,
   * which is exactly what this package exists to stop.
   */
  per?(query: unknown): string | null;
  /** Units that may be spent in one interval. */
  capacity: number;
  intervalMs: number;
  /**
   * `INSTALLATION` for a budget that belongs to this installation -- a per-key
   * quota, or an endpoint that counts by account. `MACHINE` for one an endpoint
   * scopes to the source address, which every installation on this machine
   * shares whether or not they know about each other.
   */
  scope: QuotaScope;
  /** For a person reading a screen: "5/second", "100000/day". */
  label: string;
  /**
   * Whether the operator published this number, or we chose it.
   *
   * Not decoration. Several good free endpoints publish no limit at all --
   * PublicNode and LlamaRPC among them, checked in September 2026 -- and a
   * conservative number invented here is a guess at being a good guest, not a
   * documented allowance. A screen that shows both as "their limit" teaches an
   * owner to raise ours believing the operator sanctioned it, and a maintainer
   * updating published limits later cannot tell which entries were ever theirs.
   */
  source: LimitSource;
}

export const LIMIT_SOURCES = ['PUBLISHED', 'SELF_IMPOSED'] as const;
export type LimitSource = (typeof LIMIT_SOURCES)[number];

export interface UpstreamLimit {
  /**
   * How many requests this process may have in the air at once.
   *
   * Named for the scope it has. A cross-process concurrency gauge needs a lease
   * that survives a worker being killed mid-request, which is a much larger
   * thing than a counter that refills on its own -- and overshooting a
   * connection limit is far less likely to trouble an operator than overshooting
   * a request rate. An upstream that genuinely needs cross-process concurrency
   * cannot get it by writing this field, which is the point of the name.
   */
  concurrentPerProcess: number;
  /** Every budget that applies. All of them are checked; all of them are spent. */
  windows: QuotaWindow[];
  /**
   * What one request costs, when it is not one.
   *
   * Given the normalised query, so a compute-unit endpoint can charge by method
   * without the adapter keeping its own accounting. Absent means one.
   */
  weigh?(query: unknown): number;
}

interface WindowOptions {
  scope?: QuotaScope;
  source?: LimitSource;
}

function window(capacity: number, intervalMs: number, unit: string, options: WindowOptions): QuotaWindow {
  const source = options.source ?? 'SELF_IMPOSED';
  return {
    capacity,
    intervalMs,
    scope: options.scope ?? 'MACHINE',
    source,
    label: `${capacity}/${unit}${source === 'SELF_IMPOSED' ? ' (ours)' : ''}`,
  };
}

/**
 * Requests a second, the commonest shape, said once.
 *
 * `SELF_IMPOSED` by default deliberately. Claiming an operator published a
 * number should take an extra word, not be what happens when nobody thought
 * about it.
 */
export function perSecond(capacity: number, options: WindowOptions = {}): QuotaWindow {
  return window(capacity, 1_000, 'second', options);
}

/**
 * Ten seconds, which is the unit several operators actually publish in.
 *
 * Solana states its public limits per ten seconds, and expressing them as
 * "per second divided by ten" would both round badly and stop the label
 * matching the document somebody would check it against.
 */
export function perTenSeconds(capacity: number, options: WindowOptions = {}): QuotaWindow {
  return window(capacity, 10_000, '10s', options);
}

export function perMinute(capacity: number, options: WindowOptions = {}): QuotaWindow {
  return window(capacity, 60_000, 'minute', options);
}

export function perHour(capacity: number, options: WindowOptions = {}): QuotaWindow {
  return window(capacity, 3_600_000, 'hour', options);
}

export function perDay(capacity: number, options: WindowOptions = {}): QuotaWindow {
  return window(capacity, 86_400_000, 'day', options);
}

/**
 * Where a budget is counted.
 *
 * A window belonging to the machine is counted per upstream **origin**, not per
 * upstream id: three adapters pointing at one host are one caller to that host,
 * and counting them separately is how a published per-IP limit gets tripled by
 * an implementation detail. A window belonging to the installation is counted
 * per upstream id, because that is what a key or an account maps to.
 */
export function quotaKey(input: {
  upstreamId: string;
  origin: string;
  scope: QuotaScope;
  /** Set when the window is counted per method, per key, or per anything else. */
  per?: string | null;
}): string {
  const base = input.scope === 'MACHINE' ? `origin:${input.origin}` : `upstream:${input.upstreamId}`;
  // Appended rather than substituted, so a per-method budget is a budget
  // *within* the address it belongs to and cannot collide with another host's.
  return input.per ? `${base}:per:${input.per}` : base;
}

/** What a request costs against the windows, never less than one. */
export function weightOf(limit: UpstreamLimit, query: unknown): number {
  const weight = limit.weigh?.(query) ?? 1;
  return Number.isFinite(weight) && weight >= 1 ? Math.ceil(weight) : 1;
}

/**
 * Reserving room to make a request.
 *
 * Injected rather than imported, so `packages/upstream` stays a package about
 * asking outside services and does not acquire a dependency on the database,
 * the filesystem and the installer between here and there. The in-memory one
 * beside this is the default and is what tests use; production supplies one that
 * coordinates across processes.
 */
export interface QuotaCoordinator {
  /**
   * Spends `weight` against every window, or says how long to wait.
   *
   * All or nothing: a request that cannot afford the daily budget must not
   * spend the per-second one on the way to finding out, or a busy hour eats a
   * day's allowance in refusals.
   */
  reserve(input: {
    key: string;
    windows: QuotaWindow[];
    weight: number;
    now: number;
  }): Promise<{ granted: true } | { granted: false; retryAfterMs: number; window: string }>;

  /**
   * Records that an upstream told us to stop until a moment.
   *
   * A 429 is not a failure to be retried with backoff; it is the operator
   * naming a time. Everything sharing that budget has to know, including the
   * other processes -- otherwise the one that was not refused carries on into
   * the limit that has just been announced.
   */
  blockUntil(input: { key: string; until: number; why: string }): Promise<void>;

  /** How long until this key may be used again, or 0. */
  blockedFor(input: { key: string; now: number }): Promise<number>;
}
