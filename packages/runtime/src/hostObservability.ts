import { carriesSecret } from './hostedSecrets';
import type { RuntimeState } from '@xbam/shared/contracts';

/**
 * Watching the infrastructure without reading the customers.
 *
 * An operator has to be able to tell a wedged runtime from a busy one, and a
 * host running out of memory from a host running fine. None of that requires
 * reading a memory, a chat, a prompt, a browser frame or anything an agent
 * said, and the moment infrastructure health is bundled with tenant content,
 * routine operations becomes routine surveillance.
 *
 * So health is a fixed shape of counts and states, and `isCleanHealth` refuses
 * anything that smells like content before it is stored or shown. The guard
 * exists because the pressure to add "just the last error message" or "just
 * the current page title" is constant and each one is a small window into
 * somebody's work.
 */

export interface RuntimeHealth {
  state: RuntimeState;
  version: string;
  /** Seconds since the runtime last reported. */
  lastSeenSec: number | null;
  cpuPercent: number | null;
  memoryUsedMb: number | null;
  memoryLimitMb: number | null;
  diskUsedGb: number | null;
  /** Jobs waiting, which is the clearest sign of a runtime falling behind. */
  jobsQueued: number | null;
  jobsFailedLastHour: number | null;
  /** Whether a browser is up, not what it is looking at. */
  browserUp: boolean | null;
  browserTabs: number | null;
  /** How many times it has restarted recently, which is what a crash loop is. */
  restartsLastHour: number | null;
  backupAgeHours: number | null;
}

/**
 * Field names an operator-facing health record may contain.
 *
 * An allowlist rather than a denylist, because the failure mode is somebody
 * adding a field, not somebody adding a field with a name we predicted.
 */
export const HEALTH_ALLOWED_FIELDS: readonly string[] = [
  'state',
  'version',
  'lastSeenSec',
  'cpuPercent',
  'memoryUsedMb',
  'memoryLimitMb',
  'diskUsedGb',
  'jobsQueued',
  'jobsFailedLastHour',
  'browserUp',
  'browserTabs',
  'restartsLastHour',
  'backupAgeHours',
];

/**
 * Whether this record is safe to store and show to an operator.
 *
 * Refuses an unexpected field, anything that looks like a secret, and any
 * free-text string beyond the two that are allowed to be strings. A health
 * record with a message in it is a health record that will eventually carry a
 * sentence an agent wrote.
 */
export function isCleanHealth(record: unknown): { ok: true } | { ok: false; why: string } {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, why: 'A health record has to be an object.' };
  }
  const entries = Object.entries(record as Record<string, unknown>);
  for (const [key, value] of entries) {
    if (!HEALTH_ALLOWED_FIELDS.includes(key)) {
      return { ok: false, why: `${key} is not a field an operator health record may carry.` };
    }
    // Only `state` and `version` are strings, and both are bounded
    // vocabularies rather than anything somebody or something wrote.
    const textual = key === 'state' || key === 'version';
    if (typeof value === 'string' && !textual) {
      return { ok: false, why: `${key} carries text, and a health record holds counts and states rather than prose.` };
    }
    if (typeof value === 'string' && value.length > 64) {
      return { ok: false, why: `${key} is longer than a state or a version should be.` };
    }
    /*
      A field name on the allowlist is not a value on it. Checking only the
      names let `{ jobsQueued: { note: 'the mentions tab is wedged' } }`
      through, under an allowed name, carrying exactly the content the
      allowlist exists to keep out. So every value is a number, a boolean or
      absent, and the two textual fields are strings.
    */
    if (value !== null && value !== undefined && !textual && typeof value !== 'number' && typeof value !== 'boolean') {
      return {
        ok: false,
        why: `${key} is a ${Array.isArray(value) ? 'list' : typeof value}, and a health record carries numbers, booleans and two bounded strings.`,
      };
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return { ok: false, why: `${key} is not a finite number.` };
    }
  }
  const secret = carriesSecret(record);
  if (secret.found) return { ok: false, why: `${secret.where} looks like key material.` };
  return { ok: true };
}

