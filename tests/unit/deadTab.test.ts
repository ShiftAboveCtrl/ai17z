import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import type { TAB_ROLES } from '@xbam/browser';
import { acquireTab, isDeadPage, tabHealth, type TabMap, type TabState } from '@xbam/browser';

/** The parts of a Page this logic touches, and nothing else. */
function fakePage(url: string, closed = false): Page {
  return {
    isClosed: () => closed,
    url: () => {
      if (closed) throw new Error('page is closed');
      return url;
    },
  } as unknown as Page;
}

function tabs(entries: Partial<Record<(typeof TAB_ROLES)[number], Page>>): TabMap {
  const map: TabMap = new Map();
  for (const [role, page] of Object.entries(entries)) {
    map.set(role as (typeof TAB_ROLES)[number], {
      role: role as (typeof TAB_ROLES)[number],
      page: page!,
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
      lastError: null,
      queue: Promise.resolve(),
      busy: false,
      heldSince: null,
      navigations: 0,
      recycled: null,
    } satisfies TabState);
  }
  return map;
}

/**
 * On 2026-09-03 a session died with "Error code: Out of Memory". Chrome does not
 * close a tab whose renderer it kills -- it navigates it to an internal error
 * page. So `isClosed()` stayed false, every call kept resolving, the monitor
 * read zero mentions, and health reported READY for four hours.
 */
describe('a tab whose renderer was killed', () => {
  it('is recognised as dead even though it is open', () => {
    expect(isDeadPage(fakePage('chrome-error://chromewebdata/'))).toBe(true);
    expect(isDeadPage(fakePage('edge-error://something'))).toBe(true);
  });

  it('counts a closed tab as dead too', () => {
    expect(isDeadPage(fakePage('https://x.com/home', true))).toBe(true);
  });

  it('treats a page that cannot say where it is as dead', () => {
    const hostile = { isClosed: () => false, url: () => { throw new Error('destroyed'); } } as unknown as Page;
    expect(isDeadPage(hostile)).toBe(true);
  });

  it('leaves a working tab alone', () => {
    for (const url of ['https://x.com/home', 'https://x.com/notifications', 'https://search.brave.com/ask?q=x', 'about:blank']) {
      expect(isDeadPage(fakePage(url))).toBe(false);
    }
  });

  it('reports FAILED rather than READY, which is the whole point', () => {
    const health = tabHealth(tabs({ MENTIONS: fakePage('chrome-error://chromewebdata/') }));
    const mentions = health.find((h) => h.role === 'MENTIONS');
    expect(mentions?.state).toBe('FAILED');
    expect(mentions?.lastError).toMatch(/out of memory/i);
  });

  it('still reports a healthy tab as READY', () => {
    const health = tabHealth(tabs({ ACTION: fakePage('https://x.com/home') }));
    expect(health.find((h) => h.role === 'ACTION')?.state).toBe('READY');
  });

  it('does not turn one dead tab into a dead browser', () => {
    // Recovery is per role. A crashed research tab must not take the sign-in
    // somebody is halfway through on the action tab with it.
    const health = tabHealth(
      tabs({ ACTION: fakePage('https://x.com/compose'), RESEARCH: fakePage('chrome-error://chromewebdata/') }),
    );
    expect(health.find((h) => h.role === 'ACTION')?.state).toBe('READY');
    expect(health.find((h) => h.role === 'RESEARCH')?.state).toBe('FAILED');
    expect(health.find((h) => h.role === 'MENTIONS')?.state).toBe('MISSING');
  });
});

/*
  One role, one tab.

  A live installation was found holding two pages tagged MENTIONS: one in use,
  and one orphaned at 3,242 MB that nothing would look at again or close. They
  come from a recreation that half succeeded, where the old page dropped out of
  the map without being closed and the next pass tagged a new one beside it.
*/
describe('duplicate role tabs', () => {
  it('keeps one and closes the rest', async () => {
    const closed: string[] = [];
    const tagged = (id: string) =>
      ({
        isClosed: () => false,
        url: () => `https://x.com/${id}`,
        evaluate: async () => 'ai17z-tab:MENTIONS',
        close: async () => {
          closed.push(id);
        },
        on: () => undefined,
      }) as never;

    const context = {
      pages: () => [tagged('first'), tagged('leftover'), tagged('another')],
      newPage: async () => tagged('new'),
    } as never;

    const tabs = new Map();
    const state = await acquireTab(context, tabs, 'MENTIONS');

    // The survivor is the first, and the other two are shut rather than left
    // holding memory nothing will ever reclaim.
    expect(state.page.url()).toBe('https://x.com/first');
    expect(closed.sort()).toEqual(['another', 'leftover']);
  });

  it('leaves a single tagged tab alone', async () => {
    const closed: string[] = [];
    const only = {
      isClosed: () => false,
      url: () => 'https://x.com/only',
      evaluate: async () => 'ai17z-tab:MENTIONS',
      close: async () => {
        closed.push('only');
      },
      on: () => undefined,
    } as never;

    const context = { pages: () => [only], newPage: async () => only } as never;
    await acquireTab(context, new Map(), 'MENTIONS');
    expect(closed).toEqual([]);
  });
});
