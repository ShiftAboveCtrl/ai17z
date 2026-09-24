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
