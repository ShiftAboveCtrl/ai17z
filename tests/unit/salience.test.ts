import { describe, expect, it } from 'vitest';
import {
  decayed,
  fingerprintOf,
  overlap,
  scoreObservation,
  subjectsIn,
  type Observation,
  type SalienceContext,
} from '@xbam/runtime';
import { ATTENTION_HALF_LIFE_DAYS, SALIENCE_FLOOR } from '@xbam/shared/contracts';

/**
 * What an agent pays attention to, and -- far more often -- what it does not.
 *
 * An agent that finds everything its radar produced interesting has no
 * interests; it has a queue. These tests are about the declines as much as the
 * scores, because the declines are what make the working set mean anything.
 *
 * Deterministic on purpose, and that is the property under test as much as any
 * individual number: every point is attributable to a named factor carrying a
 * sentence, so an owner looking at why their agent is preoccupied with
 * something gets an answer rather than "the model thought so".
 */

const now = new Date('2026-09-15T12:00:00.000Z');
const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000).toISOString();

function context(over: Partial<SalienceContext> = {}): SalienceContext {
  return {
    topics: ['autonomous agents', 'agent memory', 'browser automation'],
    goals: [],
    onItsMind: [],
    people: new Map(),
    recentlySaid: [],
    selfHandles: ['ai17zos'],
    now,
    ...over,
  };
}

function observation(over: Partial<Observation> = {}): Observation {
  return {
    source: 'DISCOVERY',
    id: 'event-1',
    text: 'The hard part of autonomous agents is not the model, it is agent memory that survives a restart.',
    at: hoursAgo(2),
    handle: 'somebody',
    authorId: '900',
    url: 'https://x.com/somebody/status/1',
    metrics: null,
    ...over,
  };
}

describe('what is worth attending to', () => {
  it('scores something about a subject the agent follows', () => {
    const verdict = scoreObservation(observation(), context());
    expect(verdict.declined).toBeNull();
    expect(verdict.salience).toBeGreaterThan(SALIENCE_FLOOR);
    expect(verdict.factors.map((f) => f.name)).toContain('subject');
  });

  it('carries a readable sentence for every point it gave', () => {
    // A score without its reasons is not shippable. This is that rule as a test.
    const verdict = scoreObservation(observation(), context());
    for (const factor of verdict.factors) {
      expect(factor.detail.length, factor.name).toBeGreaterThan(8);
      expect(Number.isInteger(factor.points)).toBe(true);
    }
  });

  it('counts somebody the agent actually talks to for more than a stranger', () => {
    const known = new Map([
      ['somebody', { handle: 'somebody', inboundCount: 4, outboundCount: 2, familiarity: 'FAMILIAR', disposition: 'NEUTRAL' }],
    ]);
    const withPerson = scoreObservation(observation(), context({ people: known }));
    const withoutPerson = scoreObservation(observation(), context());
    expect(withPerson.salience).toBeGreaterThan(withoutPerson.salience);
    expect(withPerson.factors.map((f) => f.name)).toContain('relationship');
  });

  it('weighs something that bears on an active goal', () => {
    const verdict = scoreObservation(
      observation(),
      context({ goals: ['understand how agent memory survives a restart'] }),
    );
    expect(verdict.factors.map((f) => f.name)).toContain('goal');
  });

  it('counts engagement only when somebody actually counted it', () => {
    const measured = scoreObservation(observation({ metrics: { replies: 40, likes: 300 } }), context());
    const unmeasured = scoreObservation(observation({ metrics: null }), context());
    expect(measured.factors.map((f) => f.name)).toContain('discussed');
    // Absent is not zero: an unmeasured post must not be scored as ignored.
    expect(unmeasured.factors.map((f) => f.name)).not.toContain('discussed');
  });
});

