import { describe, expect, it } from 'vitest';
import {
  CONTROL_EVERY_WHILE_TESTING,
  MIN_EVIDENCE,
  featuresOf,
  judgeTrial,
  nextConfidence,
  preferenceFrom,
  reachOf,
  rewardOf,
  variantFor,
} from '@xbam/runtime';

/**
 * Learning from what happened, and testing what was learned before trusting it.
 *
 * The readings were always collected: every published reply is revisited and
 * its views, likes and replies recorded. Nothing connected a reading to the
 * choices behind the reply, so an agent changed whom it avoided and never how
 * it chose.
 */

describe('scoring one outcome', () => {
  it('weights what a reader chose to give over what they could not avoid', () => {
    const viewed = reachOf({ views: 1000, likes: 0, reposts: 0, replies: 0, quotes: 0, bookmarks: 0 })!;
    const reposted = reachOf({ views: 100, likes: 5, reposts: 3, replies: 2, quotes: 0, bookmarks: 0 })!;
    expect(reposted).toBeGreaterThan(viewed);
  });

  it('says nothing when nothing was read, rather than calling it zero', () => {
    expect(reachOf({ views: null, likes: null, reposts: null, replies: null, quotes: null, bookmarks: null })).toBeNull();
  });

  it('places a score among the agent\'s own, and stays near the middle with little history', () => {
    expect(rewardOf(10, [])).toBe(0.5);
    const history = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(rewardOf(20, history)).toBeGreaterThan(0.9);
    expect(rewardOf(0, history)).toBeLessThan(0.1);
  });
});

describe('what the outcome is credited to', () => {
  const base = { type: 'REPLY', text: 'short one', executedAt: '2026-09-27T20:00:00Z', learningMeta: null };

  it('knows how the post it answered was found', () => {
    expect(featuresOf({ ...base, eventType: 'KEYWORD_MATCH', eventPayload: { community: { watched: 'Founder', kind: 'REPLY' } } }).mode).toBe('COMMUNITY');
    expect(featuresOf({ ...base, eventType: 'KEYWORD_MATCH', eventPayload: { community: { watched: 'Founder', kind: 'CIRCLE' } } }).mode).toBe('CIRCLE');
    expect(featuresOf({ ...base, eventType: 'KEYWORD_MATCH', eventPayload: {} }).mode).toBe('TOPIC');
    expect(featuresOf({ ...base, eventType: 'MENTION', eventPayload: {} }).mode).toBe('DIRECT');
    expect(featuresOf({ ...base, type: 'POST', eventType: 'SCHEDULED_TRIGGER', eventPayload: {} }).mode).toBe('POST');
  });

  it('files length, asking and audience', () => {
    const f = featuresOf({ ...base, text: 'what made you pick that pool?', eventType: 'KEYWORD_MATCH', eventPayload: { author: { followers: 4200 } } });
    expect(f).toMatchObject({ length: 'SHORT', question: 'ASKS', audience: 'MID' });
  });

  it('records which side of a trial produced it, from discovery and from the draft', () => {
    const f = featuresOf({
      ...base,
      eventType: 'KEYWORD_MATCH',
      eventPayload: { learning: { variants: { mode: 'learned' } } },
      learningMeta: { variants: { length: 'control' } },
    });
    expect(f.variants).toEqual({ mode: 'learned', length: 'control' });
  });
});

