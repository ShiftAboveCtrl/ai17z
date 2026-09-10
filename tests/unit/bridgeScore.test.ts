import { describe, expect, it } from 'vitest';
import { rankBridges, scoreBridge, type BridgeInput } from '@xbam/runtime';

/**
 * What a bridge score is, and what it must never become.
 *
 * `contracts/relationship.ts` says familiarity is "not as a score for deciding
 * whose message is worth more, and not as a measure of anybody's value". This
 * sits on the other side of that line: it ranks conversations the agent might
 * start, which is a question about the agent's own attention. These tests pin
 * the properties that keep it there -- an owner instruction outranks every
 * measurement, and a score built on nothing says so instead of looking
 * confident.
 */

const base: BridgeInput = { handle: 'alice' };
const now = new Date('2026-09-09T12:00:00.000Z');

describe('scoring a bridge', () => {
  it('rates somebody who leads somewhere new above somebody who does not', () => {
    // The distinctive half. Same reach, same reciprocity; the difference is
    // whether the audience behind them has already heard from this agent.
    const shared = { followerCount: 20_000, ourFollowerCount: 2_000, followsUs: true, weFollow: true };
    const newRoom = scoreBridge({ ...base, ...shared, neighbours: 20, neighboursWeKnow: 0 }, now);
    const sameRoom = scoreBridge({ ...base, ...shared, neighbours: 20, neighboursWeKnow: 20 }, now);
    expect(newRoom.value).toBeGreaterThan(sameRoom.value);
    expect(newRoom.factors.find((f) => f.name === 'novelty')!.points).toBeGreaterThan(0);
    expect(sameRoom.factors.find((f) => f.name === 'novelty')!.points).toBe(0);
  });

  it('does not let one enormous account outrank everything else combined', () => {
    // Linear reach is how automated outreach ends up talking exclusively at
    // people who will never answer.
    const huge = scoreBridge(
      { ...base, followerCount: 5_000_000, ourFollowerCount: 1_000, neighbours: 10, neighboursWeKnow: 10 },
      now,
    );
    const modest = scoreBridge(
      {
        ...base,
        followerCount: 4_000,
        ourFollowerCount: 1_000,
        neighbours: 10,
        neighboursWeKnow: 0,
        followsUs: true,
        weFollow: true,
        inboundCount: 4,
      },
      now,
    );
    expect(modest.value).toBeGreaterThan(huge.value);
  });

  it('counts being answered, and counts not being answered against', () => {
    const answered = scoreBridge({ ...base, inboundCount: 3, outboundCount: 3 }, now);
    const ignored = scoreBridge({ ...base, inboundCount: 0, outboundCount: 3 }, now);
    expect(answered.value).toBeGreaterThan(ignored.value);
    expect(ignored.factors.find((f) => f.name === 'unanswered')!.points).toBeLessThan(0);
  });

  it('treats an owner instruction as an end to the question', () => {
    // Not a low score that a large follower count can outweigh.
    const blocked = scoreBridge(
      { ...base, disposition: 'BLOCKED', followerCount: 5_000_000, ourFollowerCount: 100, neighbours: 50 },
      now,
    );
    expect(blocked.blocked).toBe(true);
    expect(blocked.value).toBe(0);
    expect(blocked.band).toBe('NONE');
  });

  it('says what it could not measure rather than scoring it as absent', () => {
    // A score resting on three gaps is a guess, and it has to look like one.
    const blind = scoreBridge(base, now);
    expect(blind.gaps.length).toBeGreaterThanOrEqual(3);
    expect(blind.factors.every((f) => f.detail.length > 0)).toBe(true);
  });

  it('carries a readable sentence for every factor', () => {
    // "Reply value 18" tells nobody anything.
    const score = scoreBridge(
      { ...base, followerCount: 10_000, ourFollowerCount: 1_000, followsUs: true, neighbours: 8, neighboursWeKnow: 2 },
      now,
    );
    for (const factor of score.factors) {
      expect(factor.detail).toMatch(/[a-z]/i);
      expect(factor.name).not.toBe('');
    }
  });

  it('marks a relationship that has gone quiet', () => {
    const quiet = scoreBridge({ ...base, inboundCount: 2, lastInteractionAt: '2026-05-01T00:00:00.000Z' }, now);
    expect(quiet.factors.find((f) => f.name === 'gone-quiet')).toBeDefined();
  });
});

describe('ranking bridges', () => {
  it('puts the measured one first when two scores tie', () => {
    // Two accounts on the same number are not equally well understood.
    const measured = scoreBridge(
      { handle: 'measured', followerCount: 1_000, ourFollowerCount: 1_000, neighbours: 4, neighboursWeKnow: 4, followsUs: true },
      now,
    );
    const guessed = scoreBridge({ handle: 'guessed', followsUs: true }, now);
    expect(measured.value).toBe(guessed.value);
    expect(rankBridges([guessed, measured])[0]!.handle).toBe('measured');
  });
});
