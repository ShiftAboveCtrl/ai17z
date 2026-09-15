import { describe, expect, it } from 'vitest';
import {
  classifyDetailed,
  findUserResult,
  nextCursor,
  toPost,
  toUser,
  tweetsFrom,
} from '@xbam/channels';

/**
 * Reading what X actually sends back.
 *
 * The structured reader's value is that a timeline arrives as data rather than
 * as a drawing of data -- immutable ids, real counts, conversation ids,
 * long-form text. The cost is that the data is wrapped in several layers that
 * change shape, and getting a wrapper wrong is silent: it does not throw, it
 * returns nothing, and the feature above looks like an account with no posts.
 *
 * So the parsing is pinned against payloads shaped the way X's are, including
 * the four traps that are easy to get wrong and impossible to notice:
 *
 *   - a tweet wrapped in `TweetWithVisibilityResults` rather than being one
 *   - long-form text living in `note_tweet`, not `full_text`
 *   - a repost, whose own text is a truncated "RT @..." of somebody else's
 *   - a cursor that is the only way to reach page two
 *
 * No browser here: this is pure, and it is where the risk is.
 */

const tweet = (over: Record<string, unknown> = {}, legacy: Record<string, unknown> = {}) => ({
  __typename: 'Tweet',
  rest_id: '1900000000000000001',
  core: {
    user_results: {
      result: {
        rest_id: '44196397',
        core: { screen_name: 'someone', name: 'Some One' },
        legacy: { followers_count: 12, friends_count: 3, description: 'A bio.' },
      },
    },
  },
  legacy: {
    full_text: 'A post about ferries.',
    created_at: 'Mon Sep 01 10:00:00 +0000 2026',
    conversation_id_str: '1900000000000000000',
    reply_count: 2,
    retweet_count: 5,
    favorite_count: 9,
    quote_count: 1,
    lang: 'en',
    entities: {},
    ...legacy,
  },
  ...over,
});

