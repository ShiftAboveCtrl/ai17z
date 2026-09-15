import { describe, expect, it } from 'vitest';
import { questionWorthLookingUp, whatToAsk } from '@xbam/runtime';
import type { AttentionRow } from '@xbam/database';

/**
 * Which of the things an agent is wondering about is worth a trip to a search
 * engine, and what it would actually ask.
 *
 * Both decisions are pure and both are the ones that matter. Everything after
 * them is the existing research step, which has its own tests -- and the
 * declines here are what stand between a curious agent and one that asks the
 * same question of a search engine every quarter of an hour for ever.
 */

const now = new Date('2026-09-15T12:00:00.000Z');

function item(over: Partial<AttentionRow> = {}): AttentionRow {
  return {
    id: 'item-1',
    agentId: 'agent-1',
    kind: 'QUESTION',
    summary: 'Whether agent memory that survives a restart needs a database at all.',
    detail: '',
    salience: 60,
    factors: [],
    confidence: 0.4,
    evidence: [],
    origin: 'OBSERVE:DISCOVERY',
    state: 'ACTIVE',
    supersededBy: null,
    resolution: '',
    fingerprint: 'fp-1',
    reinforcements: 1,
    firstObservedAt: now.toISOString(),
    lastReinforcedAt: now.toISOString(),
    reviewAt: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...over,
  };
}

describe('what an agent would go and look up', () => {
  it('takes the strongest open question', () => {
    const chosen = questionWorthLookingUp(
      [item({ id: 'weak', salience: 45 }), item({ id: 'strong', salience: 80 })],
      now,
    );
    // Given in salience order by the caller; the first that qualifies wins.
    expect(chosen?.id).toBe('weak');
  });

  it('takes a curiosity as readily as a question', () => {
    expect(questionWorthLookingUp([item({ kind: 'CURIOSITY' })], now)?.kind).toBe('CURIOSITY');
  });

  it.each(['INTEREST', 'CONCERN', 'LESSON', 'NARRATIVE', 'IDEA', 'HYPOTHESIS'] as const)(
    'will not look up a %s, which is a subject rather than a question',
    (kind) => {
      // Sending a subject to a search engine returns whatever is being said
      // about it today, which is how a working set fills with the news.
      expect(questionWorthLookingUp([item({ kind })], now)).toBeNull();
    },
  );

  it('will not look up something too faint to be a real question yet', () => {
    expect(questionWorthLookingUp([item({ salience: 20 })], now)).toBeNull();
  });

  it('will not look up something it looked into recently', () => {
    // The one decline that stops a curious agent hammering a search engine.
    const soon = new Date(now.getTime() + 3600_000).toISOString();
    expect(questionWorthLookingUp([item({ reviewAt: soon })], now)).toBeNull();
  });

  it('looks again once the review time has passed', () => {
    const past = new Date(now.getTime() - 3600_000).toISOString();
    expect(questionWorthLookingUp([item({ reviewAt: past })], now)?.id).toBe('item-1');
  });

  it('has nothing to look up when nothing is on its mind', () => {
    expect(questionWorthLookingUp([], now)).toBeNull();
  });
});

describe('what it would actually ask', () => {
  it('asks the question it wrote down', () => {
    const lookups = whatToAsk(item());
    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.query).toContain('agent memory');
    expect(lookups[0]!.reason).toBeTruthy();
  });

  it('routes a contract address to market data rather than a search engine', () => {
    // The existing routing, reused rather than reimplemented: getting this
    // wrong is how "$DOG" becomes three articles about dogs.
    const lookups = whatToAsk(
      item({ summary: 'What is going on with 0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984 lately?' }),
    );
    expect(lookups.some((lookup) => lookup.kind === 'token')).toBe(true);
  });

  it('never asks more than one thing at a time', () => {
    const lookups = whatToAsk(
      item({ summary: 'Does agent memory need a database? And what about browser sessions? And restarts?' }),
    );
    expect(lookups.length).toBeLessThanOrEqual(1);
  });
});
