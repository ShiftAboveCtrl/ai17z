import { describe, expect, it, vi } from 'vitest';
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
    heldSince: null,
    navigations: 0,
    recycled: null,
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

/*
  The failure of 2026-09-15, which these tests would have caught.

  An operation took the mentions tab at 21:19:01 and never gave it back: its
  renderer had run out of memory, the evaluation it was waiting on never
  settled, and nothing existed to take the tab away from it. Fifty-six minutes
  later `busy` was still true, and the three monitors that share that tab --
  mention search, reply search and replies to own posts -- had each failed
  twenty-odd times with "the mentions tab was still busy after 120s".

  A wait had a bound. A hold did not.
*/
describe('an operation that never gives the tab back', () => {
  it('has the tab taken away from it rather than keeping it for ever', async () => {
    vi.useFakeTimers();
    try {
      const tab = fakeTab('MENTIONS');
      // Takes the tab and never releases: the renderer it was talking to is
      // gone, so nothing will ever come back to run the release.
      await lockTab(tab);
      expect(tab.busy).toBe(true);

      await vi.advanceTimersByTimeAsync(181_000);

      expect(tab.busy).toBe(false);
      // And it says why, so the next acquire recycles the tab rather than
      // handing out the same dead renderer.
      expect(tab.lastError).toMatch(/without finishing/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails the operation that was waiting, then works on the next attempt', async () => {
    /*
      Both bounds, in the order they actually fire.

      A waiter gives up at 120s and reports `tab_busy`, which is right: it
      cannot know whether the holder is wedged or merely slow, and a monitor
      that waited indefinitely would be a monitor that never reported anything.
      The hold's own bound is longer, so the holder is given every chance
      first -- and when it does fire, the *next* poll gets a working tab.

      That is the whole difference from the live failure. Before, every later
      poll failed for fifty-six minutes. Now one poll fails and the one after
      it succeeds.
    */
    vi.useFakeTimers();
    try {
      const tab = fakeTab('NOTIFICATIONS');
      await lockTab(tab);

      const waiting = lockTab(tab);
      // The assertion attaches its handler before the timer fires. Advancing
      // first leaves a rejected promise nobody is watching for a moment, which
      // Node reports as an unhandled rejection and which then hides real ones.
      const refused = expect(waiting).rejects.toThrow(/still busy/);
      await vi.advanceTimersByTimeAsync(121_000);
      await refused;

      // The hold's bound fires next, and the tab comes back.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(tab.busy).toBe(false);

      const release = await lockTab(tab);
      expect(tab.busy).toBe(true);
      release();
      expect(tab.busy).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not hand one tab to two operations when the holder returns late', async () => {
    // The wedged holder eventually comes back and releases. That must not hand
    // the tab on a second time, or two operations drive one page at once,
    // which is the failure the queue exists to prevent.
    vi.useFakeTimers();
    try {
      const tab = fakeTab('ACTION');
      const late = await lockTab(tab);
      await vi.advanceTimersByTimeAsync(181_000);
      expect(tab.busy).toBe(false);

      const second = await lockTab(tab);
      expect(tab.busy).toBe(true);

      // The original holder finally returns. Its release belongs to a turn that
      // is over and must do nothing at all.
      late();
      expect(tab.busy).toBe(true);

      second();
      expect(tab.busy).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a wedged tab as failed rather than as busy', async () => {
    // BUSY is what the live panel said for fifty-six minutes, and busy sounds
    // like progress. A hold past its bound is a fault, and health has to say so
    // or nothing escalates.
    const tab = fakeTab('MENTIONS');
    await lockTab(tab);
    tab.heldSince = Date.now() - 20 * 60_000;

    const row = tabHealth(new Map([['MENTIONS', tab]] as [TabRole, TabState][])).find((r) => r.role === 'MENTIONS');
    expect(row?.state).toBe('FAILED');
    expect(row?.lastError).toMatch(/holding this tab for 20 minutes/);
  });

  it('still calls an ordinary in-flight operation busy', async () => {
    const tab = fakeTab('MENTIONS');
    const release = await lockTab(tab);
    const row = tabHealth(new Map([['MENTIONS', tab]] as [TabRole, TabState][])).find((r) => r.role === 'MENTIONS');
    expect(row?.state).toBe('BUSY');
    release();
  });
});
