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
  let detached = false;
  const page = {
    isClosed: () => false,
    url: () => 'about:blank',
    evaluate: async () => undefined,
    close: async () => undefined,
    on: () => undefined,
  } as never;

  const listeners = new Map<string, (page: unknown) => void>();
  const context = {
    pages: () => [],
    once: (event: string, handler: (page: unknown) => void) => {
      listeners.set(event, handler);
    },
    // Resolved by the CDP send below, which is what a real context does when
    // the target actually appears.
    newPage: async () => {
      sent.push({ method: 'context.newPage', params: {} });
      return page;
    },
    browser: () =>
      over.withBrowser === false
        ? null
        : {
            newBrowserCDPSession: async () => ({
              send: async (method: string, params: Record<string, unknown>) => {
                sent.push({ method, params });
                // The page event is how Playwright surfaces a target somebody
                // else created.
                setTimeout(() => listeners.get('page')?.(page), 0);
                return {};
              },
              detach: async () => {
                detached = true;
              },
            }),
          },
  } as never;

  return { context, sent, page, wasDetached: () => detached };
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
    const { context, wasDetached } = fakeContext();
    await acquireTab(context, new Map() as TabMap, 'ACTION');
    expect(wasDetached()).toBe(true);
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
