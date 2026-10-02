import { beforeEach, describe, expect, it } from 'vitest';
import {
  authoredBy,
  emptyResult,
  emptyTimelineDetail,
  emptyTimelineIsReal,
  forgetXReads,
  isByRequestedUser,
  profileOfUrl,
  provenanceFor,
  readTimelineState,
  toPost,
  tweetsFrom,
  xIntelligence,
  type XIntelligenceBackend,
  type XPostRecord,
  type XReadOutcome,
} from '@xbam/channels';
import type { xMonitors } from '@xbam/channels';
import { xReadVerdict } from '../../apps/worker/src/foundryWorker';

/**
 * Zero posts is four different answers, and only one of them is an empty account.
 *
 * Found on a real installation: a Foundry run read nothing for an account with
 * hundreds of public posts, called the result an empty timeline, and went on to
 * propose knowledge, safety rules and tests for a persona built from nothing.
 * The structured read had come back empty, the rendered page had drawn no
 * articles, and both were reported as EMPTY, the same word X's own "hasn't
 * posted" deserves. Everything here is synthetic.
 */

type Seen = ReturnType<typeof xMonitors.readAllArticles> extends Promise<(infer T)[]> ? T : never;
const seen = (over: Partial<Seen> & { statusId: string }): Seen => ({
  authorHandle: 'someone',
  text: 'words',
  url: `https://x.com/someone/status/${over.statusId}`,
  createdAt: null,
  isReply: false,
  isQuote: false,
  ...over,
}) as Seen;

describe('which profile a page is', () => {
  it('names the profile from the address, and nothing that is not one', () => {
    expect(profileOfUrl('https://x.com/SomeOne/with_replies')).toBe('SomeOne');
    expect(profileOfUrl('https://x.com/someone')).toBe('someone');
    expect(profileOfUrl('https://x.com/home')).toBeNull();
    expect(profileOfUrl('https://x.com/i/flow/login')).toBeNull();
    expect(profileOfUrl('https://x.com/search?q=x')).toBeNull();
    expect(profileOfUrl('not a url')).toBeNull();
  });

  it('a redirect to another account is a different profile, never the one asked for', () => {
    const asked = 'oldname';
    const landed = profileOfUrl('https://x.com/newname/with_replies');
    expect(landed?.toLowerCase()).not.toBe(asked);
  });
});

describe('what an empty timeline area is saying', () => {
  it("tells X's error screen, a rate limit and a real empty account apart", () => {
    expect(readTimelineState('Something went wrong. Try reloading.\nRetry')).toBe('ERROR');
    expect(readTimelineState("Something went wrong, but don't fret")).toBe('ERROR');
    expect(readTimelineState('Rate limit exceeded')).toBe('RATE_LIMITED');
    expect(readTimelineState('@someone hasn’t posted\nWhen they do, their posts will show up here.')).toBe('EMPTY_STATE');
    expect(readTimelineState("@someone hasn't replied")).toBe('EMPTY_STATE');
    // A page that drew nothing says nothing, and nothing is not "empty".
    expect(readTimelineState('')).toBeNull();
    expect(readTimelineState('Posts Replies Media Likes')).toBeNull();
  });
});

