import type { UpstreamHealth } from './contract';

/**
 * Knowing when to stop asking.
 *
 * An upstream that is down does not answer faster because it is asked more, and
 * a family that keeps trying its first member burns the caller's whole budget of
 * time before it reaches one that works. So failures are counted, and after a
 * few in a row the upstream is left alone for a while and the family moves on to
 * the next member without waiting for a timeout it can already predict.
 *
 * ### One success clears it, and nothing else does
 *
 * No decay, no half-open counting down. An upstream is either answering or it is
 * not, and a counter that drains on its own reopens a dead endpoint on a
 * schedule rather than on evidence. When the cooling-off ends the next call is a
 * real call: if it works the count is cleared, and if it does not the wait gets
 * longer.
 *
 * ### Why it backs off rather than giving up
 *
 * Giving up permanently needs a person, and there is nobody to ask at three in
 * the morning. Doubling the wait to a cap means a service that comes back is
 * used again without anybody doing anything, and one that does not is asked
 * roughly once an hour instead of constantly.
 */

/** After this many consecutive failures, stop asking for a while. */
const FAILURES_BEFORE_COOLING = 3;

/** The first cooling-off, doubled per failure after that. */
const FIRST_COOLDOWN_MS = 5_000;

/**
 * The longest an upstream is ever left alone.
 *
 * An hour, so a service that came back overnight is noticed within one, and a
 * service that is gone for good is asked twenty-four times a day rather than
 * constantly. Both of those are the right amount of hope.
 */
const MAX_COOLDOWN_MS = 60 * 60_000;

interface Record_ {
  failures: number;
  retryAt: number | null;
  lastOkAt: number | null;
  lastFailedAt: number | null;
  lastWhy: string;
}

const HEALTH = new Map<string, Record_>();

function recordFor(id: string): Record_ {
  let record = HEALTH.get(id);
  if (!record) {
    record = { failures: 0, retryAt: null, lastOkAt: null, lastFailedAt: null, lastWhy: '' };
    HEALTH.set(id, record);
  }
  return record;
}

export function recordSuccess(id: string, now = Date.now()): void {
  const record = recordFor(id);
  record.failures = 0;
  record.retryAt = null;
  record.lastOkAt = now;
  record.lastWhy = '';
}

export function recordFailure(id: string, why: string, now = Date.now()): void {
  const record = recordFor(id);
  record.failures += 1;
  record.lastFailedAt = now;
  record.lastWhy = why;
  if (record.failures >= FAILURES_BEFORE_COOLING) {
    const doublings = record.failures - FAILURES_BEFORE_COOLING;
    record.retryAt = now + Math.min(FIRST_COOLDOWN_MS * 2 ** doublings, MAX_COOLDOWN_MS);
  }
}

/** Whether this upstream may be asked at this moment. */
export function isCoolingOff(id: string, now = Date.now()): boolean {
  const record = HEALTH.get(id);
  return record?.retryAt !== null && record?.retryAt !== undefined && record.retryAt > now;
}

/**
 * What is known about an upstream, for a screen and for a decision.
 *
 * `NEEDS_SECRET` is not decided here -- that depends on what is stored, which
 * this module deliberately cannot see. The caller layers it on top.
 */
export function healthOf(id: string, now = Date.now()): UpstreamHealth {
  const record = HEALTH.get(id);
  if (!record) {
    return { state: 'READY', why: '', failures: 0, retryAt: null, lastOkAt: null, lastFailedAt: null };
  }
  const cooling = isCoolingOff(id, now);
  return {
    state: cooling ? 'COOLING_OFF' : 'READY',
    why: cooling
      ? `${record.failures} failures in a row. Last: ${record.lastWhy || 'no reason recorded'}.`
      : '',
    failures: record.failures,
    retryAt: record.retryAt === null ? null : new Date(record.retryAt).toISOString(),
    lastOkAt: record.lastOkAt === null ? null : new Date(record.lastOkAt).toISOString(),
    lastFailedAt: record.lastFailedAt === null ? null : new Date(record.lastFailedAt).toISOString(),
  };
}

/** Only for tests, and for a worker that has just started. */
export function resetBreakerForTest(): void {
  HEALTH.clear();
}
