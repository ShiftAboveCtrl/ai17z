import { describe, expect, it } from 'vitest';
import { judgeHealth, mayAct, type HealthFacts } from '@xbam/runtime';

/**
 * How the runtime is coping, which is not whether the session is signed in.
 *
 * `accounts.status` already answers the second and answers it well. What it
 * cannot express is "signed in, working, and being told to slow down so often
 * that going looking for strangers is the wrong thing to be doing".
 *
 * The ordering is the whole design: **optional growth yields first.** Reading
 * what people sent is the last thing to stop, because an agent that stops
 * noticing mentions to protect itself has stopped being an agent. That is the
 * rule `throttleFor` already applies to memory pressure, applied to a
 * different kind of trouble.
 */

const facts = (over: Partial<HealthFacts> = {}): HealthFacts => ({
  status: 'CONNECTED',
  failedWrites: 0,
  rateLimits: 0,
  failingSources: 0,
  ambiguousWrites: 0,
  ...over,
});

describe('an account that needs a person', () => {
  it('says so for a security challenge, and never softens it', () => {
    const verdict = judgeHealth(facts({ status: 'CHALLENGE_REQUIRES_USER' }));
    expect(verdict.health).toBe('HUMAN_ACTION_REQUIRED');
    expect(verdict.reason).toMatch(/never answers one of these/i);
    // Nothing to retry after. This is somebody's to clear.
    expect(verdict.holdMs).toBeNull();
  });

  it('says so for a session that stopped being accepted', () => {
    for (const status of ['SESSION_EXPIRED', 'NEEDS_AUTH', 'TIMEOUT'] as const) {
      expect(judgeHealth(facts({ status })).health, status).toBe('HUMAN_ACTION_REQUIRED');
    }
  });

  it('treats one write of unknown outcome as worse than twenty that failed', () => {
    /*
      A reply that may or may not have gone out is the one thing here that
      cannot be retried, because retrying it is how the same thing gets posted
      twice. Twenty clean failures are safe to try again; this is not.
    */
    const ambiguous = judgeHealth(facts({ ambiguousWrites: 1 }));
    expect(ambiguous.health).toBe('HUMAN_ACTION_REQUIRED');
    expect(ambiguous.reason).toMatch(/posted twice/i);

    expect(judgeHealth(facts({ failedWrites: 20 })).health).toBe('COOLDOWN');
  });
});

describe('an account coping with trouble', () => {
  it('goes into cooldown when the remote keeps asking it to slow down', () => {
    const verdict = judgeHealth(facts({ rateLimits: 11 }));
    expect(verdict.health).toBe('COOLDOWN');
    expect(verdict.reason).toMatch(/11 times in the last hour/);
    expect(verdict.holdMs).toBeGreaterThan(0);
  });

  it('degrades on a few rate limits before it gives up entirely', () => {
    expect(judgeHealth(facts({ rateLimits: 3 })).health).toBe('DEGRADED');
    expect(judgeHealth(facts({ rateLimits: 10 })).health).toBe('COOLDOWN');
  });

  it('degrades when discovery itself is failing', () => {
    const verdict = judgeHealth(facts({ failingSources: 2 }));
    expect(verdict.health).toBe('DEGRADED');
    expect(verdict.reason).toMatch(/2 discovery sources are failing/);
  });

  it('is healthy when nothing is wrong', () => {
    const verdict = judgeHealth(facts());
    expect(verdict.health).toBe('HEALTHY');
    expect(verdict.holdMs).toBeNull();
  });

  it('recovers once the trouble stops, because it reads only the trailing hour', () => {
    // Nothing latches. The counts are what happened recently, so an account
    // that stops having trouble stops being degraded without anything sweeping.
    expect(judgeHealth(facts({ rateLimits: 0, failedWrites: 0 })).health).toBe('HEALTHY');
  });

  it('names what it saw rather than just the state', () => {
    // "DEGRADED" is a colour. "Eleven rate limits in the last hour" is a
    // reason somebody can act on.
    for (const f of [facts({ rateLimits: 11 }), facts({ failedWrites: 6 }), facts({ failingSources: 3 })]) {
      expect(judgeHealth(f).reason.length).toBeGreaterThan(30);
    }
  });
});

describe('what yields first', () => {
  it('stops growth before replies, and replies before reads', () => {
    expect(mayAct('HEALTHY', 'GROWTH')).toBe(true);
    expect(mayAct('DEGRADED', 'GROWTH')).toBe(false);
    expect(mayAct('DEGRADED', 'REPLY')).toBe(true);
    expect(mayAct('DEGRADED', 'READ')).toBe(true);
  });

  it('stops replying in cooldown but still reads', () => {
    expect(mayAct('COOLDOWN', 'GROWTH')).toBe(false);
    expect(mayAct('COOLDOWN', 'REPLY')).toBe(false);
    expect(mayAct('COOLDOWN', 'READ')).toBe(true);
  });

  it('stops everything when a person is needed', () => {
    for (const kind of ['READ', 'REPLY', 'GROWTH'] as const) {
      expect(mayAct('HUMAN_ACTION_REQUIRED', kind), kind).toBe(false);
    }
  });

  it('never lets growth outlive replying', () => {
    // The ordering as a property rather than four assertions: there is no
    // state in which the agent will approach a stranger but not answer one.
    for (const health of ['HEALTHY', 'DEGRADED', 'COOLDOWN', 'HUMAN_ACTION_REQUIRED'] as const) {
      if (mayAct(health, 'GROWTH')) expect(mayAct(health, 'REPLY'), health).toBe(true);
      if (mayAct(health, 'REPLY')) expect(mayAct(health, 'READ'), health).toBe(true);
    }
  });
});
