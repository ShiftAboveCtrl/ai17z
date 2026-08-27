import { describe, expect, it } from 'vitest';
import { CadenceConfig, defaultCadence } from '@xbam/shared/contracts';
import { jitter, msUntilAwake, nextPollDelayMs, withinQuietHours } from '@xbam/runtime';

const at = (iso: string) => new Date(iso);

describe('quiet hours', () => {
  const hours = (over: Record<string, unknown>) =>
    CadenceConfig.parse({ quietHours: { enabled: true, timezone: 'UTC', ...over } }).quietHours;

  it('is off entirely when not enabled', () => {
    expect(withinQuietHours(defaultCadence().quietHours, at('2026-01-01T03:00:00Z'))).toBe(false);
  });

  it('treats the configured window as awake and everything else as quiet', () => {
    const h = hours({ startHour: 8, endHour: 23 });
    expect(withinQuietHours(h, at('2026-01-01T12:00:00Z'))).toBe(false);
    expect(withinQuietHours(h, at('2026-01-01T03:00:00Z'))).toBe(true);
  });

  it('handles a window that crosses midnight', () => {
    const h = hours({ startHour: 22, endHour: 6 });
    expect(withinQuietHours(h, at('2026-01-01T23:00:00Z'))).toBe(false);
    expect(withinQuietHours(h, at('2026-01-01T02:00:00Z'))).toBe(false);
    expect(withinQuietHours(h, at('2026-01-01T12:00:00Z'))).toBe(true);
  });

  it('respects the timezone rather than the server clock', () => {
    const h = hours({ timezone: 'Asia/Tokyo', startHour: 9, endHour: 17 });
    // 03:00 UTC is midday in Tokyo, so the account is awake.
    expect(withinQuietHours(h, at('2026-01-01T03:00:00Z'))).toBe(false);
    // 12:00 UTC is 21:00 in Tokyo, so it is not.
    expect(withinQuietHours(h, at('2026-01-01T12:00:00Z'))).toBe(true);
  });

  it('fails open on an unusable timezone instead of silencing the account forever', () => {
    const h = hours({ timezone: 'Not/AZone' });
    expect(withinQuietHours(h, at('2026-01-01T03:00:00Z'))).toBe(false);
  });

  it('reports a wait that lands in the waking hour', () => {
    const h = hours({ startHour: 8, endHour: 23 });
    const wait = msUntilAwake(h, at('2026-01-01T03:00:00Z'));
    expect(wait / 3_600_000).toBeCloseTo(5, 1);
    expect(msUntilAwake(h, at('2026-01-01T12:00:00Z'))).toBe(0);
  });
});

describe('jitter', () => {
  it('stays inside the configured spread', () => {
    for (let i = 0; i < 200; i++) {
      const value = jitter(100_000, 20);
      expect(value).toBeGreaterThanOrEqual(80_000);
      expect(value).toBeLessThanOrEqual(120_000);
    }
  });

  it('is exactly the base interval when spread is zero', () => {
    expect(jitter(100_000, 0)).toBe(100_000);
  });

  it('never returns a delay short enough to become a busy loop', () => {
    expect(jitter(1_000, 50, () => 0)).toBeGreaterThanOrEqual(1_000);
  });
});

describe('poll scheduling', () => {
  const fixed = () => 0.5; // no jitter, so the arithmetic is visible

  it('uses the base interval when events are arriving', () => {
    const config = defaultCadence();
    const delay = nextPollDelayMs(config, { emptyStreak: 4, foundEvents: true, random: fixed });
    expect(delay).toBe(config.polling.intervalSeconds * 1_000);
  });

  it('doubles the gap for each consecutive empty poll', () => {
    const config = defaultCadence();
    const one = nextPollDelayMs(config, { emptyStreak: 1, foundEvents: false, random: fixed });
    const two = nextPollDelayMs(config, { emptyStreak: 2, foundEvents: false, random: fixed });
    expect(two).toBe(one * 2);
  });

  it('stops growing at the ceiling', () => {
    const config = CadenceConfig.parse({ polling: { intervalSeconds: 60, maxIntervalSeconds: 600 } });
    const delay = nextPollDelayMs(config, { emptyStreak: 9, foundEvents: false, random: fixed });
    expect(delay).toBe(600_000);
  });

  it('does not back off at all when idle backoff is turned off', () => {
    const config = CadenceConfig.parse({ polling: { intervalSeconds: 60, backoffWhenIdle: false } });
    const delay = nextPollDelayMs(config, { emptyStreak: 6, foundEvents: false, random: fixed });
    expect(delay).toBe(60_000);
  });

  it('sleeps until morning during quiet hours regardless of the interval', () => {
    const config = CadenceConfig.parse({
      polling: { intervalSeconds: 60 },
      quietHours: { enabled: true, timezone: 'UTC', startHour: 8, endHour: 23 },
    });
    const delay = nextPollDelayMs(config, {
      emptyStreak: 0,
      foundEvents: true,
      now: at('2026-01-01T03:00:00Z'),
      random: fixed,
    });
    expect(delay / 3_600_000).toBeCloseTo(5, 1);
  });

  it('parks a disabled account at the ceiling rather than checking it every tick', () => {
    const config = CadenceConfig.parse({ polling: { enabled: false, maxIntervalSeconds: 1_800 } });
    expect(nextPollDelayMs(config, { emptyStreak: 0, foundEvents: false, random: fixed })).toBe(1_800_000);
  });
});