describe('when a change is worth testing', () => {
  const arms = (short: number, medium: number) => [
    { arm: 'SHORT', trials: 10, reward: short * 10 },
    { arm: 'MEDIUM', trials: 10, reward: medium * 10 },
  ];

  it('prefers an option that clearly beats the choice\'s average', () => {
    expect(preferenceFrom('length', arms(0.8, 0.4))?.arm).toBe('SHORT');
  });

  it('does not move on a small difference', () => {
    expect(preferenceFrom('length', arms(0.52, 0.48))).toBeNull();
  });

  it('does not move on thin evidence', () => {
    expect(preferenceFrom('length', [{ arm: 'SHORT', trials: MIN_EVIDENCE - 1, reward: MIN_EVIDENCE - 1 }, { arm: 'MEDIUM', trials: 1, reward: 0 }])).toBeNull();
  });

  it('needs more evidence on a choice it has been wrong about, and less on one it has been right about', () => {
    const modest = arms(0.62, 0.45);
    expect(preferenceFrom('length', modest, 0.4)).toBeNull();
    expect(preferenceFrom('length', modest, 2)?.arm).toBe('SHORT');
  });

  it('never moves towards something it only observes', () => {
    // Direct messages are answered whatever; there is nothing to choose.
    expect(preferenceFrom('mode', [{ arm: 'DIRECT', trials: 30, reward: 29 }, { arm: 'TOPIC', trials: 30, reward: 3 }])).toBeNull();
  });
});

describe('deciding a trial', () => {
  const now = new Date('2026-09-30T00:00:00Z');
  const started = '2026-09-28T00:00:00Z';

  it('waits for enough on both sides', () => {
    expect(judgeTrial({ applied: [0.7, 0.8], held: [0.4] }, started, now).decided).toBe(false);
  });

  it('keeps a change that did at least as well as the control', () => {
    const verdict = judgeTrial({ applied: Array(8).fill(0.7), held: [0.5, 0.5, 0.5] }, started, now);
    expect(verdict).toMatchObject({ decided: true, kept: true });
  });

  it('undoes a change that did worse', () => {
    const verdict = judgeTrial({ applied: Array(8).fill(0.3), held: [0.6, 0.6, 0.6] }, started, now);
    expect(verdict).toMatchObject({ decided: true, kept: false });
  });

  it('decides on what it has once a trial has run long enough', () => {
    const verdict = judgeTrial({ applied: [0.8, 0.9], held: [] }, '2026-09-10T00:00:00Z', now);
    expect(verdict).toMatchObject({ decided: true, kept: true });
  });
});

describe('trusting its own changes', () => {
  it('rises when a change was kept and falls when one was undone, within bounds', () => {
    expect(nextConfidence(1, true)).toBeGreaterThan(1);
    expect(nextConfidence(1, false)).toBeLessThan(1);
    expect(nextConfidence(2, true)).toBe(2);
    expect(nextConfidence(0.4, false)).toBe(0.4);
  });
});

describe('the control', () => {
  it('keeps the old behaviour running for about one decision in five while testing, and repeats itself for the same decision', () => {
    const keys = Array.from({ length: 2000 }, (_, i) => `job-${i}`);
    const control = keys.filter((k) => variantFor(k, 'RUNNING') === 'control').length;
    expect(control / keys.length).toBeGreaterThan(1 / CONTROL_EVERY_WHILE_TESTING - 0.04);
    expect(control / keys.length).toBeLessThan(1 / CONTROL_EVERY_WHILE_TESTING + 0.04);
    expect(variantFor('job-7', 'RUNNING')).toBe(variantFor('job-7', 'RUNNING'));
  });
});

describe('what the learner counts as a good outcome', () => {
  const base = { views: 500, likes: 4, reposts: 0, replies: 20, quotes: 0, bookmarks: 0 };

  it('does not reward spam replies', () => {
    const flooded = reachOf({ ...base, spamReplies: 20, humanRepliers: 0 })!;
    const clean = reachOf({ ...base, replies: 0, spamReplies: 0, humanRepliers: 0 })!;
    expect(flooded).toBeCloseTo(clean, 5);
  });

  it('values one real conversation above a pile of reactions', () => {
    const conversation = reachOf({ ...base, likes: 2, replies: 3, humanRepliers: 3 })!;
    const reactions = reachOf({ ...base, likes: 12, replies: 3, humanRepliers: 0 })!;
    expect(conversation).toBeGreaterThan(reactions);
  });
});
