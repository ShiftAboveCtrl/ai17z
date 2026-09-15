import { describe, expect, it } from 'vitest';
import {
  PERSONA_MINIMUM_POSTS,
  PERSONA_TARGET_POSTS,
  authoredBy,
  normaliseHandle,
} from '@xbam/channels';
import type { xMonitors } from '@xbam/channels';

type Seen = ReturnType<typeof xMonitors.readAllArticles> extends Promise<(infer T)[]> ? T : never;

/**
 * Which of the things on a profile page that account actually wrote.
 *
 * "Learn from this account" did not work, and the reason was not subtle: it was
 * wired to **twscrape**, a Python library the owner has to install, put on PATH
 * inside the worker, and seed with X accounts of their own. A packaged AI17Z has
 * no Python, so availability answered "no" on every installation, the sync
 * stored nothing, and the button appeared to do nothing.
 *
 * It now reads through the signed-in Chrome AI17Z already drives for the reply
 * pipeline. These tests cover the part where the judgement is -- deciding what
 * on the page is this person's writing -- because that is pure and can be
 * pinned, while the scrolling needs a browser and is covered by
 * `tests/integration/realChrome.test.ts`.
 */

/** An article as `readAllArticles` reports one. */
const seen = (over: Partial<Seen> & { statusId: string }): Seen => ({
  authorHandle: 'someone',
  text: 'Words.',
  url: null,
  createdAt: null,
  ...over,
});

describe('reading a handle somebody typed', () => {
  it('takes the shapes people actually paste', () => {
    for (const raw of ['jack', '@jack', ' @jack ', 'https://x.com/jack', 'https://twitter.com/jack', 'x.com/jack'.replace('x.com/', 'https://x.com/')]) {
      expect(normaliseHandle(raw), raw).toBe('jack');
    }
    // A profile URL with something after it is still that profile.
    expect(normaliseHandle('https://x.com/jack/with_replies')).toBe('jack');
    expect(normaliseHandle('https://x.com/jack?lang=en')).toBe('jack');
  });

  it('refuses what is not a handle rather than searching for it', () => {
    // An invalid handle that reaches the browser produces a profile page for
    // somebody else, or X's search results, and either one would be collected
    // as though it were the account asked for.
    for (const raw of ['', '@', 'not a handle', 'sixteencharacter', 'has-a-dash', 'two words']) {
      expect(normaliseHandle(raw), raw).toBeNull();
    }
    // A doubled @ is a keystroke, not a different account, and there is
    // exactly one thing it can have meant.
    expect(normaliseHandle('@@jack')).toBe('jack');
  });
});

describe('what counts as this account writing', () => {
  it('keeps their posts and drops everybody else on the page', () => {
    // `/with_replies` renders the post being answered as well as the answer, so
    // roughly half of what is on screen belongs to somebody else.
    const posts = authoredBy('jack', [
      seen({ statusId: '1', authorHandle: 'jack', text: 'Mine.' }),
      seen({ statusId: '2', authorHandle: 'someoneelse', text: 'Theirs.' }),
      seen({ statusId: '3', authorHandle: 'JACK', text: 'Also mine, differently cased.' }),
    ]);
    expect(posts.map((p) => p.statusId)).toEqual(['1', '3']);
  });

  it('drops a repost, because pressing repost is not writing', () => {
    // X renders a repost under the original author's handle, so the author
    // filter is what removes it -- and that is the right answer rather than a
    // lucky one: the words are genuinely somebody else's.
    const posts = authoredBy('jack', [
      seen({ statusId: '10', authorHandle: 'someoneelse', text: 'A post jack reposted.' }),
    ]);
    expect(posts).toHaveLength(0);
  });

  it('keeps a quote, because the comment on it is theirs', () => {
    const posts = authoredBy('jack', [
      seen({ statusId: '11', authorHandle: 'jack', text: 'This is exactly right.', isQuote: true }),
    ]);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.kind).toBe('quote');
  });

  it('marks a reply as one, because conversational voice is the valuable part', () => {
    const posts = authoredBy('jack', [
      seen({ statusId: '12', authorHandle: 'jack', text: 'fair', isReply: true }),
      seen({ statusId: '13', authorHandle: 'jack', text: 'A thought of my own.' }),
    ]);
    expect(posts.find((p) => p.statusId === '12')!.kind).toBe('reply');
    expect(posts.find((p) => p.statusId === '13')!.kind).toBe('post');
  });

  it('drops an article with no words in it', () => {
    // An image-only post says nothing about how somebody writes.
    const posts = authoredBy('jack', [
      seen({ statusId: '14', authorHandle: 'jack', text: '' }),
      seen({ statusId: '15', authorHandle: 'jack', text: '   ' }),
    ]);
    expect(posts).toHaveLength(0);
  });

  it('counts a post once however many times the page re-rendered it', () => {
    // The whole reason collection accumulates rather than replaces: a
    // virtualised timeline hands back the same articles on every scroll pass,
    // so without this the count would climb while the corpus did not.
    const same = seen({ statusId: '20', authorHandle: 'jack', text: 'Said once.' });
    const posts = authoredBy('jack', [same, same, same, { ...same }]);
    expect(posts).toHaveLength(1);
  });

  it('keeps what was read in the order it was read', () => {
    const posts = authoredBy('jack', [
      seen({ statusId: '30', authorHandle: 'jack', text: 'First.' }),
      seen({ statusId: '31', authorHandle: 'jack', text: 'Second.' }),
      seen({ statusId: '32', authorHandle: 'jack', text: 'Third.' }),
    ]);
    expect(posts.map((p) => p.text)).toEqual(['First.', 'Second.', 'Third.']);
  });

  it('gives every post somewhere to point at', () => {
    // Provenance is the point of the archive: a derived trait cites the posts
    // it came from, and a citation with no URL cannot be checked.
    const posts = authoredBy('jack', [seen({ statusId: '40', authorHandle: 'jack', text: 'Words.' })]);
    expect(posts[0]!.url).toContain('40');
  });
});

describe('how much is worth collecting', () => {
  it('has a target and a floor, and they are the right way round', () => {
    expect(PERSONA_TARGET_POSTS).toBeGreaterThan(PERSONA_MINIMUM_POSTS);
    // Both are product decisions rather than constants of nature, so they are
    // asserted as a band rather than as exact numbers: the point is that the
    // target is a substantial corpus and the floor is small but not trivial.
    expect(PERSONA_TARGET_POSTS).toBeGreaterThanOrEqual(100);
    expect(PERSONA_MINIMUM_POSTS).toBeGreaterThanOrEqual(20);
  });
});
