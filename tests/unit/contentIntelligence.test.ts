import { describe, expect, it } from 'vitest';
import { engagementRate, readContentSignals, type PublishedPost } from '@xbam/runtime';

/**
 * What worked, and refusing to say when there is not enough to say it from.
 *
 * The whole risk of this feature is that it is easy to compute and easy to
 * believe. Six posts will produce a confident sentence about the ideal length
 * of a post, and somebody will rewrite their agent's voice on the strength of
 * it. These tests pin the three refusals that keep that from happening.
 */

const post = (over: Partial<PublishedPost> & { statusId: string }): PublishedPost => ({
  text: 'A statement of ordinary length about the thing that happened today.',
  publishedAt: '2026-09-01T09:00:00.000Z',
  impressions: 1_000,
  likes: 10,
  ...over,
});

/** n posts in a group, each with the engagement rate asked for. */
const group = (prefix: string, n: number, likesPerThousand: number, over: Partial<PublishedPost> = {}) =>
  Array.from({ length: n }, (_, i) =>
    post({ statusId: `${prefix}-${i}`, impressions: 1_000, likes: likesPerThousand, ...over }),
  );

describe('engagement rate', () => {
  it('is per thousand impressions, not a total', () => {
    // A post shown to ten thousand people and one shown to two hundred are not
    // comparable on likes.
    expect(engagementRate(post({ statusId: 'a', impressions: 10_000, likes: 50 }))).toBe(5);
    expect(engagementRate(post({ statusId: 'b', impressions: 200, likes: 50 }))).toBe(250);
  });

  it('is undefined when impressions were never read', () => {
    // Not zero. A post nobody measured is not a post that failed.
    expect(engagementRate(post({ statusId: 'a', impressions: undefined }))).toBeUndefined();
  });
});

describe('reading content signals', () => {
  it('says nothing at all from too few posts', () => {
    const signals = readContentSignals([
      ...group('short', 2, 40, { text: 'Short one.' }),
      ...group('long', 2, 5, { text: 'x'.repeat(200) }),
    ]);
    expect(signals.findings).toHaveLength(0);
    expect(signals.gaps.join(' ')).toMatch(/Not enough measured posts/);
  });

  it('finds a difference once there are enough posts on both sides', () => {
    const signals = readContentSignals([
      ...group('short', 6, 40, { text: 'Short and to the point.' }),
      ...group('long', 6, 8, { text: `${'word '.repeat(40)}` }),
    ]);
    const length = signals.findings.find((f) => f.dimension === 'LENGTH');
    expect(length).toBeDefined();
    expect(length!.label).toBe('Short posts');
    expect(length!.detail).toMatch(/% better/);
    expect(length!.sampleSize).toBe(6);
  });

  it('will not call a small difference a difference', () => {
    const signals = readContentSignals([
      ...group('short', 6, 21, { text: 'Short and to the point.' }),
      ...group('long', 6, 20, { text: `${'word '.repeat(40)}` }),
    ]);
    expect(signals.findings.find((f) => f.dimension === 'LENGTH')).toBeUndefined();
    expect(signals.gaps.join(' ')).toMatch(/about the same/);
  });

  it('is not moved by one post that got picked up', () => {
    // The reason this is a median. One post carried by a large account is ten
    // times every other post combined, and a mean turns that accident into a
    // rule.
    const signals = readContentSignals([
      ...group('short', 6, 20, { text: 'Short and to the point.' }),
      ...group('long', 5, 20, { text: `${'word '.repeat(40)}` }),
      post({ statusId: 'viral', text: `${'word '.repeat(40)}`, impressions: 1_000, likes: 900 }),
    ]);
    expect(signals.findings.find((f) => f.dimension === 'LENGTH')).toBeUndefined();
  });

  it('leaves unmeasured posts out rather than counting them as failures', () => {
    const signals = readContentSignals([
      ...group('short', 6, 40, { text: 'Short and to the point.' }),
      ...group('long', 6, 8, { text: `${'word '.repeat(40)}` }),
      post({ statusId: 'unknown', impressions: undefined, text: `${'word '.repeat(40)}` }),
    ]);
    expect(signals.total).toBe(13);
    expect(signals.measured).toBe(12);
    expect(signals.findings.find((f) => f.dimension === 'LENGTH')!.comparedSampleSize).toBe(6);
  });

  it('says so when nothing has been measured at all', () => {
    const signals = readContentSignals([post({ statusId: 'a', impressions: undefined })]);
    expect(signals.findings).toHaveLength(0);
    expect(signals.gaps[0]).toMatch(/impressions read/);
  });

  it('compares questions with statements', () => {
    const signals = readContentSignals([
      ...group('ask', 6, 60, { text: 'What is everybody actually using for this?' }),
      ...group('say', 6, 10, { text: 'This is what everybody is actually using for this.' }),
    ]);
    const question = signals.findings.find((f) => f.dimension === 'QUESTION');
    expect(question!.label).toBe('Posts that ask something');
  });

  it('splits the clock in two rather than into twenty-four empty buckets', () => {
    const signals = readContentSignals(
      [
        ...group('am', 6, 50, { publishedAt: '2026-09-01T08:00:00.000Z' }),
        ...group('pm', 6, 10, { publishedAt: '2026-09-01T20:00:00.000Z' }),
      ],
      { hourBuckets: true },
    );
    const hour = signals.findings.find((f) => f.dimension === 'HOUR');
    expect(hour!.label).toBe('Posts before midday');
  });

  it('makes no media claim when nothing recorded whether there was any', () => {
    const signals = readContentSignals(group('any', 12, 20));
    expect(signals.findings.find((f) => f.dimension === 'MEDIA')).toBeUndefined();
  });
});
