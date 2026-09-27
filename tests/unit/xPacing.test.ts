import { describe, expect, it } from 'vitest';
import { CapacityCadence, RADAR_SOURCE_KINDS, X_READ_PACING, effectiveXInterval } from '@xbam/shared/contracts';
import { BROKEN_AS_PRESSURE, STRIKES_FORGIVEN_AFTER_MS, settleCapacity, type CapacityState } from '@xbam/runtime';

/**
 * One pace for asking X, for every account, and a breaker that answers X's
 * pushback rather than every page X failed to draw.
 *
 * Measured on a live installation: the account on the shipped defaults
 * (notifications 30s, mentions search 60s, replies search 90s) hit X's
 * "something went wrong" on both searches about every two hours and spent a day
 * cooling down, strikes climbing from 5 to 9. The account on 300 and 600 read
 * nearly twice as much in total and was never refused.
 */
describe('the pace AI17Z asks X at', () => {
  it('has a pace for every kind of source', () => {
    for (const kind of RADAR_SOURCE_KINDS) expect(X_READ_PACING[kind]).toBeDefined();
  });

  it('never creates a source faster than its own floor', () => {
    for (const kind of RADAR_SOURCE_KINDS) {
      expect(X_READ_PACING[kind].defaultSeconds).toBeGreaterThanOrEqual(X_READ_PACING[kind].floorSeconds);
    }
  });

  it('searches no faster than the pace measured to stay healthy', () => {
    expect(X_READ_PACING.mention_search.floorSeconds).toBeGreaterThanOrEqual(300);
    expect(X_READ_PACING.reply_search.floorSeconds).toBeGreaterThanOrEqual(600);
  });

  it('raises a setting that is too fast, and says so', () => {
    expect(effectiveXInterval('mention_search', 60)).toEqual({ seconds: 300, raised: true });
    expect(effectiveXInterval('notifications', 30)).toEqual({ seconds: 60, raised: true });
  });

  it('leaves a slower setting alone', () => {
    expect(effectiveXInterval('reply_search', 1200)).toEqual({ seconds: 1200, raised: false });
    expect(effectiveXInterval('tracked_keyword', undefined)).toEqual({ seconds: 1800, raised: false });
  });
});

describe('the breaker', () => {
  const config = CapacityCadence.parse({});
  const now = new Date('2026-09-27T12:00:00Z');
  const degraded: CapacityState = {
    health: 'DEGRADED',
    reason: 'Recovering from a cooldown.',
    until: new Date(now.getTime() + 60 * 60_000),
    strikes: 5,
  };
  const quiet = { status: 'CONNECTED' as const, rateLimits: 0, stalled: 0, failedWrites: 0, failingSources: 0 };

  it('does not cool an account down for one page X could not draw', () => {
    const next = settleCapacity(degraded, { ...quiet, broken: 1 }, config, now);
    expect(next.health).toBe('DEGRADED');
    expect(next.strikes).toBe(5);
  });

  it('treats several of them together as pressure', () => {
    const next = settleCapacity(degraded, { ...quiet, broken: BROKEN_AS_PRESSURE }, config, now);
    expect(next.health).toBe('COOLDOWN');
  });

  it('still cools down when X explicitly asks it to slow down', () => {
    expect(settleCapacity(degraded, { ...quiet, rateLimits: 1 }, config, now).health).toBe('COOLDOWN');
  });

  it('forgets old strikes after a quiet stretch', () => {
    const healthy: CapacityState = { health: 'HEALTHY', reason: null, until: null, strikes: 8 };
    expect(settleCapacity(healthy, { ...quiet, quietForMs: STRIKES_FORGIVEN_AFTER_MS }, config, now).strikes).toBe(0);
    expect(settleCapacity(healthy, { ...quiet, quietForMs: 60 * 60_000 }, config, now).strikes).toBe(8);
  });
});
