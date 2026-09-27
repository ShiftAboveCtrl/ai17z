import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { xMonitors } from '@xbam/channels';

/**
 * A monitor must walk past the first screen.
 *
 * X renders a viewport's worth of a timeline and loads the rest on scroll. Every
 * one of the six radar monitors goes through one `harvest`, so reading only what
 * was there on arrival was the ceiling on everything an agent could discover: a
 * burst larger than one screen left the older half unseen, and for the oldest of
 * them, unseen for good.
 *
 * Tested against a synthetic page rather than X, because the property being
 * proved is "it scrolls until it has enough or the page stops growing" and that
 * has nothing to do with X. The page below behaves the way an infinite feed
 * does: a handful of articles at first, more appended as you scroll, and
 * eventually no more.
 *
 * This uses Playwright's bundled Chromium deliberately. It proves nothing about
 * Google Chrome and does not claim to -- only `realChrome.test.ts` may be cited
 * for that.
 */

const TOTAL = 40;
const FIRST_SCREEN = 5;

/** A feed that appends more articles as it is scrolled, then runs out. */
function feedPage(total: number, firstScreen: number): string {
  return `<!doctype html>
<html><body style="margin:0">
  <div id="feed"></div>
  <div style="height:4000px"></div>
  <script>
    const total = ${total};
    const feed = document.getElementById('feed');
    let shown = 0;
    function add(n) {
      for (let i = 0; i < n && shown < total; i += 1) {
        // Built as a string: 19-digit ids exceed what a JS number can hold, so
        // arithmetic on them gives every article the same id.
        const id = '20947000000000000' + String(shown).padStart(2, '0');
        const article = document.createElement('article');
        article.setAttribute('data-testid', 'tweet');
        article.innerHTML =
          '<div data-testid="User-Name"><span>Someone</span><span>@someone' + shown + '</span></div>' +
          '<a href="/someone' + shown + '/status/' + id + '"><time datetime="2026-09-01T00:00:00Z">now</time></a>' +
          '<div data-testid="tweetText">Post number ' + shown + ' about governance and fees</div>';
        feed.appendChild(article);
        shown += 1;
      }
    }
    add(${firstScreen});
    // More arrives only when the reader actually scrolls, exactly as X does.
    window.addEventListener('scroll', () => add(5), { passive: true });
  </script>
</body></html>`;
}

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
}, 60_000);

/**
 * A fresh page per test.
 *
 * Sharing one leaves the scroll position and listeners from the previous feed
 * behind, and `setContent` does not reset either. Two of these tests silently
 * read an empty page because of it -- and one of them still passed, because
 * `not.toContain` is true of nothing at all.
 */
async function freshPage(html: string): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(html);
  return page;
}

afterAll(async () => {
  await browser?.close();
});

