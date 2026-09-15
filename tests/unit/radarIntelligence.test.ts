import { describe, expect, it } from 'vitest';
import { pollViaIntelligence, radarPollResultFrom, toCandidates } from '@xbam/channels';
import type { XPostRecord, XReadResult } from '@xbam/channels';

/**
 * What the radar gets to keep when X answers for itself.
 *
 * The radar's monitors used to scroll a rendered page, and a drawn article
 * carries neither the author's numeric id nor an exact engagement count. Both
 * absences travelled downstream and cost real behaviour: relationship memory
 * could only key on a handle, so a rename split one person into two records;
 * and the opportunity engine's crowded/empty-thread factors had been written
 * for years with nothing ever able to populate them.
 *
 * These tests are about the trip, not the translation. Each one puts something
 * on a normalised post and asserts it is still there on the candidate the
 * reconciler will turn into an event -- because that is the boundary where it
 * was being lost.
 */

function post(over: Partial<XPostRecord> = {}): XPostRecord {
  return {
    postId: '1800000000000000001',
    authorId: '44196397',
    authorHandle: 'someone',
    text: 'a post with enough words in it to be a real one',
    createdAt: '2026-09-15T09:00:00.000Z',
    url: 'https://x.com/someone/status/1800000000000000001',
    conversationId: '1799999999999999999',
    replyToPostId: null,
    replyToUserId: null,
    quotedPostId: null,
    repost: false,
    lang: 'en',
    metrics: { replies: 2, reposts: 1, likes: 9, quotes: 0, views: 400, bookmarks: null },
    media: [],
    links: [],
    provenance: {
      backend: 'x-graphql',
      collectedAt: '2026-09-15T09:05:00.000Z',
      cached: false,
      url: 'https://x.com/someone/status/1800000000000000001',
      gaps: [],
    },
    ...over,
  };
}

const ctx = { selfHandles: ['ai17zos'], limit: 20, cursor: null as string | null };

describe('a canonical read, as radar candidates', () => {
  it('keeps the author id, which is the whole reason this path exists', () => {
    const [candidate] = toCandidates([post()], ctx, 'MENTION', 'search:@ai17zos', 'x-graphql');
    // Null here is what a scraped article gives, and it is what made a renamed
    // account look like a stranger.
    expect(candidate!.authorId).toBe('44196397');
  });

  it('carries exact engagement counts, which a rendered page abbreviates away', () => {
    const [candidate] = toCandidates([post()], ctx, 'MENTION', 'search', 'x-graphql');
    expect(candidate!.raw.metrics).toEqual({ replies: 2, reposts: 1, likes: 9, quotes: 0, views: 400 });
  });

  it('omits a count nobody could see rather than calling it zero', () => {
    const [candidate] = toCandidates([post({ metrics: null })], ctx, 'MENTION', 'search', 'x-dom');
    // Absent, not zero. "Nobody has replied yet" is worth points in the
    // opportunity engine, and an unmeasured post must not earn them.
    expect(candidate!.raw.metrics).toBeUndefined();
  });

  it('drops a null count out of the metrics it does carry', () => {
    const [candidate] = toCandidates(
      [post({ metrics: { replies: 5, reposts: null, likes: null, quotes: null, views: null, bookmarks: null } })],
      ctx,
      'MENTION',
      'search',
      'x-graphql',
    );
    expect(candidate!.raw.metrics).toEqual({ replies: 5 });
  });

  it('keeps the real conversation and the post being replied to', () => {
    const [candidate] = toCandidates(
      [post({ conversationId: '1700000000000000000', replyToPostId: '1700000000000000001' })],
      ctx,
      'REPLY',
      'search',
      'x-graphql',
    );
    expect(candidate!.conversationRemoteId).toBe('1700000000000000000');
    expect(candidate!.parentRemoteId).toBe('1700000000000000001');
  });

  it('falls back to the post as its own conversation when X did not say', () => {
    const [candidate] = toCandidates([post({ conversationId: null })], ctx, 'MENTION', 'search', 'x-graphql');
    expect(candidate!.conversationRemoteId).toBe('1800000000000000001');
  });

  it('records which reader answered, so a trace can say', () => {
    const [candidate] = toCandidates([post()], ctx, 'MENTION', 'search:@ai17zos', 'x-graphql');
    expect(candidate!.raw.backend).toBe('x-graphql');
    expect(candidate!.raw.source).toBe('search:@ai17zos');
  });
});

