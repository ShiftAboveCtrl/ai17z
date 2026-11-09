import { describe, expect, it } from 'vitest';
import {
  BLUESKY_MAX_POST_GRAPHEMES,
  blueskyLengthProblem,
  buildBlueskyFacets,
  detectBlueskySpans,
  graphemeCount,
  parseAtUri,
  parseBlueskyPostReference,
} from '@xbam/channels';

describe('the length of a Bluesky post', () => {
  it('counts what a person sees, not UTF-16 units', () => {
    expect(graphemeCount('abc')).toBe(3);
    // One family emoji is one character to a reader and eleven code units.
    expect(graphemeCount('👨‍👩‍👧‍👦')).toBe(1);
    expect(graphemeCount('é')).toBe(1);
  });

  it('allows exactly 300 and refuses 301, without shortening anything', () => {
    expect(blueskyLengthProblem('a'.repeat(BLUESKY_MAX_POST_GRAPHEMES))).toBeNull();
    expect(blueskyLengthProblem('a'.repeat(BLUESKY_MAX_POST_GRAPHEMES + 1))).toMatch(/301 characters/);
    expect(blueskyLengthProblem('   ')).toMatch(/empty/);
  });

  it('refuses a post that fits in graphemes but not in bytes', () => {
    // 300 four-byte emoji is 1200 bytes; 300 family emoji is far more than 3000.
    expect(blueskyLengthProblem('👨‍👩‍👧‍👦'.repeat(300))).toMatch(/bytes/);
  });
});

describe('what in a post is more than text', () => {
  it('finds mentions, links and tags, and leaves a bare domain alone', () => {
    const spans = detectBlueskySpans('hi @alice.test see https://example.com/a?b=1, #birds and not.sure');
    expect(spans.map((s) => s.kind)).toEqual(['mention', 'link', 'tag']);
    const link = spans.find((s) => s.kind === 'link')!;
    // The comma after a link belongs to the sentence.
    expect(link.kind === 'link' && link.uri).toBe('https://example.com/a?b=1');
  });

  it('does not read an email address or a path as a mention', () => {
    expect(detectBlueskySpans('mail me@example.com or https://x.test/@foo.bar')).toEqual([
      expect.objectContaining({ kind: 'link' }),
    ]);
  });

  it('uses UTF-8 byte offsets, which is where emoji go wrong', async () => {
    const text = '🎉 hi @alice.test';
    const facets = await buildBlueskyFacets(text, async (handle) => (handle === 'alice.test' ? 'did:plc:alice' : null));
    expect(facets).toHaveLength(1);
    // 🎉 is four bytes, then " hi " is four more: the mention starts at byte 8
    // and "@alice.test" is eleven bytes. A UTF-16 offset would say 5.
    expect(facets[0]!.index).toEqual({ byteStart: 8, byteEnd: 19 });
    expect(Buffer.from(text).subarray(8, 19).toString('utf8')).toBe('@alice.test');
    expect(facets[0]!.features[0]).toEqual({ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:alice' });
  });

  it('leaves a mention as text when it does not resolve, so nobody is mentioned by mistake', async () => {
    const facets = await buildBlueskyFacets('hello @nobody.test', async () => null);
    expect(facets).toEqual([]);
  });

  it('survives the resolver failing', async () => {
    const facets = await buildBlueskyFacets('hello @alice.test https://example.com', async () => {
      throw new Error('network');
    });
    expect(facets.map((f) => f.features[0]!.$type)).toEqual(['app.bsky.richtext.facet#link']);
  });
});

describe('naming a post', () => {
  it('accepts an at:// post URI and a bsky.app address', () => {
    expect(parseBlueskyPostReference('at://did:plc:abc123/app.bsky.feed.post/3kabc')).toEqual({
      kind: 'uri',
      uri: 'at://did:plc:abc123/app.bsky.feed.post/3kabc',
    });
    expect(parseBlueskyPostReference('https://bsky.app/profile/alice.test/post/3kabc')).toEqual({
      kind: 'web',
      actor: 'alice.test',
      rkey: '3kabc',
    });
  });

  it('refuses everything that is not exactly one post', () => {
    for (const bad of [
      '@alice.test',
      'alice.test',
      'at://did:plc:abc123/app.bsky.feed.like/3kabc',
      'at://did:plc:abc123/app.bsky.feed.post/',
      'at://alice.test/app.bsky.feed.post/3kabc',
      'http://bsky.app/profile/alice.test/post/3kabc',
      'https://bsky.app.evil.example/profile/alice.test/post/3kabc',
      'https://bsky.app/profile/alice.test',
      'at://did:plc:abc123/app.bsky.feed.post/../x',
    ]) {
      expect(parseBlueskyPostReference(bad), bad).toBeNull();
    }
  });

  it('parses an at:// URI into its parts only when it is whole', () => {
    expect(parseAtUri('at://did:plc:abc123/app.bsky.feed.post/3kabc')).toEqual({
      repo: 'did:plc:abc123',
      collection: 'app.bsky.feed.post',
      rkey: '3kabc',
    });
    expect(parseAtUri('at://did:plc:abc123')).toBeNull();
  });
});
