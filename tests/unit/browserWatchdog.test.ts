import { describe, expect, it } from 'vitest';
import {
  browserUsable,
  orphanTabs,
  diagnoseBrowser,
  diagnoseTab,
  MAX_RECOVERY_ATTEMPTS,
  RESPONSE_BUDGET_MS,
  STUCK_NAVIGATION_MS,
  type TabProbe,
} from '@xbam/browser';

const probe = (over: Partial<TabProbe> = {}): TabProbe => ({
  role: 'MENTIONS',
  present: true,
  closed: false,
  onErrorPage: false,
  respondedMs: 40,
  ...over,
});

/**
 * Every failure here has the same shape: the browser is technically present
 * and functionally dead, so nothing throws, health looks fine, and the agent
 * reports itself running while no work is possible.
 *
 * That is how a real session sat for four hours saying CONNECTED while every
 * poll failed on a debugging port nothing was listening to.
 */
describe('what is wrong with one tab', () => {
  it('a healthy tab needs nothing', () => {
    const verdict = diagnoseTab(probe());
    expect(verdict.ailment).toBe('HEALTHY');
    expect(verdict.remedy).toBe('NONE');
  });

  it('no tab yet is not a fault', () => {
    // A role gets its tab the first time something needs it.
    const verdict = diagnoseTab(probe({ present: false }));
    expect(verdict.ailment).toBe('MISSING');
    expect(verdict.remedy).toBe('NONE');
  });

  it('a closed tab is rebuilt', () => {
    expect(diagnoseTab(probe({ closed: true })).remedy).toBe('RECREATE_TAB');
  });

  it('an error page is recognised as a killed renderer', () => {
    const verdict = diagnoseTab(probe({ onErrorPage: true }));
    expect(verdict.ailment).toBe('CRASHED');
    expect(verdict.detail).toMatch(/memory/i);
    expect(verdict.remedy).toBe('RECREATE_TAB');
  });

  it('a tab that never answers is gone, not slow', () => {
    // The distinction matters: every read against it returns nothing rather
    // than failing, so the monitor reports success and finds no mentions.
    const verdict = diagnoseTab(probe({ respondedMs: null }));
    expect(verdict.ailment).toBe('UNRESPONSIVE');
    expect(verdict.remedy).toBe('RECREATE_TAB');
  });

  it('a tab slower than the budget is unresponsive', () => {
    expect(diagnoseTab(probe({ respondedMs: RESPONSE_BUDGET_MS + 1 })).ailment).toBe('UNRESPONSIVE');
    expect(diagnoseTab(probe({ respondedMs: RESPONSE_BUDGET_MS - 1 })).ailment).toBe('HEALTHY');
  });

  it('a navigation that never finishes is stuck', () => {
    expect(diagnoseTab(probe({ onSameUrlMs: STUCK_NAVIGATION_MS + 1 })).ailment).toBe('STUCK');
  });

  it('a monitor parked on one timeline is not stuck', () => {
    // Sitting on a page nobody asked to move is the normal case, and treating
    // it as a fault would rebuild the mention tab every few minutes.
    expect(diagnoseTab(probe({ onSameUrlMs: 60_000 })).ailment).toBe('HEALTHY');
  });

  it('stops rebuilding a tab that will not come back', () => {
    const verdict = diagnoseTab(probe({ closed: true, attempts: MAX_RECOVERY_ATTEMPTS }));
    expect(verdict.remedy).toBe('GIVE_UP');
    expect(verdict.detail).toMatch(/has not helped/i);
  });
});

