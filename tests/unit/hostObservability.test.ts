import { describe, expect, it } from 'vitest';
import {
  HEALTH_ALLOWED_FIELDS,
  OPERATOR_DENIED_BY_DEFAULT,
  breakGlassIsWellFormed,
  isCleanHealth,
  judgeRuntimeHealth,
  type BreakGlassRequest,
  type RuntimeHealth,
} from '@xbam/runtime';

/**
 * Watching the infrastructure without reading the customers.
 *
 * The pressure to add "just the last error message" or "just the current page
 * title" to a health record is constant, and each one is a small window into
 * somebody's work. So the allowlist is tested as an allowlist, and the
 * distinction that costs an operator time when it is wrong is tested
 * directly: a long queue on a runtime that is reporting is work, and the same
 * queue on one that has gone quiet is a failure.
 */

const health = (over: Partial<RuntimeHealth> = {}): RuntimeHealth => ({
  state: 'ACTIVE',
  version: '1.0.0-beta.63',
  lastSeenSec: 10,
  cpuPercent: 20,
  memoryUsedMb: 1_000,
  memoryLimitMb: 4_096,
  diskUsedGb: 5,
  jobsQueued: 2,
  jobsFailedLastHour: 0,
  browserUp: true,
  browserTabs: 4,
  restartsLastHour: 0,
  backupAgeHours: 3,
  ...over,
});