describe('finding the tweets in what X sent', () => {
  it('unwraps a tweet hidden behind a visibility wrapper', () => {
    // X wraps some posts in `TweetWithVisibilityResults`, and a reader that
    // only recognises `Tweet` silently drops every one of them -- which reads
    // as a quiet account rather than as a parsing failure.
    const payload = {
      data: {
        user: {
          result: {
            timeline: {
              timeline: {
                instructions: [
                  {
                    type: 'TimelineAddEntries',
                    entries: [
                      {
                        entryId: 'tweet-1',
                        content: {
                          itemContent: {
                            tweet_results: {
                              result: { __typename: 'TweetWithVisibilityResults', tweet: tweet() },
                            },
                          },
                        },
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    };
    const found = tweetsFrom(payload);
    expect(found).toHaveLength(1);
    expect(found[0]!.rest_id).toBe('1900000000000000001');
  });

  it('counts a post once however many places it appears in the payload', () => {
    // The same tweet turns up under several keys in one response. Deduped on
    // the id, because a timeline that reports forty posts when it read twenty
    // makes every count downstream wrong.
    const one = tweet();
    const payload = { a: { tweet_results: { result: one } }, b: [{ entryId: 'x', content: { tweet: one } }] };
    expect(tweetsFrom(payload)).toHaveLength(1);
  });

  it('finds nothing in an answer that carries nothing, without throwing', () => {
    expect(tweetsFrom({ data: { user: { result: { timeline: null } } } })).toHaveLength(0);
    expect(tweetsFrom(null)).toHaveLength(0);
  });
});

describe('turning one tweet into the shape everything downstream uses', () => {
  it('keeps the ids as strings', () => {
    // A 19-digit id is past what a JS number holds. Parsed as one it becomes a
    // different id, which is worse than failing: it silently points at another
    // post.
    const post = toPost(tweet(), 'test')!;
    expect(typeof post.postId).toBe('string');
    expect(post.postId).toBe('1900000000000000001');
    expect(post.authorId).toBe('44196397');
  });

  it('reads long-form text from where X actually puts it', () => {
    // A long post's text is in `note_tweet`; `full_text` holds a truncated
    // copy. Reading only `full_text` quietly cuts every long post at the old
    // limit, which for a persona corpus loses exactly the most characteristic
    // writing somebody does.
    const long = 'A very long post. '.repeat(40);
    const post = toPost(
      tweet({ note_tweet: { note_tweet_results: { result: { text: long } } } }, { full_text: 'A very long post. A very…' }),
      'test',
    )!;
    expect(post.text).toBe(long.trim());
    expect(post.text.length).toBeGreaterThan(300);
  });

  it('marks a repost as one', () => {
    // Passing somebody's post on is not writing, and a persona corpus drops it.
    // The flag is what lets the layer above decide -- a relationship reader
    // wants reposts, a voice reader does not.
    const post = toPost(tweet({}, { retweeted_status_result: { result: tweet() } }), 'test')!;
    expect(post.repost).toBe(true);
    expect(toPost(tweet(), 'test')!.repost).toBe(false);
  });

  it('carries the conversation and what it was answering', () => {
    // So a reply can be read with its context rather than as a standalone
    // belief: "exactly lol" means nothing without the post above it.
    const post = toPost(
      tweet({}, { in_reply_to_status_id_str: '1888', in_reply_to_user_id_str: '77', quoted_status_id_str: '1999' }),
      'test',
    )!;
    expect(post.replyToPostId).toBe('1888');
    expect(post.replyToUserId).toBe('77');
    expect(post.quotedPostId).toBe('1999');
    expect(post.conversationId).toBe('1900000000000000000');
  });

  it('reports the counts X gave and invents none it did not', () => {
    const post = toPost(tweet(), 'test')!;
    expect(post.metrics?.likes).toBe(9);
    expect(post.metrics?.replies).toBe(2);
    // Views were not in the payload. Null, never zero: "nobody saw it" and "X
    // did not say" are different facts and one of them is a lie.
    expect(post.metrics?.views).toBeNull();
  });

  it('says where and when it was read', () => {
    const post = toPost(tweet(), 'test')!;
    expect(post.provenance.backend).toBe('test');
    expect(post.url).toContain('someone/status/1900000000000000001');
  });
});

describe('turning a profile into an identity', () => {
  it('takes the numeric id, which is the identity', () => {
    const payload = { data: { user: { result: { rest_id: '44196397', core: { screen_name: 'jack', name: 'jack' }, legacy: { followers_count: 6_500_000, description: 'bio' } } } } };
    const result = findUserResult(payload)!;
    const parsed = toUser(result, 'test')!;
    expect(parsed.userId).toBe('44196397');
    expect(parsed.handle).toBe('jack');
    expect(parsed.followers).toBe(6_500_000);
  });

  it('refuses a payload with no identity in it rather than inventing one', () => {
    expect(findUserResult({ data: { user: { result: { __typename: 'UserUnavailable' } } } })).toBeNull();
  });
});

describe('reaching page two', () => {
  it('finds the cursor that is the only way forward', () => {
    // Without this a timeline read stops at the first page, which for an
    // account with hundreds of posts looks like an account with forty.
    const payload = {
      entries: [
        { entryId: 'tweet-1', content: {} },
        { entryId: 'cursor-bottom-99', content: { value: 'DAABCgABGxyz' } },
      ],
    };
    expect(nextCursor(payload)).toBe('DAABCgABGxyz');
  });

  it('says there is no next page when X offered none', () => {
    expect(nextCursor({ entries: [{ entryId: 'tweet-1', content: {} }] })).toBeNull();
  });
});

describe('what X said went wrong', () => {
  it.each([
    [429, 'Rate limit exceeded', 'RATE_LIMITED'],
    [401, 'Could not authenticate you', 'NEEDS_SIGN_IN'],
    [403, 'Not authorized', 'NEEDS_SIGN_IN'],
    [404, 'User not found', 'NOT_FOUND'],
    [200, 'This account is protected', 'PROTECTED'],
  ])('reads %i "%s" as %s', (status, error, expected) => {
    // Each of these needs a different thing from the person who asked, which is
    // why they are separate outcomes rather than one failure with a message.
    // Getting the rate limit wrong is the one that matters most: treating it as
    // a failure to retry is how a read turns into hammering.
    expect(classifyDetailed(status, error).outcome).toBe(expected);
  });

  it('treats an unrecognised answer as a changed shape, not a missing account', () => {
    // The fallback depends on this distinction: a changed shape is worth trying
    // another reader for, and a missing account is not.
    const { outcome, detail } = classifyDetailed(200, 'something nobody has seen before');
    expect(outcome).toBe('SCHEMA_CHANGED');
    expect(detail).toMatch(/did not understand/i);
  });
});