describe('what is wrong with the browser', () => {
  const roles = (over: Partial<TabProbe>[] = []) =>
    (['ACTION', 'MENTIONS', 'NOTIFICATIONS', 'RESEARCH'] as const).map((role, i) => probe({ role, ...(over[i] ?? {}) }));

  it('all four healthy is usable', () => {
    const verdict = diagnoseBrowser({ connected: true, tabs: roles() });
    expect(verdict.usable).toBe(true);
    expect(verdict.remedy).toBe('NONE');
  });

  it('a dropped connection is the browser, not the tabs', () => {
    const verdict = diagnoseBrowser({ connected: false, tabs: roles() });
    expect(verdict.usable).toBe(false);
    expect(verdict.remedy).toBe('RECONNECT_BROWSER');
    expect(verdict.detail).toMatch(/connection/i);
  });

  it('a dead Chrome process is named as such', () => {
    const verdict = diagnoseBrowser({ connected: true, processAlive: false, tabs: roles() });
    expect(verdict.remedy).toBe('RECONNECT_BROWSER');
    expect(verdict.detail).toMatch(/no longer running/i);
  });

  it('one dead role does not take the others with it', () => {
    // A crashed research tab must not end a sign-in halfway through on ACTION.
    const verdict = diagnoseBrowser({
      connected: true,
      tabs: roles([{}, {}, {}, { onErrorPage: true }]),
    });
    expect(verdict.remedy).toBe('RECREATE_TAB');
    expect(verdict.roles.find((r) => r.role === 'ACTION')!.ailment).toBe('HEALTHY');
    expect(verdict.roles.find((r) => r.role === 'RESEARCH')!.ailment).toBe('CRASHED');
    expect(verdict.usable).toBe(false);
  });

  it('every tab failing at once is diagnosed as the browser', () => {
    // Rebuilding four tabs inside a browser that has gone is four failures
    // instead of one.
    const verdict = diagnoseBrowser({
      connected: true,
      tabs: roles([{ respondedMs: null }, { respondedMs: null }, { respondedMs: null }, { respondedMs: null }]),
    });
    expect(verdict.remedy).toBe('RECONNECT_BROWSER');
    expect(verdict.detail).toMatch(/browser rather than the tabs/i);
  });

  it('reports every role, including the ones not open yet', () => {
    const verdict = diagnoseBrowser({ connected: true, tabs: roles([{ present: false }]) });
    expect(verdict.roles).toHaveLength(4);
    expect(verdict.roles[0]!.ailment).toBe('MISSING');
  });

  it('gives up loudly rather than looping', () => {
    const verdict = diagnoseBrowser({
      connected: true,
      tabs: roles([{ closed: true, attempts: MAX_RECOVERY_ATTEMPTS }]),
    });
    expect(verdict.remedy).toBe('GIVE_UP');
    expect(verdict.usable).toBe(false);
    expect(verdict.detail).toMatch(/until somebody looks/i);
  });
});

describe('whether an agent may call itself able to work', () => {
  const healthy = () => diagnoseBrowser({ connected: true, tabs: [] });

  it('is false without a verdict at all', () => {
    expect(browserUsable(null, 0)).toBe(false);
  });

  it('is false for a stale snapshot, however good it looked', () => {
    // A session object outlives the browser behind it. Reporting on the object
    // is exactly how an agent claimed to be running for four hours while every
    // poll failed.
    expect(browserUsable(healthy(), 91_000)).toBe(false);
    expect(browserUsable(healthy(), 30_000)).toBe(true);
  });

  it('is false whenever the browser is not usable', () => {
    const dead = diagnoseBrowser({ connected: false, tabs: [] });
    expect(browserUsable(dead, 0)).toBe(false);
  });
});

/**
 * A real profile was found holding fifteen pages, twelve of them the same
 * timeline. That is several gigabytes of browser doing the work of four tabs,
 * and it is what an out-of-memory kill looks like in the hours before it
 * happens.
 *
 * They accumulate across restarts: a worker that dies without closing its tabs
 * leaves them, and the next one cannot recognise them because a cross-origin
 * navigation cleared the window.name it identified them by.
 */
describe('tabs no role is using', () => {
  const page = (url: string, isRole = false) => ({ url, isRole });

  it('leaves a browser with only its role tabs alone', () => {
    const pages = [page('https://x.com/home', true), page('https://x.com/notifications', true)];
    expect(orphanTabs({ pages })).toEqual([]);
  });

  it('closes the duplicates that built up, keeping one spare', () => {
    const pages = [
      page('https://x.com/home', true),
      page('https://x.com/search?q=x', true),
      ...Array.from({ length: 11 }, () => page('https://x.com/home')),
    ];
    // Eleven orphans, ten closed, one left in case somebody is looking at it.
    expect(orphanTabs({ pages })).toHaveLength(10);
  });

  it('never closes a sign-in, whatever else is true', () => {
    // Sign-in is always the person's job and a half-finished one cannot be
    // given back.
    const pages = [
      page('https://x.com/i/flow/login'),
      page('https://x.com/account/access'),
      page('https://x.com/home'),
      page('https://x.com/home'),
      page('https://x.com/home'),
    ];
    const closing = orphanTabs({ pages }).map((i) => pages[i]!.url);
    expect(closing.every((url) => !/login|access/.test(url))).toBe(true);
  });

  it('never closes a composer holding unsent text', () => {
    const pages = [page('https://x.com/compose/post'), page('https://x.com/home'), page('https://x.com/home')];
    const closing = orphanTabs({ pages }).map((i) => pages[i]!.url);
    expect(closing.every((url) => !url.includes('compose'))).toBe(true);
  });

  it('ignores a blank tab, which is just what Chrome opens with', () => {
    const pages = [page('about:blank'), page(''), page('https://x.com/home'), page('https://x.com/home')];
    expect(orphanTabs({ pages }).every((i) => pages[i]!.url.startsWith('https://'))).toBe(true);
  });
});

