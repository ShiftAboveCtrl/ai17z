import { describe, expect, it } from 'vitest';
import { acquireTab, type TabMap } from '@xbam/browser';

/**
 * AI17Z opens tabs without taking the screen.
 *
 * ## What this is for, measured
 *
 * `context.newPage()` goes out as CDP `Target.createTarget` with no
 * `background` flag, and Chrome's default for a created target is to activate
 * it. Against a **minimised** Chrome that means the window un-minimises and
 * takes the foreground. Measured on a live browser on 2026-09-16:
 *
 *   background:false   window restored to maximized, foreground STOLEN
 *                      ("Dashboard Home - Brave" -> "about:blank - Google Chrome")
 *   background:true    window stayed minimised, foreground UNCHANGED
 *
 * Which is precisely what an owner sees: they minimise Chrome, AI17Z opens a
 * tab, and Chrome jumps in front of whatever they were doing. Recycling made it
 * more frequent, because recycling opens tabs on purpose.
 *
 * The flag has to be asked for explicitly, so what is testable here without a
 * browser is that it *is* asked for. The window behaviour itself belongs to
 * Chrome and was proved against a real one.
 */

/** A context that records what was asked of CDP and hands back a page. */
function fakeContext(over: { withBrowser?: boolean } = {}) {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  let detached = 0;

  /*
    A page that remembers the URL it was created at.

    That is not decoration: the tab is claimed by a one-off URL, so a fake
    whose every page answers "about:blank" would make the claim look broken
    when it is working, and worse, would make a fake that hands the same
    page to every caller look correct.
  */
  const makePage = (url: string) =>
    ({
      isClosed: () => false,
      url: () => url,
      evaluate: async () => undefined,
      close: async () => undefined,
      on: () => undefined,
    }) as never;

  const fallbackPage = makePage('about:blank');
  const listeners = new Set<(page: unknown) => void>();
  const context = {
    pages: () => [],
    on: (event: string, handler: (page: unknown) => void) => {
      if (event === 'page') listeners.add(handler);
    },
    off: (event: string, handler: (page: unknown) => void) => {
      if (event === 'page') listeners.delete(handler);
    },
    newPage: async () => {
      sent.push({ method: 'context.newPage', params: {} });
      return fallbackPage;
    },
    browser: () =>
      over.withBrowser === false
        ? null
        : {
            newBrowserCDPSession: async () => ({
              send: async (method: string, params: Record<string, unknown>) => {
                sent.push({ method, params });
                // The page event is how Playwright surfaces a target somebody
                // else created, and it reaches every listener rather than
                // only the one that asked for this target.
                const opened = makePage(String(params.url));
                setTimeout(() => {
                  for (const handler of [...listeners]) handler(opened);
                }, 0);
                return {};
              },
              detach: async () => {
                detached += 1;
              },
            }),
          },
  } as never;

  return { context, sent, page: fallbackPage, detachCount: () => detached };
}

describe('opening a tab', () => {
  it('asks Chrome not to bring the window forward', async () => {
    const { context, sent } = fakeContext();
    await acquireTab(context, new Map() as TabMap, 'MENTIONS');

    const created = sent.find((call) => call.method === 'Target.createTarget');
    expect(created).toBeTruthy();
    // The whole fix is this one flag.
    expect(created?.params.background).toBe(true);
  });

  it('never falls back to the activating path when CDP worked', async () => {
    const { context, sent } = fakeContext();
    await acquireTab(context, new Map() as TabMap, 'RESEARCH');
    expect(sent.some((call) => call.method === 'context.newPage')).toBe(false);
  });

  it('releases the CDP session afterwards', async () => {
    // A browser-level session left open is a listener held for the life of the
    // process, on a path that runs every time a tab is recycled.
    const { context, detachCount } = fakeContext();
    await acquireTab(context, new Map() as TabMap, 'ACTION');
    expect(detachCount()).toBe(1);
  });

  it('gives each concurrent caller its own tab', async () => {
    /*
      Three roles lease at once, which is the ordinary startup.

      The `page` event says a page appeared and never which caller asked for
      it, so waiting for "the next page" handed two callers the same tab and
      orphaned the third. `tests/integration/realChrome.test.ts` saw two pages
      where three were leased. Each tab is therefore created at a one-off URL
      and claimed by it.
    */
    const { context, sent } = fakeContext();
    const tabs = new Map() as TabMap;
    const states = await Promise.all([
      acquireTab(context, tabs, 'ACTION'),
      acquireTab(context, tabs, 'MENTIONS'),
      acquireTab(context, tabs, 'NOTIFICATIONS'),
    ]);

    expect(new Set(states.map((state) => state.page)).size).toBe(3);
    expect(states.map((state) => state.role)).toEqual(['ACTION', 'MENTIONS', 'NOTIFICATIONS']);
    // Three tabs asked for, three created, none of them activating.
    const created = sent.filter((call) => call.method === 'Target.createTarget');
    expect(created).toHaveLength(3);
    expect(new Set(created.map((call) => call.params.url)).size).toBe(3);
    expect(sent.some((call) => call.method === 'context.newPage')).toBe(false);
  });

  it('still opens a tab where the background flag is not available', async () => {
    // A Playwright-Chromium persistent context has no browser-level CDP
    // session. A tab that steals focus is worse than the alternative; a tab
    // that never opens is worse than both.
    const { context, sent } = fakeContext({ withBrowser: false });
    const state = await acquireTab(context, new Map() as TabMap, 'NOTIFICATIONS');
    expect(state.role).toBe('NOTIFICATIONS');
    expect(sent.some((call) => call.method === 'context.newPage')).toBe(true);
  });
});
