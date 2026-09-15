import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { authoredBy, xMonitors } from '@xbam/channels';

/**
 * Collecting somebody's writing from a timeline that throws it away as you go.
 *
 * X virtualises a profile timeline: articles scrolled past are **removed from
 * the DOM**, so every read is a window onto the feed rather than the feed. A
 * collector that re-reads the page on each pass and keeps the latest answer is
 * therefore capped at one screenful however far it scrolls -- which is what
 * `readTimeline` does, and is fine for the fifteen posts it wants.
 *
 * "Learn from this account" needs a hundred and sixty. So the collector
 * accumulates across passes and dedupes by status id, and this proves both
 * against a page that behaves the way X does. The first assertion below is the
 * bug: reading once, or reading repeatedly without accumulating, sees a
 * fraction of what is there.
 *
 * Playwright's bundled Chromium, deliberately. It proves nothing about Google
 * Chrome and does not claim to -- only `realChrome.test.ts` may be cited for
 * that. What is being proved here is DOM behaviour, which is the same in both.
 */

const TOTAL = 120;
const WINDOW = 12;

/**
 * A profile timeline that keeps only a window of articles in the DOM.
 *
 * Two things X does, both of which break a naive reader:
 *
 *   - it appends as you scroll, and
 *   - it **removes** what has scrolled out of view.
 *
 * The second is the one that matters. Half the articles belong to somebody else,
 * because `/with_replies` renders the post being answered as well as the answer.
 */
function virtualisedProfile(handle: string, total: number, windowSize: number): string {
  return `<!doctype html>
<html><body style="margin:0">
  <div id="feed"></div>
  <!--
    A spacer that grows with the feed. Without it the page runs out of room to
    scroll once the window has been trimmed a few times, no more scroll events
    fire, and the fixture stops feeding -- which looks exactly like a collector
    that gave up early. The first version of this test failed that way and the
    assertion is what found it.
  -->
  <div id="spacer" style="height:4000px"></div>
  <script>
    const total = ${total};
    const windowSize = ${windowSize};
    const feed = document.getElementById('feed');
    let next = 0;

    function article(n) {
      // Built as a string: a 19-digit id is past what a JS number holds, and
      // arithmetic on one gives every article the same id.
      const id = '19100000000000000' + String(n).padStart(2, '0');
      // Every other article belongs to somebody else, as a replies timeline does.
      const mine = n % 2 === 0;
      const who = mine ? '${handle}' : 'someoneelse' + n;
      const el = document.createElement('article');
      el.setAttribute('data-testid', 'tweet');
      el.innerHTML =
        '<div data-testid="User-Name"><span>Name</span><span>@' + who + '</span></div>' +
        '<a href="/' + who + '/status/' + id + '"><time datetime="2026-09-01T00:00:00Z">now</time></a>' +
        '<div data-testid="tweetText">Post ' + n + ' about ferries and timetables</div>';
      return el;
    }

    function advance(n) {
      for (let i = 0; i < n && next < total; i += 1) {
        feed.appendChild(article(next));
        next += 1;
        // The virtualisation: anything above the window is dropped, exactly as
        // X drops what has scrolled out of view.
        while (feed.children.length > windowSize) feed.removeChild(feed.firstChild);
      }
      // Always somewhere further to go, until the feed genuinely ends.
      const spacer = document.getElementById('spacer');
      spacer.style.height = (next < total ? 4000 + next * 400 : 400) + 'px';
    }

    advance(windowSize);
    window.addEventListener('scroll', () => advance(6), { passive: true });
  </script>
</body></html>`;
}

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function openProfile(handle: string): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(virtualisedProfile(handle, TOTAL, WINDOW));
  return page;
}

/** Scroll and accumulate, which is what the collector does. */
async function collect(page: Page, passes: number) {
  let seen: Awaited<ReturnType<typeof xMonitors.readAllArticles>> = [];
  for (let i = 0; i < passes; i += 1) {
    seen = [...seen, ...(await xMonitors.readAllArticles(page, 120))];
    await page.mouse.wheel(0, 2_400);
    await page.waitForTimeout(120);
  }
  return seen;
}

describe('reading a timeline that discards what it has shown', () => {
  it('sees only a window when it reads once, which is the whole problem', async () => {
    const page = await openProfile('ferryfan');
    const once = await xMonitors.readAllArticles(page, 120);

    expect(once.length).toBeLessThanOrEqual(WINDOW);
    expect(authoredBy('ferryfan', once).length, 'one read already had the corpus').toBeLessThan(10);
    await page.close();
  }, 60_000);

  it('gets far past a screenful by keeping what it has already read', async () => {
    const page = await openProfile('ferryfan');
    const seen = await collect(page, 25);
    const mine = authoredBy('ferryfan', seen);

    // The page holds twelve articles at a time and half of what goes past
    // belongs to somebody else, so anything meaningfully above that could only
    // have come from accumulating.
    expect(mine.length).toBeGreaterThan(WINDOW);
    expect(mine.length).toBeGreaterThan(25);
    await page.close();
  }, 60_000);

  it('counts a post once however many passes re-rendered it', async () => {
    const page = await openProfile('ferryfan');
    const seen = await collect(page, 25);
    const mine = authoredBy('ferryfan', seen);

    // Accumulating means the same article is read several times. The count that
    // matters is distinct posts, and a progress number that climbed on
    // re-renders would be a lie told to somebody watching it.
    const ids = new Set(mine.map((p) => p.statusId));
    expect(ids.size).toBe(mine.length);
    expect(seen.length, 'the raw reads did not overlap, so this proved nothing').toBeGreaterThan(mine.length);
    await page.close();
  }, 60_000);

  it('keeps only what this account wrote', async () => {
    const page = await openProfile('ferryfan');
    const seen = await collect(page, 25);
    const mine = authoredBy('ferryfan', seen);

    expect(mine.length).toBeGreaterThan(0);
    for (const post of mine) {
      expect(post.url, `@${post.statusId} is somebody else's`).toContain('ferryfan');
      expect(post.text).toContain('ferries');
    }
    // And the other half of the page was genuinely there to be wrongly kept.
    const everyone = new Set(seen.map((s) => s.authorHandle));
    expect(everyone.size, 'the fixture only had one author, so the filter proved nothing').toBeGreaterThan(1);
    await page.close();
  }, 60_000);

  it('stops finding new posts once the timeline runs out', async () => {
    // The no-progress signal the collector bounds itself with. A page that has
    // ended keeps answering, and something has to notice that the answer has
    // stopped changing.
    const page = await openProfile('ferryfan');
    const far = await collect(page, 60);
    const mine = authoredBy('ferryfan', far);

    // Half the fixture is this account's, so that is the ceiling. Reaching it
    // and then staying there is what "the timeline ended" looks like.
    expect(mine.length).toBeLessThanOrEqual(TOTAL / 2);
    const more = await collect(page, 5);
    expect(authoredBy('ferryfan', [...far, ...more]).length).toBe(mine.length);
    await page.close();
  }, 90_000);
});
