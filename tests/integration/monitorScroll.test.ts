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
