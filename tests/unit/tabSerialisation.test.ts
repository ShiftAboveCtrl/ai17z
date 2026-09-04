import { describe, expect, it } from 'vitest';
import { TAB_ROLES, lockTab, tabHealth, type TabRole, type TabState } from '@xbam/browser';

/**
 * A tab state without a real page.
 *
 * `lockTab` never touches the page: it only orders the callers. So the queue is
 * testable without a browser, which is the point of it being separate from the
 * code that drives one.
 */
function fakeTab(role: TabRole): TabState {
  return {
    role,
    // Enough page for the health snapshot to read; `lockTab` never touches it.
    page: { isClosed: () => false, url: () => `https://x.com/${role.toLowerCase()}` } as never,
    busy: false,
    lastUsedAt: 0,
    lastError: null,
    openedAt: Date.now(),
    queue: Promise.resolve(),
  };
}

/** Something that takes a turn and records the order it ran in. */
async function useTab(state: TabState, name: string, log: string[], ms = 20): Promise<void> {
  const release = await lockTab(state);
  log.push(`${name} start`);
  try {
    await new Promise((resolve) => setTimeout(resolve, ms));
    log.push(`${name} end`);
  } finally {
    release();
  }
}

/**
 * One page doing everything is why reading used to break posting.
 *
 * Different roles run concurrently -- that is the point of having four -- but
 * two operations on the same tab would interleave navigations and produce
 * results from a page neither of them asked for.
 */
describe('two operations on the same tab', () => {
  it('queue behind each other rather than interleaving', async () => {
    const tab = fakeTab('MENTIONS');
    const log: string[] = [];

    await Promise.all([useTab(tab, 'first', log), useTab(tab, 'second', log)]);

    // Never "first start, second start, first end". A navigation begun by one
    // and read by the other is the whole failure this prevents.
    expect(log).toEqual(['first start', 'first end', 'second start', 'second end']);
  });

  it('keep queueing however many arrive at once', async () => {
    const tab = fakeTab('MENTIONS');
    const log: string[] = [];

    await Promise.all(['a', 'b', 'c', 'd'].map((name) => useTab(tab, name, log, 5)));

    for (let i = 0; i < log.length; i += 2) {
      expect(log[i]!.endsWith('start')).toBe(true);
      expect(log[i + 1]).toBe(log[i]!.replace('start', 'end'));
    }
  });

  it('hand the tab on when one of them throws', async () => {
    // A failed operation that kept the lock would wedge the role for good, and
    // the role that wedges is the one doing the most work.
    const tab = fakeTab('ACTION');
    const log: string[] = [];

    const failing = (async () => {
      const release = await lockTab(tab);
      try {
        throw new Error('the page went away');
      } finally {
        release();
      }
    })();

    await expect(failing).rejects.toThrow('the page went away');
    await useTab(tab, 'after', log, 1);
    expect(log).toEqual(['after start', 'after end']);
  });

  it('mark the tab busy while it is held and free afterwards', async () => {
    const tab = fakeTab('ACTION');
    const release = await lockTab(tab);
    expect(tab.busy).toBe(true);
    release();
    expect(tab.busy).toBe(false);
    // And record when, so a stale tab is distinguishable from an idle one.
    expect(tab.lastUsedAt).toBeGreaterThan(0);
  });
});

describe('operations on different tabs', () => {
  it('run at the same time rather than taking turns', async () => {
    const mentions = fakeTab('MENTIONS');
    const action = fakeTab('ACTION');
    const log: string[] = [];

    await Promise.all([useTab(mentions, 'reading', log, 30), useTab(action, 'replying', log, 30)]);

    // Both start before either finishes. A shared lock would serialise these,
    // and an account would then read at the speed of its slowest post.
    expect(log.slice(0, 2).sort()).toEqual(['reading start', 'replying start']);
  });

  it('do not let a busy role make another look busy', async () => {
    const mentions = fakeTab('MENTIONS');
    const action = fakeTab('ACTION');
    const release = await lockTab(mentions);
    expect(mentions.busy).toBe(true);
    expect(action.busy).toBe(false);
    release();
  });
});

describe('what the health snapshot says', () => {
  it('has a row for every role, including ones not open', () => {
    // A role with no tab is a fact worth publishing. Leaving it out makes a
    // missing tab indistinguishable from a healthy one nobody asked about.
    const tabs = new Map([['MENTIONS', fakeTab('MENTIONS')]] as [TabRole, TabState][]);
    const health = tabHealth(tabs);
    expect(health.map((row) => row.role).sort()).toEqual([...TAB_ROLES].sort());
  });

  it('opens nothing to answer', () => {
    // It is called from a ten-second loop. A snapshot that opened a tab would
    // create the four tabs it was meant to be reporting on.
    const tabs = new Map<TabRole, TabState>();
    expect(() => tabHealth(tabs)).not.toThrow();
    expect(tabs.size).toBe(0);
  });
});
