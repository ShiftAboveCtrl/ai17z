import { describe, expect, it } from 'vitest';
import { coordinationSignals, narrativeGenesis, publicProfile, relationshipGraph, type SuppliedPost } from '@xbam/runtime';

/**
 * Reading posts the caller supplies. What is pinned: findings rest on named
 * posts, a pattern is a signal with a strength and a caveat and never a claim
 * about a person, "earliest" is earliest in the set, and ordinary
 * conversation produces no coordination signal at all.
 */

const at = (minute: number) => new Date(Date.UTC(2026, 9, 10, 12, 0) + minute * 60_000).toISOString();
let n = 0;
const post = (authorId: string, text: string, minute: number, extra: Partial<SuppliedPost> = {}): SuppliedPost => ({ id: `p${(n += 1)}`, authorId, text, createdAt: at(minute), ...extra });

const TEMPLATE = 'The new token launch is the best opportunity of the year, do not miss it';

describe('coordination signals', () => {
  it('finds the same wording from many authors, and the minute they posted it in', () => {
    const posts = Array.from({ length: 6 }, (_, i) => post(`a${i}`, `${TEMPLATE} https://x.example/${i} @someone`, i === 5 ? 30 : 0.1 * i));
    const { signals, caveat } = coordinationSignals(posts);
    const reuse = signals.find((s) => s.kind === 'TEMPLATE_REUSE')!;
    expect(reuse).toMatchObject({ strength: 'MODERATE' });
    expect(reuse.authors).toHaveLength(6);
    const sync = signals.find((s) => s.kind === 'SYNCHRONIZED_POSTING')!;
    expect(sync.authors).toHaveLength(5);
    expect(caveat).toMatch(/not findings about anybody/);
  });

  it('says nothing about ordinary conversation', () => {
    const posts = [
      post('a', 'I think the pool is deeper than it looks this week', 0),
      post('b', 'Honestly the fees on that chain are still too high for me', 1),
      post('c', 'Anyone tried the new bridge yet, how long did it take', 2),
      post('d', 'Same wording here once is just a coincidence and nothing else', 3),
    ];
    expect(coordinationSignals(posts).signals).toEqual([]);
  });

  it('does not count one author repeating themselves', () => {
    const posts = Array.from({ length: 5 }, (_, i) => post('same', TEMPLATE, i));
    expect(coordinationSignals(posts).signals).toEqual([]);
  });

  it('notices amplification concentrated in a few accounts', () => {
    const original = post('origin', 'An announcement worth reading about the release', 0);
    const posts = [original, ...Array.from({ length: 12 }, (_, i) => post(i < 10 ? `amp${i % 2}` : `other${i}`, '', i + 1, { repostOf: { postId: original.id, authorId: 'origin' } }))];
    const amp = coordinationSignals(posts).signals.find((s) => s.kind === 'CONCENTRATED_AMPLIFICATION');
    expect(amp?.authors).toContain('amp0');
  });
});

describe('narrative genesis', () => {
  it('finds the earliest post in the set and how the wording changed', () => {
    const posts = [
      post('b', 'Heard that the restaking yields are being cut', 30),
      post('a', 'Restaking yields cut next week, says the team', 0),
      post('c', 'so restaking yields cut, again', 90),
    ];
    const r = narrativeGenesis(posts, 'restaking yields');
    expect(r.earliest).toMatchObject({ authorId: 'a', at: at(0) });
    expect(r.matched).toBe(3);
    expect(r.variants.map((v) => v.postId)).toEqual([posts[1]!.id, posts[0]!.id, posts[2]!.id]);
    expect(r.propagation.reduce((x, h) => x + h.posts, 0)).toBe(3);
    expect(r.caveat).toMatch(/within the posts supplied/);
  });

  it('answers no match without inventing an origin', () => {
    expect(narrativeGenesis([post('a', 'nothing relevant', 0)], 'restaking')).toMatchObject({ matched: 0, earliest: null });
  });
});

describe('relationship graph', () => {
  it('counts replies, mentions, quotes and reposts between authors, never an author with itself', () => {
    const posts = [
      post('a', 'hi', 0, { replyTo: { authorId: 'b' }, mentions: ['b', 'c', 'a'] }),
      post('a', 'again', 5, { replyTo: { authorId: 'b' } }),
      post('c', 'look', 6, { quoteOf: { authorId: 'a' } }),
    ];
    const g = relationshipGraph(posts);
    expect(g.edges.find((e) => e.from === 'a' && e.to === 'b' && e.kind === 'REPLY')).toMatchObject({ count: 2, firstAt: at(0), lastAt: at(5) });
    expect(g.edges.some((e) => e.from === e.to)).toBe(false);
    expect(g.nodes.sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('a public profile', () => {
  it('measures writing and topics, and claims nothing about the person', () => {
    const posts = [
      post('x', 'Liquidity on the bridge is thin today?', 0),
      post('x', 'Bridge liquidity improved after the update https://example.com', 10),
      post('x', 'Thinking about bridge fees again?', 20, { replyTo: { authorId: 'y' } }),
      post('y', 'unrelated', 21),
    ];
    const p = publicProfile(posts, 'x')!;
    expect(p.posts).toBe(3);
    expect(p.topics[0]).toEqual({ term: 'bridge', posts: 3 });
    expect(p.style).toMatchObject({ questionShare: 0.67, linkShare: 0.33, replyShare: 0.33 });
    expect(p.caveat).toMatch(/nothing about the person/);
    expect(Object.keys(p).sort()).toEqual(['authorId', 'caveat', 'posts', 'span', 'style', 'topics']);
  });

  it('returns nothing for an author with no posts in the set', () => {
    expect(publicProfile([post('x', 'hello there', 0)], 'nobody')).toBeNull();
  });
});