describe('a health record holds counts and states, never content', () => {
  it('accepts an ordinary record', () => {
    expect(isCleanHealth(health()).ok).toBe(true);
  });

  it('refuses a field nobody allowed', () => {
    // An allowlist, because the failure mode is somebody adding a field, not
    // somebody adding one with a name we predicted.
    const out = isCleanHealth({ ...health(), lastError: 'anything' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.why).toContain('lastError');
  });

  it('refuses prose even in an allowed field', () => {
    const out = isCleanHealth({ ...health(), jobsQueued: 'quite a lot really' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.why).toContain('prose');
  });

  it('allows strings only for the two bounded vocabularies', () => {
    const strings = HEALTH_ALLOWED_FIELDS.filter((f) => f === 'state' || f === 'version');
    expect(strings.sort()).toEqual(['state', 'version']);
    expect(isCleanHealth({ state: 'ACTIVE', version: '1.0.0' }).ok).toBe(true);
  });

  it('refuses a version string long enough to hide something in', () => {
    expect(isCleanHealth({ ...health(), version: 'x'.repeat(200) }).ok).toBe(false);
  });

  it('refuses anything that looks like key material', () => {
    const out = isCleanHealth({ ...health(), version: 'aGVsbG9fdGhpc19pc19sb25nX2VuY' });
    expect(out.ok).toBe(false);
  });

  it('refuses something that is not an object at all', () => {
    for (const bad of [null, undefined, 'a string', 42, [health()]]) {
      expect(isCleanHealth(bad).ok, String(bad)).toBe(false);
    }
  });
});

describe('what an operator should look at first', () => {
  it('cannot assess a runtime that has never reported', () => {
    const out = judgeRuntimeHealth(health({ lastSeenSec: null }));
    expect(out.verdict).toBe('UNKNOWN');
  });

  it('calls a runtime silent before judging anything else about it', () => {
    // Silence comes first because the other numbers are from the past.
    const out = judgeRuntimeHealth(health({ lastSeenSec: 999, jobsQueued: 5_000, restartsLastHour: 9 }));
    expect(out.verdict).toBe('SILENT');
  });

  it('calls repeated restarts a crash loop rather than recovery', () => {
    // Restarting repeatedly recovers nothing and looks like it might.
    const out = judgeRuntimeHealth(health({ restartsLastHour: 3 }));
    expect(out.verdict).toBe('CRASH_LOOPING');
    expect(out.reasons.join(' ')).toContain('recovers nothing');
  });

  it('tells a busy runtime from a wedged one', () => {
    // The distinction that costs time when it is wrong.
    const busy = judgeRuntimeHealth(health({ jobsQueued: 500, lastSeenSec: 5 }));
    expect(busy.verdict).toBe('BUSY');
    expect(busy.reasons.join(' ')).toContain('still reporting');

    const gone = judgeRuntimeHealth(health({ jobsQueued: 500, lastSeenSec: 600 }));
    expect(gone.verdict).toBe('SILENT');
  });

  it('degrades on memory, failures, a missing browser or a stale backup', () => {
    expect(judgeRuntimeHealth(health({ memoryUsedMb: 4_000, memoryLimitMb: 4_096 })).verdict).toBe('DEGRADED');
    expect(judgeRuntimeHealth(health({ jobsFailedLastHour: 50 })).verdict).toBe('DEGRADED');
    expect(judgeRuntimeHealth(health({ browserUp: false })).verdict).toBe('DEGRADED');
    expect(judgeRuntimeHealth(health({ backupAgeHours: 100 })).verdict).toBe('DEGRADED');
  });

  it('gives every reason rather than only the first', () => {
    const out = judgeRuntimeHealth(health({ browserUp: false, jobsFailedLastHour: 99, backupAgeHours: 200 }));
    expect(out.verdict).toBe('DEGRADED');
    expect(out.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it('says a healthy runtime is healthy, with a reason', () => {
    const out = judgeRuntimeHealth(health());
    expect(out.verdict).toBe('HEALTHY');
    expect(out.reasons[0]).toContain('Reporting');
  });

  it('does not treat an unknown number as a problem', () => {
    // Absent is not zero here either: a count nobody could read is not a
    // count of zero, and must not degrade a runtime on its own.
    const out = judgeRuntimeHealth(
      health({ cpuPercent: null, memoryUsedMb: null, memoryLimitMb: null, jobsQueued: null, jobsFailedLastHour: null, browserUp: null, restartsLastHour: null, backupAgeHours: null }),
    );
    expect(out.verdict).toBe('HEALTHY');
  });
});

describe('what an operator may not reach by default', () => {
  it('names it, so a reviewer can check the claim', () => {
    const all = OPERATOR_DENIED_BY_DEFAULT.join(' ').toLowerCase();
    for (const thing of ['memory contents', 'owner chat', 'prompts', 'browser frames', 'wallet keys', 'backup plaintext']) {
      expect(all, thing).toContain(thing);
    }
  });

  it('shares nothing with the fields a health record may carry', () => {
    // The two lists must not overlap, or observability is quietly a window.
    // Whole names, not first words: "Memory contents" and `memoryUsedMb`
    // share the word memory and are a count against a window, which is the
    // distinction the two lists exist to draw.
    const allowed = new Set(HEALTH_ALLOWED_FIELDS.map((f) => f.toLowerCase()));
    for (const denied of OPERATOR_DENIED_BY_DEFAULT) {
      const squashed = denied.toLowerCase().replace(/[^a-z0-9]+/g, '');
      expect(allowed.has(squashed), denied).toBe(false);
      expect(allowed.has(denied.toLowerCase()), denied).toBe(false);
    }
  });
});

describe('reaching into a tenant, if it ever happens', () => {
  const request = (over: Partial<BreakGlassRequest> = {}): BreakGlassRequest => ({
    operatorId: 'op-1',
    runtimeId: 'rt-1',
    reason: 'Investigating a reported crash loop with the owner on the call',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ownerApproved: true,
    ...over,
  });

  it('needs a reason somebody actually wrote', () => {
    expect(breakGlassIsWellFormed(request({ reason: 'debug' })).ok).toBe(false);
    expect(breakGlassIsWellFormed(request()).ok).toBe(true);
  });

  it('needs an expiry, and refuses one in the past', () => {
    expect(breakGlassIsWellFormed(request({ expiresAt: new Date(Date.now() - 1_000).toISOString() })).ok).toBe(false);
    expect(breakGlassIsWellFormed(request({ expiresAt: 'not a date' })).ok).toBe(false);
  });

  it('refuses an access long enough to become ordinary', () => {
    // A week-long break-glass is not break-glass, it is a key.
    const tooLong = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const out = breakGlassIsWellFormed(request({ expiresAt: tooLong }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.why).toContain('four hours');
  });

  it('records whether the owner approved either way', () => {
    // Preferred, not required, and the record says which it was.
    expect(breakGlassIsWellFormed(request({ ownerApproved: false })).ok).toBe(true);
  });
});
