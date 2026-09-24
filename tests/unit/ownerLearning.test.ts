import { describe, expect, it } from 'vitest';
import {
  MAX_ADJUSTMENT,
  REJECTION_COOLDOWN_DAYS,
  decisionFingerprint,
  rankingAdjustment,
  suppressedByRejection,
  type Signal,
} from '@xbam/runtime';

/**
 * What the owner keeps saying yes and no to.
 *
 * Strictly about order. The one property that has to hold above all the others
 * is that nothing here can become an authority: no amount of accepting makes
 * an agent allowed to do something, and no amount of rejecting removes an
 * approval anybody still needs to give. Permission lives in
 * `agent_capability_permissions` and the approval gate, and this file cannot
 * reach either.
 */

const DAY = 24 * 60 * 60_000;
const now = Date.UTC(2026, 8, 24, 12, 0, 0);
const daysAgo = (n: number) => new Date(now - n * DAY).toISOString();

const signal = (over: Partial<Signal> = {}): Signal => ({
  accepted: 0,
  rejected: 0,
  lastDecisionAt: daysAgo(0),
  ...over,
});

describe('ranking moves with what the owner decided', () => {
  it('does nothing at all without history', () => {
    expect(rankingAdjustment(null, now)).toBe(0);
    expect(rankingAdjustment(signal(), now)).toBe(0);
  });

  it('raises what the owner keeps accepting', () => {
    expect(rankingAdjustment(signal({ accepted: 4 }), now)).toBeGreaterThan(0);
  });

  it('lowers what the owner keeps refusing', () => {
    expect(rankingAdjustment(signal({ rejected: 4 }), now)).toBeLessThan(0);
  });

  it('treats one decision as weaker than a settled pattern', () => {
    // One rejection is somebody having an off day. Four is a preference.
    const once = Math.abs(rankingAdjustment(signal({ rejected: 1 }), now));
    const settled = Math.abs(rankingAdjustment(signal({ rejected: 4 }), now));
    expect(once).toBeLessThan(settled);
  });

  it('stays inside its bound however lopsided the history', () => {
    // The ordering is meant to be decided by what the decision *is*. This is a
    // nudge inside that, and must never be able to overturn it.
    expect(rankingAdjustment(signal({ accepted: 500 }), now)).toBeLessThanOrEqual(MAX_ADJUSTMENT);
    expect(rankingAdjustment(signal({ rejected: 500 }), now)).toBeGreaterThanOrEqual(-MAX_ADJUSTMENT);
  });

  it('fades, so one good week cannot decide next year', () => {
    const fresh = rankingAdjustment(signal({ accepted: 6, lastDecisionAt: daysAgo(0) }), now);
    const old = rankingAdjustment(signal({ accepted: 6, lastDecisionAt: daysAgo(120) }), now);
    expect(old).toBeLessThan(fresh);
    expect(Math.abs(old)).toBeLessThanOrEqual(1);
  });

  it('cancels out when the owner has been split', () => {
    expect(rankingAdjustment(signal({ accepted: 5, rejected: 5 }), now)).toBe(0);
  });
});

describe('a refusal is not asked again straight away', () => {
  it('suppresses a substantially identical proposal', () => {
    const held = suppressedByRejection(
      { signal: signal({ rejected: 1, lastRejectedAt: daysAgo(1) }) },
      now,
    );
    expect(held.suppressed).toBe(true);
    expect(held.reason).toMatch(/turned down/i);
    expect(held.until).not.toBeNull();
  });

  it('lets it back after the cooldown', () => {
    const free = suppressedByRejection(
      { signal: signal({ rejected: 1, lastRejectedAt: daysAgo(REJECTION_COOLDOWN_DAYS + 1) }) },
      now,
    );
    expect(free.suppressed).toBe(false);
  });

  it('defaults to seven days', () => {
    expect(REJECTION_COOLDOWN_DAYS).toBe(7);
    expect(suppressedByRejection({ signal: signal({ rejected: 1, lastRejectedAt: daysAgo(6) }) }, now).suppressed).toBe(
      true,
    );
    expect(suppressedByRejection({ signal: signal({ rejected: 1, lastRejectedAt: daysAgo(8) }) }, now).suppressed).toBe(
      false,
    );
  });

  it('lets something genuinely different through early', () => {
    /*
      The escape hatch has to be real. Without it somebody who writes in after
      being declined once is silently ignored for a week, which is a worse
      fault than the repetition this exists to stop.
    */
    const changed = suppressedByRejection(
      { signal: signal({ rejected: 2, lastRejectedAt: daysAgo(1) }), materiallyChanged: true },
      now,
    );
    expect(changed.suppressed).toBe(false);
    expect(changed.reason).toMatch(/something real about it has changed/i);
  });

  it('does not suppress something that was only ever accepted', () => {
    expect(suppressedByRejection({ signal: signal({ accepted: 3 }) }, now).suppressed).toBe(false);
  });

  it('does not suppress something with no history', () => {
    expect(suppressedByRejection({ signal: null }, now).suppressed).toBe(false);
  });
});

describe('what counts as the same question', () => {
  it('is built from structure, never from wording', () => {
    const a = decisionFingerprint({ kind: 'KEYWORD_MATCH', actionType: 'REPLY', handle: '@Someone' });
    const b = decisionFingerprint({ kind: 'KEYWORD_MATCH', actionType: 'REPLY', handle: 'someone' });
    // Rewording a draft does not make it a new question, and neither does a
    // capital letter in a handle.
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('separates a mention from an approach', () => {
    const mention = decisionFingerprint({ kind: 'MENTION', actionType: 'REPLY', handle: 'someone' });
    const approach = decisionFingerprint({ kind: 'KEYWORD_MATCH', actionType: 'REPLY', handle: 'someone' });
    expect(mention.fingerprint).not.toBe(approach.fingerprint);
    expect(mention.family).not.toBe(approach.family);
  });

  it('keeps a family a new person can inherit from', () => {
    const one = decisionFingerprint({ kind: 'KEYWORD_MATCH', actionType: 'REPLY', handle: 'alice' });
    const two = decisionFingerprint({ kind: 'KEYWORD_MATCH', actionType: 'REPLY', handle: 'bob' });
    expect(one.fingerprint).not.toBe(two.fingerprint);
    expect(one.family).toBe(two.family);
  });
});

describe('the boundary this must never cross', () => {
  it('returns a number and a sentence, and nothing that could be a permission', () => {
    /*
      Pinned as a shape rather than a promise. A preference system that can
      quietly become an authority system is the thing to never build, and the
      way to not build it is to have nothing here that a caller could mistake
      for a grant.
    */
    const adjustment = rankingAdjustment(signal({ accepted: 99 }), now);
    expect(typeof adjustment).toBe('number');

    const suppression = suppressedByRejection({ signal: signal({ rejected: 99, lastRejectedAt: daysAgo(0) }) }, now);
    expect(Object.keys(suppression).sort()).toEqual(['reason', 'suppressed', 'until']);
    expect(typeof suppression.suppressed).toBe('boolean');
    // Suppression withholds a question. It never answers one.
    expect(JSON.stringify(suppression)).not.toMatch(/approv|permit|grant|allow/i);
  });
});
