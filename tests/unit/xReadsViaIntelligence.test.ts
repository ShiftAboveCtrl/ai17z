import { describe, expect, it } from 'vitest';
import { asXPost, asXProfile, canonicalOrPage } from '@xbam/channels';
import type { XPostRecord, XReadResult, XUser } from '@xbam/channels';

/**
 * What the X capabilities get to keep now that they read X's own data.
 *
 * `x.read_post`, `x.read_thread`, `x.read_profile` and `x.search` have always
 * existed and have always scrolled a rendered page. `XPost` and `XProfile` have
 * always had fields a rendered page cannot fill -- `remoteUserId`,
 * `inReplyToStatusId`, exact counts, whether either account follows the other --
 * and those fields were simply never populated by anything.
 *
 * These are two separate assertions and both matter:
 *
 *  - **the mapping keeps the evidence**, so what X said reaches the model;
 *  - **a refusal is not retried on the page**, because a protected account is
 *    protected however it is read and loading the same page after a rate limit
 *    is how a read turns into hammering.
 */

function post(over: Partial<XPostRecord> = {}): XPostRecord {
  return {
    postId: '1800000000000000001',
    authorId: '44196397',
    authorHandle: 'someone',
    text: 'a post',
    createdAt: '2026-09-15T09:00:00.000Z',
    url: 'https://x.com/someone/status/1800000000000000001',
    conversationId: '1799999999999999999',
    replyToPostId: '1799999999999999999',
    replyToUserId: '12',
    quotedPostId: null,
    repost: false,
    lang: 'en',
    metrics: { replies: 3, reposts: 1, likes: 40, quotes: 0, views: 9000, bookmarks: null },
    media: [{ kind: 'photo', url: 'https://pbs.twimg.com/media/x.jpg', altText: 'a chart' }],
    links: [],
    provenance: { backend: 'x-graphql', collectedAt: 'now', cached: false, url: null, gaps: [] },
    ...over,
  };
}

function user(over: Partial<XUser> = {}): XUser {
  return {
    userId: '44196397',
    handle: 'someone',
    displayName: 'Someone',
    bio: 'a bio',
    avatarUrl: null,
    bannerUrl: null,
    location: 'Earth',
    website: 'https://example.test',
    followers: 1234,
    following: 56,
    posts: 900,
    createdAt: '2009-01-01T00:00:00.000Z',
    verified: true,
    protected: false,
    weFollow: true,
    followsUs: false,
    provenance: { backend: 'x-graphql', collectedAt: 'now', cached: false, url: null, gaps: [] },
    ...over,
  };
}

function answer<T>(outcome: XReadResult<T>['outcome'], data: T, detail = ''): XReadResult<T> {
  return {
    outcome,
    detail,
    data,
    provenance: { backend: 'x-graphql', collectedAt: 'now', cached: false, url: null, gaps: [] },
  };
}

describe('a post, as the shape that leaves the channel package', () => {
  it('carries the author’s numeric id, which a rendered article does not have', () => {
    expect(asXPost(post()).author.remoteUserId).toBe('44196397');
  });

  it('carries exact counts rather than an abbreviation', () => {
    const mapped = asXPost(post());
    expect(mapped.replyCount).toBe(3);
    expect(mapped.likeCount).toBe(40);
    expect(mapped.viewCount).toBe(9000);
  });

  it('leaves a count out when nobody could see one', () => {
    const mapped = asXPost(post({ metrics: null }));
    // Absent, not zero. The contract says an absent count means "not visible",
    // and an agent told a post has no likes will say so.
    expect(mapped.likeCount).toBeUndefined();
    expect(mapped.replyCount).toBeUndefined();
  });

  it('leaves out one count that was missing while keeping the rest', () => {
    const mapped = asXPost(
      post({ metrics: { replies: 3, reposts: null, likes: null, quotes: null, views: null, bookmarks: null } }),
    );
    expect(mapped.replyCount).toBe(3);
    expect(mapped.likeCount).toBeUndefined();
  });

  it('says what the post is an answer to', () => {
    expect(asXPost(post()).inReplyToStatusId).toBe('1799999999999999999');
  });

  it('keeps media with its alt text, in the contract’s vocabulary', () => {
    expect(asXPost(post()).media).toEqual([
      { kind: 'IMAGE', url: 'https://pbs.twimg.com/media/x.jpg', altText: 'a chart' },
    ]);
  });
});

describe('a profile, as the shape that leaves the channel package', () => {
  it('carries the numeric id and the follow relationship X stated', () => {
    const profile = asXProfile(user(), []);
    expect(profile.remoteUserId).toBe('44196397');
    expect(profile.followedByYou).toBe(true);
    expect(profile.followsYou).toBe(false);
  });

  it('omits the follow relationship when X did not state one', () => {
    const profile = asXProfile(user({ weFollow: null, followsUs: null }), []);
    // Null is "X did not say". Rendering it as false would be a measurement
    // nobody made, and the contract says absent means not visible.
    expect(profile.followedByYou).toBeUndefined();
    expect(profile.followsYou).toBeUndefined();
  });

  it('omits a follower count nobody could see', () => {
    expect(asXProfile(user({ followers: null }), []).followerCount).toBeUndefined();
  });
});

describe('when the rendered page may be tried, and when it must not', () => {
  it('hands back the answer when there is one', () => {
    expect(canonicalOrPage(answer('OK', 'the data'), 'a thing')).toBe('the data');
  });

  it('falls through to the page when the structured read could not run', () => {
    // These are exactly what the page reader is the floor for.
    expect(canonicalOrPage(answer('SCHEMA_CHANGED', null), 'a thing')).toBeNull();
    expect(canonicalOrPage(answer('UNAVAILABLE', null), 'a thing')).toBeNull();
    expect(canonicalOrPage(answer('EMPTY', null), 'a thing')).toBeNull();
  });

  it('refuses rather than loading the page again for a protected account', () => {
    expect(() => canonicalOrPage(answer('PROTECTED', null, '@locked is not public.'), '@locked')).toThrowError(
      '@locked is not public.',
    );
  });

  it('refuses rather than loading the page again after a rate limit', () => {
    // Loading the same page in a browser after X said to slow down is how a
    // read turns into hammering.
    expect(() => canonicalOrPage(answer('RATE_LIMITED', null), 'a thing')).toThrowError(/slow down/);
  });

  it('refuses rather than loading the page again at a security check', () => {
    // AI17Z never answers one, and it never has a second go at the page that
    // is showing it either.
    expect(() => canonicalOrPage(answer('CHALLENGE', null), 'a thing')).toThrowError(/security check/);
  });

  it('classifies each refusal as the kind of failure it is', () => {
    const classOf = (outcome: XReadResult<null>['outcome']) => {
      try {
        canonicalOrPage(answer(outcome, null), 'a thing');
        return 'none';
      } catch (error) {
        return (error as { errorClass?: string }).errorClass ?? 'unknown';
      }
    };
    // A missing post never becomes findable; a rate limit clears on its own; a
    // sign-in is somebody's to do. Answering all three the same way is how a
    // job burns its attempts on something that will never work, or gives up on
    // something that would have.
    expect(classOf('NOT_FOUND')).toBe('PERMANENT');
    expect(classOf('RATE_LIMITED')).toBe('RETRYABLE');
    expect(classOf('NEEDS_SIGN_IN')).toBe('REVIEW_REQUIRED');
  });
});