describe('a monitor reading a feed longer than one screen', () => {
  it('scrolls until it has what it asked for', async () => {
    const page = await freshPage(feedPage(TOTAL, FIRST_SCREEN));

    // What the first screen alone would have given.
    const rendered = await page.locator('article[data-testid="tweet"]').count();
    expect(rendered).toBe(FIRST_SCREEN);

    const found = await xMonitors.harvestForTest({
      page,
      selfHandles: ['agent'],
      target: null,
      limit: 10,
      cursor: null,
    });

    // Ten asked for, so it had to go well past the five it arrived to.
    expect(found.length).toBe(10);
    expect(await page.locator('article[data-testid="tweet"]').count()).toBeGreaterThan(FIRST_SCREEN);
  }, 60_000);

  it('stops at the newest post it already reconciled', async () => {
    const page = await freshPage(feedPage(TOTAL, FIRST_SCREEN));

    // The third post is the high-water mark: everything below it is old news.
    const found = await xMonitors.harvestForTest({
      page,
      selfHandles: ['agent'],
      target: null,
      limit: 20,
      cursor: '2094700000000000002',
    });

    expect(found.map((c) => c.remoteId)).toEqual(['2094700000000000000', '2094700000000000001']);
  }, 60_000);

  it('gives up when the feed stops growing rather than scrolling forever', async () => {
    // Eight articles and no more, against a request for thirty. An unbounded
    // implementation never returns here.
    const page = await freshPage(feedPage(8, 8));

    const started = Date.now();
    const found = await xMonitors.harvestForTest({
      page,
      selfHandles: ['agent'],
      target: null,
      limit: 30,
      cursor: null,
    });

    expect(found.length).toBe(8);
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it('never returns the account its own posts', async () => {
    const page = await freshPage(feedPage(TOTAL, FIRST_SCREEN));

    // This is what stops an agent holding a conversation with itself, and it
    // has to survive scrolling: a self-post further down is still a self-post.
    const found = await xMonitors.harvestForTest({
      page,
      selfHandles: ['someone7', 'someone12'],
      target: null,
      limit: 15,
      cursor: null,
    });

    // Non-empty first: `not.toContain` is true of an empty array, so without
    // this the assertion passes when nothing was read at all.
    expect(found.length).toBeGreaterThan(5);
    expect(found.map((c) => c.authorHandle)).not.toContain('someone7');
    expect(found.map((c) => c.authorHandle)).not.toContain('someone12');
  }, 60_000);
});

/**
 * X answering with its own error page is not the account being quiet.
 *
 * Every other reader in this package already refuses that: the profile reader,
 * the search reader, the timeline readers, the message readers and the
 * notifications capability all call `refuseIfXBroke` when they come back with
 * nothing. The radar's monitors did not, and the radar is the one thing that
 * runs unattended.
 *
 * On a live installation that produced two surfaces disagreeing about one
 * account. A mention search run by hand said "Something went wrong"; the
 * monitor loaded the same page, read no articles, and was recorded as a
 * healthy poll that found nothing. The owner was shown an error on one screen
 * and a healthy green source on another, and the error was the true one.
 */
describe('a monitor reading a page X could not render', () => {
  const brokeHtml = `<!doctype html>
<html><body style="margin:0">
  <div>Something went wrong. Try reloading.</div>
  <button>Retry</button>
</body></html>`;

  const emptyHtml = `<!doctype html>
<html><body style="margin:0">
  <div>Nothing to see here &mdash; yet</div>
</body></html>`;

  it('reports a failure rather than an empty answer', async () => {
    const page = await freshPage(brokeHtml);

    await expect(
      xMonitors.harvestForTest({ page, selfHandles: ['agent'], target: null, limit: 20, cursor: null }),
    ).rejects.toThrow(/something went wrong/i);
  }, 60_000);

  it('reports the dark logo screen as a stall rather than an empty answer', async () => {
    /*
      What an owner saw when the account was being pushed too hard: a black
      page with the X logo and nothing else, for as long as anybody waited.
      No articles and no error text passed every check this monitor had, so
      the source read HEALTHY with nothing found.
    */
    const page = await freshPage(`<!doctype html>
<html><body style="margin:0;background:#000">
  <div aria-label="Loading" role="img"><svg viewBox="0 0 24 24" width="80"><path d="M0 0h24v24H0z"/></svg></div>
</body></html>`);

    await expect(
      xMonitors.harvestForTest({ page, selfHandles: ['agent'], target: null, limit: 20, cursor: null }),
    ).rejects.toThrow(/never finished drawing/i);
  }, 60_000);

  it('still calls a genuinely quiet surface quiet', async () => {
    // The distinction is the whole point. A surface with nothing on it must
    // not start reporting errors, or the fix is worse than the fault.
    const page = await freshPage(emptyHtml);

    const found = await xMonitors.harvestForTest({
      page,
      selfHandles: ['agent'],
      target: null,
      limit: 20,
      cursor: null,
    });
    expect(found).toEqual([]);
  }, 60_000);
});

/**
 * A search reads what the page itself fetched, counts and all.
 *
 * X refuses its search endpoint to anything but its own app, so the structured
 * read fell back to the drawn page, which has no follower or like counts, and
 * the agent could not tell a large account from an empty one. The page's own
 * request already carries both. Here the search URL and the page's data
 * request are both served locally, so nothing reaches X.
 */
describe('a search monitor', () => {
  const searchResponse = {
    data: {
      search_by_raw_query: {
        search_timeline: {
          timeline: {
            instructions: [
              {
                type: 'TimelineAddEntries',
                entries: [
                  {
                    entryId: 'tweet-1900000000000000901',
                    content: {
                      itemContent: {
                        tweet_results: {
                          result: {
                            __typename: 'Tweet',
                            rest_id: '1900000000000000901',
                            core: {
                              user_results: {
                                result: {
                                  rest_id: '42',
                                  core: { screen_name: 'bigbuilder' },
                                  legacy: { screen_name: 'bigbuilder', followers_count: 184000 },
                                },
                              },
                            },
                            legacy: {
                              full_text: 'Robinhood Chain throughput doubled this week and nobody is talking about it',
                              favorite_count: 412,
                              reply_count: 37,
                              retweet_count: 60,
                              created_at: 'Sat Sep 26 20:00:00 +0000 2026',
                              conversation_id_str: '1900000000000000901',
                            },
                          },
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
  };

  it('keeps the author audience and engagement X sent for the page', async () => {
    const page = await browser.newPage();
    await page.route('https://x.com/search**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><body><div>Latest</div><script>
          fetch('https://x.com/i/api/graphql/abc/SearchTimeline?variables=%7B%7D').then((r) => r.json());
        </script></body></html>`,
      }),
    );
    await page.route('https://x.com/i/api/graphql/**', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(searchResponse) }),
    );

    const result = await xMonitors.X_MONITORS.persona_discovery({
      page,
      selfHandles: ['agent'],
      target: '"Robinhood Chain" min_faves:40',
      limit: 20,
      cursor: null,
    });

    expect(result.error).toBeNull();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ remoteId: '1900000000000000901', authorHandle: 'bigbuilder', authorId: '42' });
    expect(result.candidates[0]!.raw).toMatchObject({
      backend: 'x-page-response',
      author: { followers: 184000 },
      metrics: { likes: 412, replies: 37 },
    });
    await page.close();
  }, 60_000);
});

/**
 * A post with no rendered timestamp still has a knowable age.
 *
 * The notifications surface frequently renders rows carrying no `time` element
 * at all, and the fallback was the clock. That is not "X did not say"; it is a
 * claim that the post was written at the moment AI17Z looked at it.
 */
describe('a feed whose articles carry no timestamp', () => {
  /** The same feed, with the `time` element taken out. */
  function untimedFeed(): string {
    return `<!doctype html>
<html><body style="margin:0">
  <div id="feed"></div>
  <script>
    const feed = document.getElementById('feed');
    const ids = ['2102538437152969003', '2102844317307973872'];
    ids.forEach((id, i) => {
      const article = document.createElement('article');
      article.setAttribute('data-testid', 'tweet');
      article.innerHTML =
        '<div data-testid="User-Name"><span>Someone</span><span>@person' + i + '</span></div>' +
        '<a href="/person' + i + '/status/' + id + '">link</a>' +
        '<div data-testid="tweetText">A question for the agent</div>';
      feed.appendChild(article);
    });
  </script>
</body></html>`;
  }

  it('dates each post from its own id rather than from the clock', async () => {
    const page = await freshPage(untimedFeed());

    const found = await xMonitors.harvestForTest({
      page,
      selfHandles: ['agent'],
      target: null,
      limit: 20,
      cursor: null,
    });

    expect(found.length).toBe(2);
    // The real post times of two real mentions, one of which was answered in
    // public as though it had just arrived.
    expect(found[0]!.occurredAt?.slice(0, 16)).toBe('2026-09-22T23:20');
    expect(found[1]!.occurredAt?.slice(0, 16)).toBe('2026-09-23T19:35');

    // And neither is the moment we looked, which is what was recorded before.
    for (const candidate of found) {
      expect(Date.now() - new Date(candidate.occurredAt!).getTime()).toBeGreaterThan(60_000);
    }
  }, 60_000);
});

/**
 * Reading a whole thread in one pass gives exactly what reading it article by
 * article gives.
 *
 * The per-article reader asks the renderer for each field separately, six or
 * seven round trips an article; on a live installation reading a thread took
 * 30 to 60 seconds of every reply. The single pass is only worth having if it
 * is the same answer, so this compares the two on the same page.
 */
describe('reading a thread in one pass', () => {
  it('returns what the per-article reads return', async () => {
    const { readArticle, readArticles } = await import('../../packages/channels/src/x/page');
    const article = (id: string, handle: string, name: string, text: string, extra = '') => `
      <article data-testid="tweet">
        ${extra}
        <div data-testid="User-Name">${name}<br>@${handle}</div>
        <a href="/${handle}/status/${id}"><time datetime="2026-09-26T20:00:00.000Z">2h</time></a>
        <div data-testid="tweetText">${text}</div>
      </article>`;
    const page = await freshPage(`<!doctype html><html><body>
      ${article('1900000000000000001', 'rootuser', 'Root User', 'The original post about Robinhood Chain')}
      ${article('1900000000000000002', 'middle', 'Middle', 'A reply in between', '<div>Replying to @rootuser</div>')}
      ${article('1900000000000000003', 'asker', 'Asker', 'what do you make of it?', '<div>Replying to @middle @agent</div><div data-testid="User-Name"><span data-testid="icon-verified"></span></div>')}
    </body></html>`);

    const batch = await readArticles(page, 3);
    const oneByOne = [];
    for (let i = 0; i < 3; i += 1) oneByOne.push(await readArticle(page, `article[data-testid="tweet"] >> nth=${i}`, i));
    expect(batch).toEqual(oneByOne);
    expect(batch![2]!.replyingTo).toEqual(['middle', 'agent']);
    expect(batch![0]!.statusId).toBe('1900000000000000001');
  }, 60_000);
});

describe('reading a post that lacks the optional parts', () => {
  /*
    Measured on a live installation: every thread read spent exactly thirty
    seconds in the media inventory, and sixty when the parent was read too,
    because most posts carry no link card and each absent element was waited
    for at Playwright's default timeout.
  */
  it('does not wait for a link card, a video poster or a timestamp that is not there', async () => {
    const { readArticle } = await import('../../packages/channels/src/x/page');
    const { readMediaInventory } = await import('../../packages/channels/src/x/media');
    const page = await freshPage(`<!doctype html><html><body>
      <article data-testid="tweet">
        <div data-testid="User-Name">Plain<br>@plain</div>
        <a href="/plain/status/1900000000000000011">link</a>
        <div data-testid="tweetText">Robinhood Chain throughput is up this week</div>
      </article>
    </body></html>`);
    const anchor = 'article[data-testid="tweet"]:has(a[href*="/status/1900000000000000011"])';

    const started = Date.now();
    const snapshot = await readArticle(page, anchor);
    const inventory = await readMediaInventory(page, anchor, snapshot.text);
    const took = Date.now() - started;

    expect(snapshot.statusId).toBe('1900000000000000011');
    expect(snapshot.createdAt).toBeNull();
    expect(inventory).toEqual({ media: [], quoted: null, links: [] });
    // Two absent timestamp reads and one absent card, each bounded.
    expect(took).toBeLessThan(10_000);
  }, 60_000);
});
