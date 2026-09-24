import { describe, expect, it } from 'vitest';
import { GrowthPolicy } from '@xbam/shared/contracts';
import { growthWindow, inQuietHours, maySpend, type GrowthFacts } from '@xbam/runtime';

/**
 * When an agent may go looking for people, and what it may spend doing it.
 *
 * Every number here is a ceiling rather than a target, and the tests are
 * written to hold that distinction: nothing tries to spend what is left, and
 * an agent that has used none of its budget is not behind on anything.
 *
 * The measurement that produced these defaults: on a live installation with
 * none of this, eight hours produced 648 observations, 642 full pipeline runs,
 * 163 vision calls and about 263,000 tokens, for no public actions at all.
 */

const policy = (over: Partial<GrowthPolicy> = {}): GrowthPolicy => GrowthPolicy.parse(over);

const facts = (over: Partial<GrowthFacts> = {}): GrowthFacts => ({
  sessionsToday: 0,
  openSessionStartedAt: null,
  lastSessionEndedAt: null,
  modelCallsToday: 0,
  researchToday: 0,
  modelCallsThisSession: 0,
  researchThisSession: 0,
  candidatesThisSession: 0,
  accountHealth: 'HEALTHY',
  ...over,
});

const at = (hour: number) => new Date(Date.UTC(2026, 8, 24, hour, 0, 0));
/** Relative to the clock the test injects, never to the real one. */
const before = (now: Date, n: number) => new Date(now.getTime() - n * 60_000).toISOString();

describe('the defaults are the ones that were asked for', () => {
  it('ships the agreed ceilings', () => {
    const p = policy();
    expect(p.maxSessionsPerDay).toBe(8);
    expect(p.sessionMinutes).toBe(15);
    expect(p.cooldownMinutes).toBe(45);
    expect(p.maxCandidatesPerSession).toBe(2);
    expect(p.maxModelCallsPerSession).toBe(4);
    expect(p.maxModelCallsPerDay).toBe(24);
    expect(p.maxResearchPerSession).toBe(2);
    expect(p.maxResearchPerDay).toBe(8);
    expect(p.maxOriginalPostsPerDay).toBe(3);
    expect(p.maxRepostsPerDay).toBe(2);
  });

  it('defaults the three that should be nothing to nothing', () => {
    // Automated likes at scale are a bot signature whatever else the account
    // does; follow churn is the oldest growth trick there is; and an
    // unsolicited message lands in somebody's private inbox.
    const p = policy();
    expect(p.maxLikesPerDay).toBe(0);
    expect(p.maxFollowsPerDay).toBe(0);
    expect(p.maxUnsolicitedMessagesPerDay).toBe(0);
  });

  it('leaves a continuous eight-hour quiet window', () => {
    const p = policy();
    const quiet = Array.from({ length: 24 }, (_, hour) => inQuietHours(p, at(hour)));
    expect(quiet.filter(Boolean)).toHaveLength(8);
    // And it is continuous, not eight scattered hours.
    expect(quiet[23]).toBe(true);
    expect(quiet[0]).toBe(true);
    expect(quiet[6]).toBe(true);
    expect(quiet[7]).toBe(false);
    expect(quiet[22]).toBe(false);
  });
});

describe('quiet hours', () => {
  it('stops optional growth inside the window', () => {
    const verdict = growthWindow(policy(), facts(), at(2));
    expect(verdict.allowed).toBe(false);
    expect(verdict.state).toBe('QUIET_HOURS');
    // The sentence has to say that being quiet is not being broken.
    expect(verdict.message).toMatch(/still answered/i);
    expect(verdict.retryAfterMs).toBeGreaterThan(0);
  });

  it('allows it outside the window', () => {
    expect(growthWindow(policy(), facts(), at(14)).allowed).toBe(true);
  });

  it('handles a window that does not cross midnight', () => {
    const p = policy({ quietHoursStart: 1, quietHoursEnd: 9 });
    expect(inQuietHours(p, at(0))).toBe(false);
    expect(inQuietHours(p, at(5))).toBe(true);
    expect(inQuietHours(p, at(9))).toBe(false);
  });

  it('fails open on a timezone nobody can read', () => {
    // An agent that visibly ignores a bad setting beats one that mysteriously
    // stops. The same rule the cadence engine already applies.
    const p = policy({ timezone: 'Not/APlace', quietHoursStart: 23, quietHoursEnd: 7 });
    expect(() => inQuietHours(p, at(14))).not.toThrow();
    expect(inQuietHours(p, at(14))).toBe(false);
  });
});

