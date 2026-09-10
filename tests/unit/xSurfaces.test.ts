import { describe, expect, it } from 'vitest';
import {
  parseAnalytics,
  toConnections,
  toThreads,
  toTimelinePosts,
  timelineUrl,
  type ConversationRow,
  type UserCell,
} from '@xbam/channels';
import type { Seen } from '@xbam/channels';

/**
 * The pure half of the surfaces an agent can read.
 *
 * Each of these sits behind a browser in production, and each has one piece of
 * logic that a browser would prove nothing about: a virtualised list repeats
 * rows as it scrolls, an analytics label overlaps another analytics label, and
 * a conversation row runs three different facts together in one string.
 */

const user = (over: Partial<UserCell>): UserCell => ({
  handle: '',
  displayName: null,
  bio: null,
  followsYou: false,
  ...over,
});

describe('reading a follower list', () => {
  it('reports an account once however often the list re-rendered it', () => {
    // X virtualises: scrolling removes rows above and re-adds rows below, and
    // each pass is a window rather than the whole list. The windows overlap.
    const { accounts } = toConnections(
      [
        user({ handle: 'alice', displayName: 'Alice' }),
        user({ handle: 'bob' }),
        user({ handle: 'alice', displayName: 'Alice' }),
        user({ handle: 'carol' }),
      ],
      10,
    );
    expect(accounts.map((a) => a.handle)).toEqual(['alice', 'bob', 'carol']);
  });

  it('says when it stopped early rather than implying it saw everything', () => {
    const { accounts, more } = toConnections(
      [user({ handle: 'a' }), user({ handle: 'b' }), user({ handle: 'c' })],
      2,
    );
    expect(accounts).toHaveLength(2);
    expect(more).toBe(true);
  });

  it('records "follows you" only when X said so', () => {
    // The badge's absence on a row that has not finished rendering is X not
    // saying, which is not the same as no.
    const { accounts } = toConnections([user({ handle: 'alice', followsYou: true }), user({ handle: 'bob' })], 10);
    expect(accounts[0]!.followsYou).toBe(true);
    expect('followsYou' in accounts[1]!).toBe(false);
  });

  it('leaves out a row that had no handle', () => {
    // "Who to follow" cards and loading placeholders both land in the same
    // container, and neither is an account.
    const { accounts } = toConnections([user({ handle: '', displayName: 'Suggested' }), user({ handle: 'alice' })], 10);
    expect(accounts.map((a) => a.handle)).toEqual(['alice']);
  });
});

const seen = (over: Partial<Seen>): Seen => ({
  statusId: null,
  authorHandle: null,
  text: '',
  url: null,
  createdAt: null,
  ...over,
});

describe('reading a timeline', () => {
  it('keeps the order X chose', () => {
    // Home is a ranking. Re-sorting it would be answering a different question
    // from the one the surface was asked.
    const { posts } = toTimelinePosts(
      [
        seen({ statusId: '1', text: 'first', authorHandle: 'alice' }),
        seen({ statusId: '2', text: 'second', authorHandle: 'bob' }),
      ],
      10,
    );
    expect(posts.map((p) => p.statusId)).toEqual(['1', '2']);
  });

  it('drops the things a timeline interleaves that are not posts', () => {
    const { posts } = toTimelinePosts(
      [
        seen({ statusId: null, text: 'Who to follow' }),
        seen({ statusId: '2', text: '' }),
        seen({ statusId: '3', text: 'real', authorHandle: 'alice' }),
      ],
      10,
    );
    expect(posts.map((p) => p.statusId)).toEqual(['3']);
  });

  it('refuses a list or community it cannot name', () => {
    // Falling through to some other URL would answer "what is in this
    // community" with the home timeline, which is a wrong answer that looks
    // exactly like a right one.
    expect(() => timelineUrl('LIST', undefined)).toThrow(/not an X list id/);
    expect(() => timelineUrl('COMMUNITY', 'my-community')).toThrow(/not an X community id/);
    expect(timelineUrl('COMMUNITY', '1234567890')).toBe('https://x.com/i/communities/1234567890');
    expect(timelineUrl('LIST', '1234567890')).toBe('https://x.com/i/lists/1234567890');
  });

  it('counts what it did not return', () => {
    const { posts, more } = toTimelinePosts(
      [seen({ statusId: '1', text: 'a' }), seen({ statusId: '2', text: 'b' }), seen({ statusId: '3', text: 'c' })],
      2,
    );
    expect(posts).toHaveLength(2);
    expect(more).toBe(true);
  });
});

describe("reading a post's own analytics", () => {
  it('maps X labels onto our columns', () => {
    const reading = parseAnalytics([
      { label: 'Impressions', value: '12,405' },
      { label: 'Likes', value: '48' },
      { label: 'Profile visits', value: '2.4K' },
      { label: 'Link clicks', value: '17' },
    ]);
    expect(reading.impressions).toBe(12405);
    expect(reading.likes).toBe(48);
    expect(reading.profileVisits).toBe(2400);
    expect(reading.linkClicks).toBe(17);
  });

  it('does not let one label answer for another', () => {
    // "New followers" is a follower count that is emphatically not this
    // account's follower count, and "Detail expands" is not an impression. A
    // substring match writes the wrong number into the right column.
    const reading = parseAnalytics([
      { label: 'New followers', value: '9' },
      { label: 'Detail expands', value: '31' },
    ]);
    expect(reading.impressions).toBeUndefined();
    expect(reading.unmapped).toEqual(['New followers', 'Detail expands']);
  });

  it('leaves a figure it could not read absent rather than zero', () => {
    const reading = parseAnalytics([{ label: 'Impressions', value: '-' }]);
    expect('impressions' in reading).toBe(false);
  });
});

const row = (over: Partial<ConversationRow>): ConversationRow => ({
  conversationId: '',
  handles: [],
  names: [],
  text: '',
  at: null,
  ...over,
});

describe('reading the inbox', () => {
  it('takes the preview from the last line, not the whole row', () => {
    // The row runs the participants, the timestamp and the message together.
    // Taking all of it puts the other person's display name inside what they
    // said.
    const [thread] = toThreads([
      row({
        conversationId: '111-222',
        handles: ['alice'],
        names: ['Alice'],
        text: 'Alice\n@alice · 2h\nare you around later',
        at: '2026-09-09T10:00:00.000Z',
      }),
    ]);
    expect(thread!.lastMessage).toBe('are you around later');
    expect(thread!.participants).toEqual([{ handle: 'alice', displayName: 'Alice' }]);
    expect(thread!.lastAt).toBe('2026-09-09T10:00:00.000Z');
  });

  it('reports a conversation once', () => {
    expect(toThreads([row({ conversationId: '1', text: 'a' }), row({ conversationId: '1', text: 'a' })])).toHaveLength(
      1,
    );
  });

  it('drops a row with no conversation id, because nothing could reach it again', () => {
    expect(toThreads([row({ conversationId: '', text: 'hello' })])).toHaveLength(0);
  });
});
