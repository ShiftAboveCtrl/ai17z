import { describe, expect, it } from 'vitest';
import { parseCounts } from '@xbam/channels';

/**
 * The counts X puts in one aria-label under a post.
 *
 * Read from the label rather than from four separate spans, because X hides an
 * individual count when it is zero and still names it in the label. So the
 * label is the only place that distinguishes "nobody replied" from "we could
 * not see how many replied", and that distinction is the whole point: an agent
 * told a post has no views will say so.
 *
 * Worth its own test because the first version was written through a shell
 * heredoc, which ate the backslashes -- the pattern became `[d.,]` and matched
 * a literal letter d rather than a digit. It compiled, it ran, and it found
 * nothing.
 */
describe('reading the counts under a post', () => {
  it('reads what X actually writes', () => {
    const label = '12 replies, 3 reposts, 40 likes, 5 bookmarks, 1,205 views';
    expect(parseCounts(label)).toEqual({
      replies: 12,
      reposts: 3,
      likes: 40,
      bookmarks: 5,
      views: 1205,
    });
  });

  it('reads the singular forms, which is what a post with one of something says', () => {
    expect(parseCounts('1 reply, 1 repost, 1 like, 1 view')).toEqual({
      replies: 1,
      reposts: 1,
      likes: 1,
      views: 1,
    });
  });

  it('reads abbreviated counts', () => {
    expect(parseCounts('2.4K reposts, 18.2K likes, 1.1M views')).toEqual({
      reposts: 2400,
      likes: 18200,
      views: 1_100_000,
    });
  });

  it('leaves out what the label never mentioned', () => {
    // Absent is not zero. A post whose label says nothing about bookmarks has
    // an unknown number of them, and inventing zero would be a claim.
    const counts = parseCounts('7 likes');
    expect(counts).toEqual({ likes: 7 });
    expect('bookmarks' in counts).toBe(false);
    expect('views' in counts).toBe(false);
  });

  it('says nothing at all when there was no label', () => {
    expect(parseCounts(null)).toEqual({});
    expect(parseCounts(undefined)).toEqual({});
    expect(parseCounts('')).toEqual({});
  });

  it('matches digits rather than the letter d', () => {
    // The exact failure a mangled escape produced: a pattern that compiles,
    // runs, and matches nothing that is actually a number.
    expect(parseCounts('40 likes').likes).toBe(40);
    expect(parseCounts('d likes').likes).toBeUndefined();
  });
});