describe('sessions, cooldown and daily limits', () => {
  it('rests between sessions', () => {
    const verdict = growthWindow(policy(), facts({ lastSessionEndedAt: before(at(14), 10) }), at(14));
    expect(verdict.allowed).toBe(false);
    expect(verdict.state).toBe('RESTING');
    expect(verdict.message).toMatch(/35 minutes to go/);
  });

  it('starts again once the cooldown has passed', () => {
    expect(growthWindow(policy(), facts({ lastSessionEndedAt: before(at(14), 46) }), at(14)).allowed).toBe(true);
  });

  it('stops after the day’s sessions are used', () => {
    const verdict = growthWindow(policy(), facts({ sessionsToday: 8 }), at(14));
    expect(verdict.allowed).toBe(false);
    expect(verdict.state).toBe('SPENT');
  });

  it('ends a session that has run its time', () => {
    const verdict = growthWindow(policy(), facts({ openSessionStartedAt: before(at(14), 16) }), at(14));
    expect(verdict.allowed).toBe(false);
    expect(verdict.message).toMatch(/ran its 15 minutes/);
  });

  it('lets a session in progress keep going', () => {
    const verdict = growthWindow(policy(), facts({ openSessionStartedAt: before(at(14), 5) }), at(14));
    expect(verdict.allowed).toBe(true);
    expect(verdict.state).toBe('OPEN');
  });

  it('does not cut a running session short on the daily session count', () => {
    // The daily count decides whether a *new* session may start. A session
    // already running is not a new one.
    const verdict = growthWindow(
      policy(),
      facts({ openSessionStartedAt: before(at(14), 3), sessionsToday: 8 }),
      at(14),
    );
    expect(verdict.allowed).toBe(true);
  });

  it('ends a session that has thought hard about its two candidates', () => {
    const verdict = growthWindow(
      policy(),
      facts({ openSessionStartedAt: before(at(14), 2), candidatesThisSession: 2 }),
      at(14),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.state).toBe('SPENT');
  });
});

describe('budgets', () => {
  it('stops optional model calls for the day, and says answering is unaffected', () => {
    const verdict = growthWindow(policy(), facts({ modelCallsToday: 24 }), at(14));
    expect(verdict.allowed).toBe(false);
    expect(verdict.message).toMatch(/Answering people is unaffected/i);
  });

  it('holds the per-session model budget separately from the daily one', () => {
    const within = maySpend(policy(), facts({ modelCallsThisSession: 3, modelCallsToday: 3 }), 'model');
    expect(within.allowed).toBe(true);
    const spent = maySpend(policy(), facts({ modelCallsThisSession: 4, modelCallsToday: 4 }), 'model');
    expect(spent.allowed).toBe(false);
    expect(spent.message).toMatch(/this session/i);
  });

  it('holds the research budget both ways too', () => {
    expect(maySpend(policy(), facts({ researchThisSession: 2 }), 'research').allowed).toBe(false);
    expect(maySpend(policy(), facts({ researchToday: 8 }), 'research').allowed).toBe(false);
    expect(maySpend(policy(), facts({ researchThisSession: 1, researchToday: 4 }), 'research').allowed).toBe(true);
  });
});

describe('optional growth is what yields', () => {
  it('stops when the account needs a person, and does not call it resting', () => {
    const verdict = growthWindow(
      policy(),
      facts({ accountHealth: 'HUMAN_ACTION_REQUIRED', accountHealthReason: 'X is asking for a code.' }),
      at(14),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.state).toBe('HELD');
    expect(verdict.message).toMatch(/asking for a code/);
    // Nothing to retry after: this is somebody's to clear.
    expect(verdict.retryAfterMs).toBeNull();
  });

  it('pauses while the account is coping with trouble', () => {
    for (const health of ['DEGRADED', 'COOLDOWN'] as const) {
      const verdict = growthWindow(policy(), facts({ accountHealth: health }), at(14));
      expect(verdict.allowed, health).toBe(false);
      expect(verdict.state, health).toBe('HELD');
    }
  });

  it('puts health ahead of quiet hours, because they are different facts', () => {
    // Saying "resting" about an account that needs a security code would be
    // the same comfortable lie the radar told when it reported healthy
    // sources it had never polled.
    const verdict = growthWindow(policy(), facts({ accountHealth: 'HUMAN_ACTION_REQUIRED' }), at(2));
    expect(verdict.state).toBe('HELD');
  });
});

describe('switched off', () => {
  it('says so plainly', () => {
    const verdict = growthWindow(policy({ enabled: false }), facts(), at(14));
    expect(verdict.allowed).toBe(false);
    expect(verdict.state).toBe('OFF');
  });
});
