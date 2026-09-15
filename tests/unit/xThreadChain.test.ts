import { describe, expect, it } from 'vitest';
import { ancestorChain } from '@xbam/channels';
import type { XPostRecord } from '@xbam/channels';

/**
 * Which posts are actually above a post, and which merely came before it.
 *
 * A status page carries the ancestors, the focal post, the replies underneath,
 * and the replies to those. The obvious way to read a thread out of that is to
 * take everything before the focal post, and it is wrong in a way that only
 * shows up sometimes: a sibling branch -- somebody else's tangent -- lands in a
 * conversation the agent then answers as though it were part of the exchange.
 *
 * `x/conversation.ts` reached the same conclusion for the rendered page and
 * excluded siblings structurally rather than filtering them out afterwards.
 * This is the JSON half of that argument, and it can be stronger: X's own data
 * carries the reply-to link, so the ancestry can be followed rather than
 * inferred from position.
 *
 * Case 4 in `tests/unit/xConversation.test.ts` is the AI4CZ regression -- a
 * mention four levels deep. This file's fourth case is the same shape, so the
 * JSON path has its own version of the test that mattered.
 */

function post(id: string, replyTo: string | null): XPostRecord {
  return {
    postId: id,
    authorId: `author-${id}`,
    authorHandle: `person${id}`,
    text: `post ${id}`,
    createdAt: '2026-09-15T09:00:00.000Z',
    url: `https://x.com/person${id}/status/${id}`,
    conversationId: '1',
    replyToPostId: replyTo,
    replyToUserId: null,
    quotedPostId: null,
    repost: false,
    lang: 'en',
    metrics: null,
    media: [],
    links: [],
    provenance: { backend: 'x-graphql', collectedAt: '2026-09-15T09:05:00.000Z', cached: false, url: null, gaps: [] },
  };
}

const ids = (posts: XPostRecord[]) => posts.map((p) => p.postId);

describe('the chain above a post', () => {
  it('returns just the post when it is the start of a conversation', () => {
    expect(ids(ancestorChain([post('1', null)], '1'))).toEqual(['1']);
  });

  it('returns root first, focal last', () => {
    const conversation = [post('1', null), post('2', '1'), post('3', '2')];
    expect(ids(ancestorChain(conversation, '3'))).toEqual(['1', '2', '3']);
  });

  it('leaves out replies that came after the focal post', () => {
    const conversation = [post('1', null), post('2', '1'), post('3', '2'), post('4', '3'), post('5', '3')];
    expect(ids(ancestorChain(conversation, '3'))).toEqual(['1', '2', '3']);
  });

  it('leaves out a sibling branch, which is the whole reason this is not a slice', () => {
    /*
      X renders these in one list and the tangent sits between the root and the
      focal post. "Everything before the focal post" would include it, and the
      agent would answer a conversation containing a remark nobody in it made.
    */
    const conversation = [
      post('1', null),
      post('2', '1'),
      post('99', '1'), // somebody else's answer to the root
      post('3', '2'),
    ];
    expect(ids(ancestorChain(conversation, '3'))).toEqual(['1', '2', '3']);
  });

  it('climbs four levels, which is the AI4CZ regression', () => {
    const conversation = [post('1', null), post('2', '1'), post('3', '2'), post('4', '3'), post('5', '4')];
    expect(ids(ancestorChain(conversation, '5'))).toEqual(['1', '2', '3', '4', '5']);
  });

  it('stops where X stopped rather than inventing a root', () => {
    // The parent is named and absent: X did not return it. The chain ends, and
    // `getThread` records that the conversation continues above it.
    const conversation = [post('3', '2'), post('4', '3')];
    const chain = ancestorChain(conversation, '4');
    expect(ids(chain)).toEqual(['3', '4']);
    expect(chain[0]!.replyToPostId).toBe('2');
  });

  it('returns nothing when the post asked for is not in the answer', () => {
    expect(ancestorChain([post('1', null)], '999')).toEqual([]);
  });

  it('does not loop for ever on a cycle', () => {
    // X should never produce one. A reader that trusts a remote service not to
    // is a reader that hangs a worker.
    const conversation = [post('1', '2'), post('2', '1')];
    expect(ids(ancestorChain(conversation, '1'))).toEqual(['2', '1']);
  });
});
