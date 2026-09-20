import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

  it('refuses without naming a cause it cannot know', () => {
    /*
      A post with no analytics has more than one explanation and this layer can
      tell them apart from none. It used to answer with one of them as a
      statement: "Only the author's own posts have them", said against two posts
      the signed-in account had written itself. The agent repeated it to the
      owner and then invented a mechanism to explain it.
    */
    const source = readFileSync(resolve(__dirname, '../../packages/channels/src/x/analytics.ts'), 'utf8');
    expect(source).not.toContain("Only the author's own posts have them");
    // What it says instead is what it established: who wrote the post, and who
    // this account is. Both are read rather than assumed, and the sentence
    // names them, so nothing downstream has to guess which of the two it was.
    expect(source).toContain('was written by @');
    expect(source).toContain("X shows a post's own figures to whoever wrote it");
  });

  it('reaches analytics the only way that works, from the post', () => {
    /*
      Measured against the live signed-in session, on a post the account had
      written itself: `/i/status/<id>/analytics` renders the home timeline, and
      so does `/<handle>/status/<id>/analytics` on a hard navigation waited out
      for fifteen seconds. X's router only resolves that address from inside the
      application, so the post is loaded and the link X puts there is followed.

      Pinned at the source because the alternative is a browser, and the thing
      being pinned is which address is built rather than what came back.
    */
    const source = readFileSync(resolve(__dirname, '../../packages/channels/src/x/analytics.ts'), 'utf8');
    // The post, by the canonical id-only address the rest of the layer uses.
    expect(source).toContain('https://x.com/i/web/status/${statusId}');
    // And never a hard navigation to an analytics address, which is what it did.
    expect(source).not.toMatch(/goto\([^)]*\/analytics/);
    expect(source).not.toContain('https://x.com/i/status/');
    // The link is the eligibility test as well as the route.
    expect(source).toContain('a[href$="/${statusId}/analytics"]');
  });

  it('never renames a metric X did not use', () => {
    /*
      "Views" was being folded into `impressions`.

      Nothing established that the two are the same measurement. Measured on a
      live signed-in session: X writes "288 replies, 155 reposts, 696 likes, 60
      bookmarks, 58814 views" in the count group under a post and "Views" beside
      the figure, and never says impressions there. Its detailed analytics view,
      where an account has one, does say impressions, and that is a different
      number arrived at a different way.

      A reading that renames a metric is a reading that misstates one, and a
      model handed `impressions` will say impressions.
    */
    const views = parseAnalytics([{ label: 'Views', value: '58,814' }]);
    expect(views.views).toBe(58814);
    expect('impressions' in views).toBe(false);

    const impressions = parseAnalytics([{ label: 'Impressions', value: '12,405' }]);
    expect(impressions.impressions).toBe(12405);
    expect('views' in impressions).toBe(false);
  });

  it('separates a detailed reading from one taken off the post', () => {
    // The two are different claims about different surfaces, and a caller that
    // cannot tell them apart reads an absent profile-visit count as measured.
    const full = parseAnalytics([
      { label: 'Impressions', value: '12,405' },
      { label: 'Profile visits', value: '2.4K' },
    ]);
    expect(full.source).toBe('DETAILED');
    expect(full.gaps).toEqual([]);
    expect(full.profileVisits).toBe(2400);
  });

  it('never turns an unmeasured figure into a zero', () => {
    // Every metric absent from the page stays absent. Nothing in a reading may
    // arrive downstream as a measured nought.
    const reading = parseAnalytics([{ label: 'Views', value: '31' }]);
    expect(reading.views).toBe(31);
    for (const metric of ['impressions', 'likes', 'reposts', 'replies', 'quotes', 'bookmarks', 'profileVisits', 'linkClicks']) {
      expect(metric in reading).toBe(false);
    }
  });

  it('establishes whose post it is rather than inferring it from a link', () => {
    /*
      The eligibility test used to be the presence of X's analytics link, on the
      reasoning that X shows it to the author.

      Measured against the live session on somebody else's post: the link is
      there too, reading "58.8K Views". It is on every post and proves nothing
      about who wrote one. The canonical signal is the one the rest of this
      layer already uses, the focal article's author against this session's own
      handles.
    */
    const source = readFileSync(resolve(__dirname, '../../packages/channels/src/x/analytics.ts'), 'utf8');
    expect(source).toContain('selfHandles(ctx)');
    expect(source).toContain('mine.includes(author)');
    // Anchored on the article that links to this status id, never on position.
    expect(source).toContain(':has(a[href*="/status/${statusId}"])');
  });

  it('reports only what it measured when the detailed view did not render', () => {
    const source = readFileSync(resolve(__dirname, '../../packages/channels/src/x/analytics.ts'), 'utf8');
    expect(source).toContain("source: 'VIEWS_ONLY'");
    // Built from what the count group actually carried, not from a fixed shape.
    expect(source).toContain('Object.fromEntries(measured)');
    // And it says which figures were not measured, so absence is never read as
    // a nought by whatever comes next.
    expect(source).toContain('absent rather than zero');
    // Nothing left to report is a refusal rather than an empty success.
    expect(source).toContain('There is nothing here to report');
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

/**
 * Nothing found and nothing readable are different answers.
 *
 * X's own error page has no articles on it, no notification rows, no
 * conversation rows and no user cells. So does a healthy surface with nothing
 * on it. A reader that cannot tell them apart hands "nobody has messaged you"
 * downstream as a measurement, and the record keeps it as one.
 *
 * The inbox and the conversation reader did not make that distinction while
 * every reader beside them did. Pinned across the whole layer rather than on
 * the two that were wrong, because the next one added will be wrong the same
 * way unless something says so.
 */
describe('an empty surface is not an unreadable one', () => {
  const root = resolve(__dirname, '../../packages/channels/src/x');

  it('every surface reader checks the page before accepting nothing', () => {
    for (const file of ['messages.ts', 'notifications.ts', 'timelines.ts', 'connections.ts']) {
      const source = readFileSync(resolve(root, file), 'utf8');
      // Each has at least one place where an empty result is questioned rather
      // than returned. The wording differs; the discipline does not.
      const guards = source.match(/length === 0/g)?.length ?? 0;
      expect(guards, `${file} accepts an empty result without asking why`).toBeGreaterThan(0);
      // How it asks is the file's own business. `connections.ts` looks for a
      // user cell and throws its own refusal, which is more precise for a list
      // X will not show a stranger. What matters is that nothing accepts an
      // empty page as an empty answer without establishing which it is.
      const asks = source.includes('refuseIfXBroke') || source.includes('PipelineError.permanent');
      expect(asks, `${file} never establishes whether the page was readable`).toBe(true);
    }
  });

  it('the inbox and a conversation both ask, which is what they did not do', () => {
    const source = readFileSync(resolve(root, 'messages.ts'), 'utf8');
    expect(source).toContain("refuseIfXBroke(session.page, 'the message inbox')");
    expect(source).toContain("refuseIfXBroke(session.page, 'that conversation')");
  });
});