describe('whose writing it is', () => {
  it('keeps a pinned post and a reply of theirs, and drops everybody else on the page', () => {
    const posts = authoredBy('target', [
      seen({ statusId: '1', authorHandle: 'target', text: 'pinned: what this account is about' }),
      seen({ statusId: '2', authorHandle: 'stranger', text: 'the post being replied to' }),
      seen({ statusId: '3', authorHandle: 'target', text: 'replying with an opinion', isReply: true }),
      seen({ statusId: '4', authorHandle: 'advertiser', text: 'Promoted: buy this' }),
      seen({ statusId: '5', authorHandle: 'stranger', text: 'a reply by somebody else, to them', isReply: true }),
      seen({ statusId: '6', authorHandle: 'target', text: '   ' }),
      seen({ statusId: '7', authorHandle: 'target', text: 'my comment on this', isQuote: true }),
    ]);
    expect(posts.map((p) => [p.statusId, p.kind])).toEqual([
      ['1', 'post'],
      ['3', 'reply'],
      ['7', 'quote'],
    ]);
  });

  it('a structured timeline that carries the post being answered keeps its author on it', () => {
    const tweet = (id: string, handle: string, extra: Record<string, unknown> = {}) => ({
      __typename: 'Tweet',
      rest_id: id,
      core: { user_results: { result: { rest_id: `u${handle}`, core: { screen_name: handle, name: handle }, legacy: {} } } },
      legacy: { full_text: `${handle} wrote this`, conversation_id_str: '100', entities: {}, ...extra },
    });
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
                        content: {
                          items: [
                            { item: { itemContent: { tweet_results: { result: tweet('1900000000000000100', 'stranger') } } } },
                            {
                              item: {
                                itemContent: {
                                  tweet_results: { result: tweet('1900000000000000101', 'target', { in_reply_to_status_id_str: '1900000000000000100' }) },
                                },
                              },
                            },
                          ],
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
    const posts = tweetsFrom(payload).map((t) => toPost(t, 'test')!);
    const byAuthor = Object.fromEntries(posts.map((p) => [p.postId, p.authorHandle]));
    expect(byAuthor).toEqual({ '1900000000000000100': 'stranger', '1900000000000000101': 'target' });
    expect(posts.find((p) => p.authorHandle === 'target')!.replyToPostId).toBe('1900000000000000100');
    // Only the account's own writing counts as its timeline: by numeric id, and
    // by handle only where an id is missing.
    const own = posts.filter((p) => isByRequestedUser(p, { userId: 'utarget', handle: 'target' }));
    expect(own.map((p) => p.postId)).toEqual(['1900000000000000101']);
    expect(isByRequestedUser({ authorId: null, authorHandle: '@Target' }, { userId: 'utarget', handle: 'target' })).toBe(true);
    expect(isByRequestedUser({ authorId: 'uother', authorHandle: 'target' }, { userId: 'utarget', handle: 'target' })).toBe(false);
  });
});

describe('an empty timeline, judged against the profile', () => {
  it('is real only when X itself counts nothing, or did not count', () => {
    expect(emptyTimelineIsReal(0)).toBe(true);
    expect(emptyTimelineIsReal(null)).toBe(true);
    expect(emptyTimelineIsReal(237)).toBe(false);
    expect(emptyTimelineDetail('someone', 237)).toMatch(/has 237 posts, and showed none of them, so the read failed/);
    expect(emptyTimelineDetail('someone', 0)).toMatch(/has no public posts/);
  });

  it('research waits on a failed read, stops on a refusal, and only accepts a real empty', () => {
    expect(xReadVerdict('EMPTY', 'X returned no posts', 'someone', 237)).toMatchObject({ state: 'UNAVAILABLE', retryAfterMs: expect.any(Number) });
    expect(xReadVerdict('EMPTY', 'X returned no posts', 'someone', 0)).toMatchObject({ state: 'AVAILABLE' });
    expect(xReadVerdict('UNAVAILABLE', "X did not draw @someone's timeline", 'someone', 237)).toMatchObject({ retryAfterMs: expect.any(Number) });
    expect(xReadVerdict('SCHEMA_CHANGED', 'shape', 'someone', 5)).toMatchObject({ retryAfterMs: expect.any(Number) });
    expect(xReadVerdict('RATE_LIMITED', 'slow down', 'someone', 5)).toMatchObject({ state: 'DEGRADED', retryAfterMs: expect.any(Number) });
    for (const refused of ['NOT_FOUND', 'PROTECTED', 'CHALLENGE', 'NEEDS_SIGN_IN']) {
      const verdict = xReadVerdict(refused, `${refused} detail`, 'someone', 5);
      expect(verdict.fatal, refused).toBeTruthy();
      expect(verdict.retryAfterMs, refused).toBeUndefined();
    }
    expect(xReadVerdict('CHALLENGE', 'a code', 'someone', 5).fatal).toMatch(/nothing here answers it/);
  });
});

/** Two readers, the way production has them: structured first, the page second. */
function reader(name: string, outcome: XReadOutcome) {
  const asked: string[] = [];
  const backend: XIntelligenceBackend = {
    name,
    async readiness() {
      return { state: 'READY', detail: name, can: ['getUserPosts'] };
    },
    async resolveUser() {
      return emptyResult(name, 'UNAVAILABLE', 'not asked here', null);
    },
    async getUserPosts(_ctx, request) {
      asked.push(request.handle);
      if (outcome !== 'OK') return emptyResult(name, outcome, `${name}: ${outcome}`, [] as XPostRecord[]);
      return {
        outcome: 'OK',
        detail: '',
        data: [
          {
            postId: '1',
            authorId: null,
            authorHandle: request.handle,
            text: 'words',
            createdAt: null,
            url: 'https://x.com/a/status/1',
            conversationId: null,
            replyToPostId: null,
            replyToUserId: null,
            quotedPostId: null,
            repost: false,
            lang: null,
            metrics: null,
            media: [],
            links: [],
            provenance: provenanceFor(name),
          },
        ],
        provenance: provenanceFor(name),
      };
    },
  };
  return { backend, asked };
}

describe('falling back from the structured reader to the page', () => {
  beforeEach(() => forgetXReads());
  const request = { userId: 'u1', handle: 'someone', limit: 10 };

  it('a structured failure is read from the page, and says so', async () => {
    const graphql = reader('x-graphql', 'UNAVAILABLE');
    const dom = reader('x-page', 'OK');
    const out = await xIntelligence.getUserPosts(request, { backends: [graphql.backend, dom.backend] });
    expect(out.outcome).toBe('OK');
    expect(out.provenance.gaps.join(' ')).toMatch(/x-graphql could not answer; read by x-page/);
  });

  it('an empty structured answer that the page cannot draw either is a failed read, not an empty account', async () => {
    const out = await xIntelligence.getUserPosts(request, {
      backends: [reader('x-graphql', 'EMPTY').backend, reader('x-page', 'UNAVAILABLE').backend],
    });
    expect(out.outcome).toBe('UNAVAILABLE');
  });

  it('a rate limit or a challenge stops at the first reader', async () => {
    for (const stop of ['RATE_LIMITED', 'CHALLENGE'] as const) {
      const dom = reader('x-page', 'OK');
      const out = await xIntelligence.getUserPosts(request, { backends: [reader('x-graphql', stop).backend, dom.backend] });
      expect(out.outcome).toBe(stop);
      expect(dom.asked).toEqual([]);
    }
  });
});