describe('what never becomes a candidate', () => {
  it('drops a repost, whose text belongs to somebody other than its author', () => {
    const candidates = toCandidates(
      [post({ repost: true, text: 'RT @elsewhere: something they did not write' })],
      ctx,
      'POST',
      'account:watched',
      'x-graphql',
    );
    expect(candidates).toEqual([]);
  });

  it('never treats one of our own posts as something to respond to', () => {
    const candidates = toCandidates([post({ authorHandle: 'AI17ZOS' })], ctx, 'MENTION', 'search', 'x-graphql');
    expect(candidates).toEqual([]);
  });

  it('drops a post with no text', () => {
    expect(toCandidates([post({ text: '   ' })], ctx, 'MENTION', 'search', 'x-graphql')).toEqual([]);
  });

  it('reports the same post once', () => {
    const candidates = toCandidates([post(), post()], ctx, 'MENTION', 'search', 'x-graphql');
    expect(candidates).toHaveLength(1);
  });

  it('stops at the cursor, because everything below it has been seen', () => {
    const candidates = toCandidates(
      [post({ postId: '3' }), post({ postId: '2' }), post({ postId: '1' })],
      { ...ctx, cursor: '2' },
      'MENTION',
      'search',
      'x-graphql',
    );
    expect(candidates.map((c) => c.remoteId)).toEqual(['3']);
  });

  it('honours the limit it was given', () => {
    const many = Array.from({ length: 10 }, (_, i) => post({ postId: `${i + 1}` }));
    expect(toCandidates(many, { ...ctx, limit: 3 }, 'MENTION', 'search', 'x-graphql')).toHaveLength(3);
  });
});

describe('when the radar falls back to the page, and when it must not', () => {
  const ctx = { selfHandles: ['ai17zos'], limit: 20, cursor: null as string | null };
  const answer = (outcome: string, detail = ''): XReadResult<XPostRecord[]> =>
    ({
      outcome,
      detail,
      data: [],
      provenance: { backend: 'x-graphql', collectedAt: 'now', cached: false, url: null, gaps: [] },
    }) as XReadResult<XPostRecord[]>;

  it('falls through when the structured read could not run', () => {
    // Null is the signal to scroll the page, which is what the page reader is
    // the floor for.
    expect(radarPollResultFrom(answer('SCHEMA_CHANGED'), ctx, 'MENTION', 'search')).toBeNull();
    expect(radarPollResultFrom(answer('UNAVAILABLE'), ctx, 'MENTION', 'search')).toBeNull();
  });

  it('treats an empty search as an answer rather than a reason to look again', () => {
    // X's search index is the same index the rendered search page draws from,
    // so scrolling it to be told the same thing costs a page load to learn
    // nothing.
    const result = radarPollResultFrom(answer('EMPTY'), ctx, 'MENTION', 'search');
    expect(result).toEqual({ candidates: [], cursor: null, error: null });
  });

  it('records a refusal instead of loading the page again', () => {
    for (const outcome of ['NEEDS_SIGN_IN', 'CHALLENGE', 'RATE_LIMITED', 'PROTECTED', 'NOT_FOUND']) {
      const result = radarPollResultFrom(answer(outcome), ctx, 'MENTION', 'search');
      // Not null: the poll ends here. Opening the same page in a browser after
      // a rate limit is how a read turns into hammering, and after a challenge
      // it is how automation starts arguing with a security check.
      expect(result, outcome).not.toBeNull();
      expect(result!.error, outcome).toBeTruthy();
      expect(result!.candidates, outcome).toEqual([]);
    }
  });

  it('uses X’s own words for a refusal when it gave any', () => {
    const result = radarPollResultFrom(answer('RATE_LIMITED', 'Slow down, please.'), ctx, 'MENTION', 'search');
    expect(result!.error).toBe('Slow down, please.');
  });
});

describe('which monitors the canonical layer can serve', () => {
  const ctx = {
    channel: {} as never,
    selfHandles: ['ai17zos'],
    limit: 10,
    cursor: null,
    target: null,
  };

  it('leaves notifications and own-thread walks to the page', async () => {
    // Neither is a timeline query. Notifications is X's own surface, and the
    // thread walk reads the counts on our own post while it is standing there
    // -- which is what makes measurement a by-product rather than a second loop
    // asking X how a post is doing.
    expect(await pollViaIntelligence('notifications', ctx)).toBeNull();
    expect(await pollViaIntelligence('own_threads', ctx)).toBeNull();
  });

  it('leaves a watched source with nothing to watch to the page', async () => {
    expect(await pollViaIntelligence('tracked_keyword', ctx)).toBeNull();
    expect(await pollViaIntelligence('tracked_account', ctx)).toBeNull();
  });

  it('leaves a mention search with no handle to search for to the page', async () => {
    expect(await pollViaIntelligence('mention_search', { ...ctx, selfHandles: [] })).toBeNull();
  });
});