describe('what is declined outright', () => {
  const declined = (over: Partial<Observation>, ctx?: Partial<SalienceContext>) =>
    scoreObservation(observation(over), context(ctx)).declined;

  it('declines something with nothing to do with this agent', () => {
    // Not scored low. Having nothing to do with something is a reason not to
    // think about it, not a weak reason to think about it.
    expect(declined({ text: 'my flight to Lisbon is delayed again and the coffee here is terrible' })?.reason).toBe(
      'unrelated',
    );
  });

  it('declines a post too short to have said anything', () => {
    expect(declined({ text: 'gm' })?.reason).toBe('nothing_said');
  });

  /*
    A repository somebody attached is the connection.

    This is the case that failed on a real installation: a new agent's persona
    carries no topics at all, so a release from the repository its owner had
    just connected was declined "nothing here connects to what this agent
    follows" -- said to the person who had connected it a minute earlier.
  */
  it('does not decline a watched repository as unrelated, even with no topics set', () => {
    const verdict = scoreObservation(
      observation({
        source: 'REPO_EVENT',
        text: 'ShiftAboveCtrl/ai17z: a release nothing in the persona happens to name',
        url: 'https://github.com/ShiftAboveCtrl/ai17z/releases/tag/v1.0.0-beta.21',
        handle: null,
      }),
      context({ topics: [] }),
    );
    expect(verdict.declined).toBeNull();
    expect(verdict.factors.map((factor) => factor.name)).toContain('watched-project');
  });

  it('still declines an unrelated post when the agent has no topics', () => {
    // The repository is the exception, not a hole: everything else still has
    // to connect to something.
    expect(
      declined({ text: 'my flight to Lisbon is delayed again and the coffee here is terrible' }, { topics: [] })
        ?.reason,
    ).toBe('unrelated');
  });

  it('declines the agent’s own post, so it cannot find itself interesting', () => {
    expect(declined({ handle: 'AI17ZOS' })?.reason).toBe('its_own');
  });

  it('declines something the agent has already said', () => {
    const verdict = declined(
      {},
      { recentlySaid: ['The hard part of autonomous agents is agent memory that survives a restart, not the model.'] },
    );
    expect(verdict?.reason).toBe('already_said');
  });

  it('declines a post old enough to be history', () => {
    expect(declined({ at: hoursAgo(200) })?.reason).toBe('too_old');
  });

  it('declines anybody the owner said not to engage with', () => {
    const blocked = new Map([
      ['somebody', { handle: 'somebody', inboundCount: 9, outboundCount: 0, familiarity: 'REGULAR', disposition: 'BLOCKED' }],
    ]);
    expect(declined({}, { people: blocked })?.reason).toBe('blocked');
  });

  it('declines anything that scores under the floor', () => {
    // Related, but barely: no subject match, no relationship, no goal, and old
    // enough that freshness gives it nothing.
    const verdict = scoreObservation(
      observation({ source: 'MENTION', text: 'hey can you take a look at this when you get a minute please', at: hoursAgo(70) }),
      context(),
    );
    if (verdict.declined) expect(verdict.declined.reason).toBe('too_faint');
    else expect(verdict.salience).toBeGreaterThanOrEqual(SALIENCE_FLOOR);
  });
});

describe('not thinking the same thing twice', () => {
  it('gives two people saying the same thing one fingerprint', () => {
    const first = scoreObservation(observation(), context());
    const second = scoreObservation(
      observation({ id: 'event-2', url: 'https://x.com/else/status/2', handle: 'else' }),
      context(),
    );
    // A working set is about subjects, not posts. Three people saying the same
    // thing is one thing three people said -- and it is the reinforcement that
    // separates it from a passing remark.
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it('separates things that are genuinely about something else', () => {
    const a = scoreObservation(observation(), context());
    const b = scoreObservation(
      observation({ id: 'e2', text: 'Browser automation keeps timing out whenever the mentions tab is scrolling.' }),
      context(),
    );
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('anchors the agent’s own published action on the action itself', () => {
    // Two different posts by the agent are two different things it did, even if
    // it said something similar twice -- and "did I already say this" is a
    // question about the post, not about the subject.
    const one = scoreObservation(observation({ source: 'ACTION_RESULT', handle: 'ai17zos', url: 'u1' }), context());
    const two = scoreObservation(observation({ source: 'ACTION_RESULT', handle: 'ai17zos', url: 'u2' }), context());
    expect(one.fingerprint).not.toBe(two.fingerprint);
  });

  it('falls back to the subject when there is no permalink', () => {
    const one = fingerprintOf('RESEARCH', 'agent memory that survives a restart is the hard part');
    const two = fingerprintOf('RESEARCH', 'the hard part is agent memory that survives a restart');
    // Word order is not what something is about.
    expect(one).toBe(two);
  });

  it('discounts something close to what is already on its mind', () => {
    const verdict = scoreObservation(
      observation(),
      context({ onItsMind: ['agent memory surviving a restart is the hard part of autonomous agents'] }),
    );
    expect(verdict.factors.map((f) => f.name)).toContain('familiar');
    expect(verdict.factors.find((f) => f.name === 'familiar')!.points).toBeLessThan(0);
  });
});

describe('the measures underneath', () => {
  it('matches a subject on a word boundary, not a substring', () => {
    // "ai" inside "said" is how an agent ends up interested in the weather.
    expect(subjectsIn('he said it was fine', ['ai'])).toEqual([]);
    expect(subjectsIn('this is about ai, mostly', ['ai'])).toEqual(['ai']);
  });

  it('measures overlap on distinctive words only', () => {
    expect(overlap('the model is not the hard part', 'the model is not the hard part')).toBe(1);
    expect(overlap('agent memory and identity', 'lunch was quite good today')).toBe(0);
  });
});

describe('fading', () => {
  it('halves an untouched item over its half-life', () => {
    const halfLife = ATTENTION_HALF_LIFE_DAYS.NARRATIVE;
    const then = new Date(now.getTime() - halfLife * 24 * 3_600_000).toISOString();
    expect(decayed(80, then, halfLife, now)).toBe(40);
  });

  it('leaves something just reinforced alone', () => {
    expect(decayed(80, now.toISOString(), 7, now)).toBe(80);
  });

  it('fades a narrative faster than a lesson', () => {
    const then = new Date(now.getTime() - 14 * 24 * 3_600_000).toISOString();
    const narrative = decayed(80, then, ATTENTION_HALF_LIFE_DAYS.NARRATIVE, now);
    const lesson = decayed(80, then, ATTENTION_HALF_LIFE_DAYS.LESSON, now);
    // A narrative is about what is happening; a lesson is about what turned out
    // to be true, and it should still be true a fortnight later.
    expect(lesson).toBeGreaterThan(narrative);
  });
});
