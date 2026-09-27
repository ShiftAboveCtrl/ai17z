import { describe, expect, it } from 'vitest';
import { toPost, toUser } from '@xbam/channels';

/**
 * Where X puts somebody's audience this week.
 *
 * Measured on a live installation: X stopped sending the author's `legacy`
 * block and sends `relationship_counts` instead, and every author came back
 * with no follower count, so the agent could not tell an account of two
 * hundred thousand from an empty one. Both shapes are read; absent stays
 * absent.
 */

const tweet = (user: Record<string, unknown>) => ({
  __typename: 'Tweet',
  rest_id: '1900000000000001001',
  core: { user_results: { result: { __typename: 'User', rest_id: '42', core: { screen_name: 'bigbuilder' }, ...user } } },
  legacy: { full_text: 'gm', favorite_count: 10 },
});

describe("an author's audience", () => {
  it('reads the current shape', () => {
    expect(toPost(tweet({ relationship_counts: { followers: 184_000, following: 900 } }), 'test')!.authorFollowers).toBe(184_000);
  });

  it('still reads the old one', () => {
    expect(toPost(tweet({ legacy: { screen_name: 'bigbuilder', followers_count: 5_100 } }), 'test')!.authorFollowers).toBe(5_100);
  });

  it('leaves a missing count missing rather than zero', () => {
    expect(toPost(tweet({}), 'test')!.authorFollowers).toBeNull();
  });

  it('reads a profile the same way', () => {
    const user = toUser(
      { rest_id: '42', core: { screen_name: 'bigbuilder' }, relationship_counts: { followers: 184_000, following: 900 } },
      'test',
    );
    expect(user!.followers).toBe(184_000);
    expect(user!.following).toBe(900);
  });
});