/*
  The failure of 2026-09-15, as tests.

  A live installation's mentions renderer ran out of memory. The operation
  holding that tab never finished and never released it, so `busy` stayed true
  for fifty-six minutes and the three monitors that share the mentions tab --
  mention search, reply search and replies to own posts -- failed every two
  minutes for the whole afternoon. Notifications, which has its own tab, stayed
  perfectly healthy the entire time and reported so.

  Nothing diagnosed it, because the tab was `BUSY`, and busy sounds like work.
*/
describe('a tab one operation will not let go of', () => {
  it('is a fault with a name, not a tab that is merely busy', () => {
    const verdict = diagnoseTab(probe({ heldMs: 6 * 60_000 }));
    expect(verdict.ailment).toBe('HELD');
    expect(verdict.remedy).toBe('RECREATE_TAB');
    // The sentence has to explain the failed polls, because that is what the
    // owner is actually looking at.
    expect(verdict.detail).toMatch(/holding this tab for 6 minutes/);
    expect(verdict.detail).toMatch(/waiting for it has failed/);
  });

  it('leaves an ordinary operation alone', () => {
    // A monitor legitimately holds the tab while it reads a timeline.
    expect(diagnoseTab(probe({ heldMs: 20_000 })).ailment).toBe('HEALTHY');
  });

  it('says nothing about a tab nothing is holding', () => {
    expect(diagnoseTab(probe({ heldMs: null })).ailment).toBe('HEALTHY');
    expect(diagnoseTab(probe({})).ailment).toBe('HEALTHY');
  });
});

describe('a renderer about to be killed for memory', () => {
  it('is caught before it crashes, not after', () => {
    // The whole point: a crashed renderer has already taken its monitors with
    // it. One at 90% can still be replaced in an orderly way.
    const verdict = diagnoseTab(probe({ heapFraction: 0.9 }));
    expect(verdict.ailment).toBe('OUT_OF_MEMORY');
    expect(verdict.remedy).toBe('RECREATE_TAB');
    expect(verdict.detail).toMatch(/90% of the memory this renderer is allowed/);
  });

  it('leaves a renderer with room alone', () => {
    expect(diagnoseTab(probe({ heapFraction: 0.4 })).ailment).toBe('HEALTHY');
  });

  it('does not invent a verdict on an engine that will not say', () => {
    // Absent is not zero and it is not full either.
    expect(diagnoseTab(probe({ heapFraction: null })).ailment).toBe('HEALTHY');
  });

  it('still reports a tab that already crashed', () => {
    const verdict = diagnoseTab(probe({ onErrorPage: true }));
    expect(verdict.ailment).toBe('CRASHED');
    expect(verdict.remedy).toBe('RECREATE_TAB');
  });
});

describe('one role failing is not four roles failing', () => {
  it('recreates only the tab that is wrong', () => {
    // The shape of the live failure: three monitors share MENTIONS and all
    // three died; NOTIFICATIONS has its own tab and was fine. Recovery must
    // not touch the healthy one.
    const mentions = diagnoseTab(probe({ role: 'MENTIONS', heldMs: 9 * 60_000 }));
    const notifications = diagnoseTab(probe({ role: 'NOTIFICATIONS' }));
    expect(mentions.remedy).toBe('RECREATE_TAB');
    expect(notifications.remedy).toBe('NONE');
  });

  it('stops rebuilding a role that rebuilding does not fix', () => {
    const verdict = diagnoseTab(probe({ heldMs: 9 * 60_000, attempts: MAX_RECOVERY_ATTEMPTS }));
    expect(verdict.remedy).toBe('GIVE_UP');
    expect(verdict.detail).toMatch(/has not helped/);
  });
});
