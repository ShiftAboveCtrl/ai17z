import { describe, expect, it } from 'vitest';
import { readNarratives, termsIn, type NarrativePost } from '@xbam/runtime';

/**
 * Detecting what a lot of people have started talking about.
 *
 * Any bag of text produces a ranked list of words, and a ranked list of words
 * looks exactly like an insight. These tests pin the three refusals that keep
 * this from being one: one account repeating itself is not a narrative, a
 * bigger read is not a rising narrative, and a rise needs something to have
 * risen from.
 */

const now = new Date('2026-09-09T12:00:00.000Z');
const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000).toISOString();

/** n posts, each from a different account, saying the same thing. */
const chorus = (text: string, n: number, ago: number, prefix = 'acct'): NarrativePost[] =>
  Array.from({ length: n }, (_, i) => ({
    statusId: `${prefix}-${ago}-${i}`,
    handle: `${prefix}${i}`,
    text,
    postedAt: hoursAgo(ago),
  }));

describe('the subjects in a post', () => {
  it('keeps a cashtag whole and distinct from the bare word', () => {
    // "$eth" and "eth" are different claims, and collapsing them loses which
    // was written.
    expect(termsIn('watching $ETH here')).toContain('$eth');
    expect(termsIn('watching $ETH here')).not.toContain('eth');
  });

  it('drops handles, links and the words that carry no subject', () => {
    const terms = termsIn('thanks @alice for this https://example.com/a rollups are the thing');
    expect(terms).not.toContain('alice');
    expect(terms).not.toContain('thanks');
    expect(terms).not.toContain('https');
    expect(terms).toContain('rollups');
  });

  it('counts a word once per post however often it was written', () => {
    // Rewarding repetition rewards spam.
    expect(termsIn('rollups rollups rollups').filter((t) => t === 'rollups')).toHaveLength(1);
  });
});

describe('reading narratives', () => {
  it('will not call one account repeating itself a narrative', () => {
    const posts: NarrativePost[] = Array.from({ length: 14 }, (_, i) => ({
      statusId: `s${i}`,
      handle: 'loudaccount',
      text: 'restaking is the only thing that matters',
      postedAt: hoursAgo(1),
    }));
    const { narratives } = readNarratives(posts, { now });
    expect(narratives.find((n) => n.term === 'restaking')).toBeUndefined();
  });

  it('reports a subject several accounts are using', () => {
    const { narratives } = readNarratives(
      [...chorus('restaking yields are compressing', 14, 1)],
      { now },
    );
    const found = narratives.find((n) => n.term === 'restaking');
    expect(found).toBeDefined();
    expect(found!.authors).toBe(14);
    expect(found!.examples.length).toBeGreaterThan(0);
  });

  it('says nothing at all from too few posts', () => {
    const { narratives, gaps } = readNarratives(chorus('restaking again', 4, 1), { now });
    expect(narratives).toHaveLength(0);
    expect(gaps.join(' ')).toMatch(/fewest worth drawing/);
  });

  it('says these are present, not rising, when nothing older was read', () => {
    const { narratives, gaps } = readNarratives(chorus('restaking yields are compressing', 14, 1), { now });
    expect(gaps.join(' ')).toMatch(/present rather than/);
    expect(narratives[0]!.lift).toBeUndefined();
    expect(narratives[0]!.detail).toMatch(/accounts mentioned/);
  });

  it('measures share rather than count, so a bigger read is not a rising narrative', () => {
    // Twice as many posts means twice as many mentions of everything. The
    // share is unchanged and so is the verdict.
    const small = readNarratives(
      [...chorus('restaking yields compressing', 7, 1), ...chorus('unrelated musings about coffee beans', 7, 1, 'other')],
      { now },
    );
    const big = readNarratives(
      [
        ...chorus('restaking yields compressing', 14, 1),
        ...chorus('unrelated musings about coffee beans', 14, 1, 'other'),
      ],
      { now },
    );
    expect(small.narratives.find((n) => n.term === 'restaking')!.share).toBeCloseTo(
      big.narratives.find((n) => n.term === 'restaking')!.share,
      3,
    );
  });

  it('calls something that was not there before what it is', () => {
    const { narratives } = readNarratives(
      [
        ...chorus('sequencer downtime again', 14, 1),
        ...chorus('quiet morning reading the docs', 14, 8, 'earlier'),
      ],
      { now },
    );
    const found = narratives.find((n) => n.term === 'sequencer');
    // A flag rather than an infinite ratio: `Infinity` serialises to `null`,
    // which by the time it reaches a screen is indistinguishable from a lift
    // nobody computed.
    expect(found!.newlySeen).toBe(true);
    expect(found!.lift).toBeUndefined();
    expect(found!.detail).toMatch(/was not mentioned in the previous/);
  });

  it('puts what is rising above what is merely large', () => {
    const { narratives } = readNarratives(
      [
        // Steady: same share before and after.
        ...chorus('rollups are interesting today', 14, 1),
        ...chorus('rollups are interesting today', 14, 8, 'earlier'),
        // New: only in the recent window.
        ...chorus('sequencer downtime again', 12, 2, 'newish'),
      ],
      { now },
    );
    // Rollups is in more posts and by more accounts. Sequencer is the one that
    // was not being said this morning, which is the whole question.
    const rank = (term: string) => narratives.findIndex((n) => n.term === term);
    expect(rank('sequencer')).toBeGreaterThanOrEqual(0);
    expect(rank('sequencer')).toBeLessThan(rank('rollups'));
  });

  it('says how many posts it could not place', () => {
    const { gaps } = readNarratives(
      [...chorus('restaking yields compressing', 14, 1), { statusId: 'x', handle: 'a', text: 'no timestamp here' }],
      { now },
    );
    expect(gaps.join(' ')).toMatch(/had no timestamp/);
  });
});