export type RuntimeHealthVerdict = 'HEALTHY' | 'BUSY' | 'DEGRADED' | 'WEDGED' | 'CRASH_LOOPING' | 'SILENT' | 'UNKNOWN';

/**
 * What an operator should actually look at first.
 *
 * Ordered by how much it matters rather than by how it reads. Silence comes
 * first because a runtime nobody has heard from cannot be assessed at all, and
 * a crash loop comes before degradation because restarting repeatedly is both
 * worse and easier to mistake for recovery.
 *
 * The distinction between BUSY and WEDGED is the one that costs time when it
 * is wrong: a long queue on a runtime that is still reporting is a runtime
 * doing its job, and the same queue on one that has stopped reporting is a
 * runtime that has stopped.
 */
export function judgeRuntimeHealth(health: RuntimeHealth, staleAfterSec = 120): { verdict: RuntimeHealthVerdict; reasons: string[] } {
  const reasons: string[] = [];

  if (health.lastSeenSec === null) {
    return { verdict: 'UNKNOWN', reasons: ['It has never reported, so nothing about it is known.'] };
  }
  if (health.lastSeenSec > staleAfterSec) {
    return { verdict: 'SILENT', reasons: [`Last reported ${health.lastSeenSec}s ago, past ${staleAfterSec}s.`] };
  }
  if ((health.restartsLastHour ?? 0) >= 3) {
    return {
      verdict: 'CRASH_LOOPING',
      reasons: [`${health.restartsLastHour} restarts in the last hour, which recovers nothing and looks like it might.`],
    };
  }

  const memoryTight =
    health.memoryUsedMb !== null && health.memoryLimitMb !== null && health.memoryUsedMb / health.memoryLimitMb > 0.9;
  if (memoryTight) reasons.push('Memory is above nine tenths of its limit.');
  if ((health.jobsFailedLastHour ?? 0) > 10) reasons.push(`${health.jobsFailedLastHour} jobs failed in the last hour.`);
  if (health.browserUp === false) reasons.push('No browser is running.');
  if (health.backupAgeHours !== null && health.backupAgeHours > 48) {
    reasons.push(`The newest verified backup is ${health.backupAgeHours} hours old.`);
  }
  if (reasons.length > 0) return { verdict: 'DEGRADED', reasons };

  // A queue on a runtime that is still reporting is work, not a fault.
  if ((health.jobsQueued ?? 0) > 50) {
    return { verdict: 'BUSY', reasons: [`${health.jobsQueued} jobs queued, and it is still reporting.`] };
  }
  return { verdict: 'HEALTHY', reasons: ['Reporting, inside its limits, with nothing queued unusually.'] };
}

/** What an operator may never reach by default, named so a reviewer can check. */
export const OPERATOR_DENIED_BY_DEFAULT: readonly string[] = [
  'Memory contents',
  'Owner chat',
  'Prompts and model context',
  'Browser frames and page contents',
  'Posts, replies and anything read from a channel',
  'Provider credentials',
  'Wallet keys and signing material',
  'Backup plaintext',
];

/**
 * A support action that reaches tenant content, if one is ever added.
 *
 * Shaped so that the uncomfortable parts are required fields: a reason
 * somebody typed, a bound on how long it lasts, and a record that it happened.
 * An access path without those is one nobody can audit, and an operator who
 * can read a customer silently is a feature nobody asked for.
 */
export interface BreakGlassRequest {
  operatorId: string;
  runtimeId: string;
  /** Free text, required. "Debugging" is not a reason, but it is a record. */
  reason: string;
  expiresAt: string;
  /** Whether the owner approved. Preferred, and recorded either way. */
  ownerApproved: boolean;
}

export function breakGlassIsWellFormed(request: BreakGlassRequest, now: Date = new Date()): { ok: true } | { ok: false; why: string } {
  if (request.reason.trim().length < 12) {
    return { ok: false, why: 'A break-glass access needs a reason somebody actually wrote.' };
  }
  const expiry = Date.parse(request.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now.getTime()) {
    return { ok: false, why: 'A break-glass access needs an expiry in the future.' };
  }
  if (expiry - now.getTime() > 4 * 3_600_000) {
    return { ok: false, why: 'A break-glass access may not last longer than four hours.' };
  }
  return { ok: true };
}
