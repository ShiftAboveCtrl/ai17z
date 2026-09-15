import type { BrowserContext, Page } from 'playwright';
import { PipelineError, createLogger, errorMessage } from '@xbam/shared';
import { reconcileTabs } from './reconcile';

const log = createLogger('browser-tabs');

/**
 * Four tabs, each with one job.
 *
 * One page doing everything is why reading used to break posting. A monitor
 * navigating to the notifications timeline while a reply composer was open
 * would discard the composer; an action navigating to a status page would throw
 * away the monitor's scroll position and its place in the timeline. Neither
 * failure is visible in a log — the work simply comes back empty.
 *
 * So the account gets four persistent tabs in the one browser:
 *
 *   ACTION         replies, posts, and the target verification before them
 *   MENTIONS       mention and reply discovery, and the agent's own threads
 *   NOTIFICATIONS  X's own notifications surface, as an independent source
 *   RESEARCH       looking things up off X, so an agent asked about something
 *                  that happened this morning is not limited to whatever its
 *                  model was trained on
 *
 * A tab is identified by `window.name` first, and by what it is showing when
 * that has gone. The tag alone was the whole defence and it is not durable: a
 * cross-origin navigation clears it, `retagIfLost` puts it back, and a worker
 * that dies in the gap leaves a good tab nothing can recognise. The next worker
 * opens its own beside it, which is how one profile came to hold fifteen pages,
 * twelve of them the same timeline, until Chrome was killed for memory.
 *
 * See `reconcile.ts` for how identity is decided, and what is never touched.
 */

export type TabRole = 'ACTION' | 'MENTIONS' | 'NOTIFICATIONS' | 'RESEARCH';

export const TAB_ROLES: readonly TabRole[] = ['ACTION', 'MENTIONS', 'NOTIFICATIONS', 'RESEARCH'] as const;

/** Written into `window.name`, which survives navigation within an origin. */
const TAG_PREFIX = 'ai17z-tab:';

/**
 * How long to wait for another operation to finish with a tab.
 *
 * Long enough for a slow status page and a typed reply; short enough that a
 * wedged operation surfaces as a retryable error rather than a worker that has
 * quietly stopped doing anything.
 */
const TAB_WAIT_MS = 120_000;

/**
 * How long one operation may hold a tab before it is taken away from it.
 *
 * The defect this exists for, measured on a live installation on 2026-09-15:
 * the mentions renderer ran out of memory, the operation holding the tab never
 * finished and never released, and `state.busy` stayed true for **fifty-six
 * minutes**. Three monitors -- mention search, reply search and replies to own
 * posts, all of which share that one tab -- failed every two minutes for the
 * whole of it, while notifications, which has its own tab, stayed perfectly
 * healthy. The tab health snapshot said `BUSY`, not `FAILED`, so nothing
 * escalated.
 *
 * A wait has a bound and a hold did not. Longer than `TAB_WAIT_MS`, because a
 * holder that is merely slow must not be robbed by the waiter it is keeping;
 * short enough that a wedged renderer costs one cycle rather than an afternoon.
 */
const TAB_HOLD_MS = 180_000;

/**
 * How long a renderer gets to answer before it is presumed wedged.
 *
 * An out-of-memory renderer does not close its tab and does not always raise
 * Playwright's `crash`. What it does is stop answering: `page.evaluate` hangs
 * rather than throwing. Everything that probes a tab's health therefore has to
 * carry its own deadline, or the health check wedges on the thing it is
 * checking.
 */
const PROBE_MS = 5_000;

/**
 * How many navigations a tab gets before it is recycled regardless of heap.
 *
 * X's own bundles retain search results across navigations, and a forced
 * collection on a 3,801 MB mentions renderer reclaimed 24 MB -- the memory is
 * genuinely held, not waiting to be collected, and none of it is ours to free.
 * Since the leak cannot be fixed from outside, the renderer's *lifetime* is
 * what gets bounded instead.
 */
const MAX_NAVIGATIONS = 150;

export interface TabState {
  role: TabRole;
  page: Page;
  openedAt: number;
  lastUsedAt: number;
  lastError: string | null;
  /** Tail of the queue of operations on this tab. */
  queue: Promise<void>;
  busy: boolean;
  /**
   * When the current holder took it, so a hold can be bounded.
   *
   * Null when nothing holds it. Not derived from `lastUsedAt`, which moves on
   * release and so says nothing about how long something has been holding on.
   */
  heldSince: number | null;
  /** How many times this tab has been navigated, for lifetime recycling. */
  navigations: number;
  /** Why it was recycled, when it was, for the owner-facing panel. */
  recycled: { at: number; because: string } | null;
}

/** What a renderer is holding, where the platform will say. */
export interface TabMemory {
  usedBytes: number;
  limitBytes: number;
  /** Used over the limit V8 will not let it cross. */
  fraction: number;
}

/** What one tab is doing, for the account's browser panel. */
export interface TabHealth {
  role: TabRole;
  state: 'READY' | 'BUSY' | 'MISSING' | 'FAILED';
  url: string | null;
  openedAt: string | null;
  lastUsedAt: string | null;
  lastError: string | null;
  /**
   * Why this tab was replaced, when it was, in a sentence.
   *
   * Recovery an owner cannot see is indistinguishable from a fault. Without
   * this, a renderer running out of memory and being replaced correctly shows
   * up as a run of failed polls and nothing else, which is what made the live
   * failure take a CDP probe to explain.
   */
  recycled: { at: string; because: string } | null;
}

export type TabMap = Map<TabRole, TabState>;

function tagFor(role: TabRole): string {
  return `${TAG_PREFIX}${role}`;
}

/** Reads the role a page was tagged with, if it still carries one. */
async function readTag(page: Page): Promise<TabRole | null> {
  if (page.isClosed()) return null;
  try {
    // `globalThis.name` is `window.name` inside the page. Reached this way so
    // this package needs no DOM lib for one property.
    const name = await page.evaluate(() => (globalThis as unknown as { name: string }).name);
    if (typeof name !== 'string' || !name.startsWith(TAG_PREFIX)) return null;
    const role = name.slice(TAG_PREFIX.length) as TabRole;
    return TAB_ROLES.includes(role) ? role : null;
  } catch {
    // A page mid-navigation cannot be evaluated in. Treating that as untagged
    // is safe: the caller falls through to creating one, and the stale tab is
    // reclaimed on a later pass.
    return null;
  }
}

async function writeTag(page: Page, role: TabRole): Promise<void> {
  try {
    await page.evaluate((name) => {
      (globalThis as unknown as { name: string }).name = name;
    }, tagFor(role));
  } catch (error) {
    // Not fatal. The in-process map still knows this page's role for as long as
    // this worker lives; the tag only matters across a reattach.
    log.debug('could not tag tab', { role, message: errorMessage(error) });
  }
}

/**
 * Re-tags a page after navigation.
 *
 * Browsers clear `window.name` on a cross-origin navigation, so a tab that
 * wandered off x.com and back would come home anonymous and be adopted by
 * nobody. Called after every navigation the session layer performs.
 */
export async function retagIfLost(page: Page, role: TabRole): Promise<void> {
  if (page.isClosed()) return;
  if ((await readTag(page)) === role) return;
  await writeTag(page, role);
}

/**
 * Finds the page already serving a role, adopting one from the browser when
 * this process has no record of it.
 *
 * `preferUntagged` exists for ACTION specifically: a freshly launched browser
 * has one blank tab, and turning that into the action tab is better than
 * leaving it orphaned beside three new ones.
 */
async function findExisting(context: BrowserContext, role: TabRole): Promise<Page | null> {
  const pages = context.pages().filter((p) => !p.isClosed());
  for (const page of pages) {
    if ((await readTag(page)) === role) return page;
  }

  if (role === 'ACTION') {
    const tags = await Promise.all(pages.map((p) => readTag(p)));
    const untagged = pages.find((_, index) => tags[index] === null);
    if (untagged) return untagged;
  }
  return null;
}

/**
 * Claims tabs already open in a browser this process did not start.
 *
 * Attaching to a running Chrome finds whatever the last worker left: tagged
 * tabs, which are adopted by role, and sometimes an untagged one. An untagged
 * page is usually the action tab after a navigation cleared its `window.name`,
 * and leaving it that way is only a reporting problem right up until it is not:
 * health says ACTION is MISSING while the tab sits there, and the next
 * adoption is a guess between it and any tab a person opened themselves.
 *
 * Called once when a session is established, so the reported state matches the
 * browser from the first health snapshot rather than from the first action.
 */
export async function adoptOpenTabs(context: BrowserContext, tabs: TabMap): Promise<void> {
  const pages = context.pages().filter((p) => !p.isClosed());
  const tags = await Promise.all(pages.map((p) => readTag(p)));

  const described = pages.map((page, index) => {
    let url = '';
    try {
      url = page.url();
    } catch {
      // A page that cannot say where it is claims nothing and is left alone.
    }
    return { id: String(index), tag: tags[index] ?? null, url };
  });

  // Identity is decided by the tag first and by what the page is showing
  // second. The second pass is the one that matters: window.name does not
  // survive a cross-origin navigation, so a worker that died in the gap before
  // `retagIfLost` ran left a perfectly good tab that nothing could recognise.
  // The next worker opened its own beside it, and that is how one profile came
  // to hold fifteen pages, twelve of them the same timeline, until Chrome was
  // killed for memory.
  const plan = reconcileTabs(described);

  for (const [role, id] of Object.entries(plan.adopt)) {
    const page = pages[Number(id)];
    if (!page || tabs.has(role as TabRole)) continue;
    // Re-assert the tag on anything claimed by shape, so the next worker has
    // the strong signal rather than having to infer it again.
    if (tags[Number(id)] !== role) await writeTag(page, role as TabRole);
    tabs.set(role as TabRole, {
      role: role as TabRole,
      page,
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
      lastError: null,
      queue: Promise.resolve(),
      busy: false,
      heldSince: null,
      // An adopted tab has been navigated by somebody, and how often is not
      // knowable. Counting from zero is the honest floor: heap is the primary
      // signal and this is only the backstop.
      navigations: 0,
      recycled: null,
    });
  }

  if (plan.close.length > 0) {
    log.info('closing tabs a previous worker abandoned', {
      closing: plan.close.length,
      keeping: pages.length - plan.close.length,
    });
    for (const id of plan.close) {
      await pages[Number(id)]?.close().catch(() => undefined);
    }
  }

  log.info('adopted the tabs already open', {
    adopted: Object.keys(plan.adopt),
    toOpen: plan.create,
    left: plan.keep.map((k) => k.reason),
  });
}

/**
 * A tab that is open, answers every call, and can never show anything again.
 *
 * When Chrome kills a renderer for memory it does not close the tab: it
 * navigates it to an internal error page. `isClosed()` stays false, locators
 * resolve to nothing, and a monitor reads zero mentions and reports success.
 * That is how a session died on 2026-09-03 with "Error code: Out of Memory"
 * without anything recording an error.
 *
 * The crash event catches this at the moment it happens. This catches the tab
 * that was already dead when we came back to it -- after a worker restart, or
 * when the crash arrived while nothing was listening.
 */
/**
 * Anything with a deadline, because a wedged renderer answers nothing.
 *
 * Playwright's own timeouts cover its navigations and selectors. They do not
 * cover `page.evaluate` against a renderer that has stopped scheduling work,
 * which simply never settles. Every probe below therefore races its own clock.
 */
async function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work.catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * What this renderer is holding, or null where the browser will not say.
 *
 * `performance.memory` is Chromium's and is exactly what is needed: the used
 * heap and the ceiling V8 will kill the renderer for crossing. Absent on other
 * engines, and absent is reported rather than guessed -- a tab whose memory
 * cannot be read is recycled on age and navigations instead.
 */
export async function tabMemory(page: Page): Promise<TabMemory | null> {
  if (page.isClosed()) return null;
  return within(
    (async () => {
      const raw = await page.evaluate(() => {
        const m = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
        return m ? { used: m.usedJSHeapSize, limit: m.jsHeapSizeLimit } : null;
      });
      if (!raw || !raw.limit) return null;
      return { usedBytes: raw.used, limitBytes: raw.limit, fraction: raw.used / raw.limit };
    })(),
    PROBE_MS,
    null,
  );
}

/**
 * Whether the renderer is still answering at all.
 *
 * The check `isDeadPage` cannot make. A renderer killed for memory keeps its
 * URL -- the live failure showed `https://x.com/notifications/mentions` on a
 * tab that had been dead for the best part of an hour -- so nothing about the
 * URL, the title or `isClosed()` gives it away. What does give it away is that
 * it will not evaluate `1` within five seconds.
 */
export async function isRendererWedged(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;
  const answered = await within(
    page.evaluate(() => 1).then(() => true),
    PROBE_MS,
    false,
  );
  return !answered;
}

/**
 * Whether this tab should be replaced before it is used again.
 *
 * Recycling is the whole defence against a leak that is not ours to fix. The
 * thresholds come from the one budget rather than from here, so a small
 * machine recycles sooner without a second set of numbers to keep in step.
 */
export async function recycleReason(state: TabState, heapFraction: number): Promise<string | null> {
  if (state.page.isClosed()) return 'the tab was closed';
  if (isDeadPage(state.page)) return 'the tab was showing a browser error page';
  if (await isRendererWedged(state.page)) return 'the renderer stopped answering, usually out of memory';

  const memory = await tabMemory(state.page);
  if (memory && memory.fraction >= heapFraction) {
    return `it was holding ${Math.round(memory.usedBytes / 1048576)} MB, ${Math.round(memory.fraction * 100)}% of what this renderer is allowed`;
  }
  if (state.navigations >= MAX_NAVIGATIONS) {
    return `it had been navigated ${state.navigations} times`;
  }
  return null;
}

export function isDeadPage(page: Page): boolean {
  if (page.isClosed()) return true;
  let url = '';
  try {
    url = page.url();
  } catch {
    // Asking a destroyed page for its URL is itself an answer.
    return true;
  }
  return url.startsWith('chrome-error://') || url.startsWith('edge-error://') || url === 'about:blank#blocked';
}

/**
 * The page for a role, created once and reused.
 *
 * Recovery is per role: a closed or crashed tab is replaced on its own without
 * touching the browser or the other two, which is what keeps a failed monitor
 * from ending a sign-in somebody is halfway through.
 */
export async function acquireTab(
  context: BrowserContext,
  tabs: TabMap,
  role: TabRole,
  options: { heapFraction?: number } = {},
): Promise<TabState> {
  const existing = tabs.get(role);
  /*
    Why this asks rather than looks.

    `isDeadPage` reads the URL, and the failure that cost fifty-six minutes had
    a perfectly ordinary one: a renderer killed for memory keeps
    `https://x.com/notifications/mentions` in the address bar and answers
    nothing. So a tab is only reused after it has been asked whether it is
    still there, and after its heap has been checked against what this machine
    allows.

    The probe carries its own deadline, because the thing being probed is
    exactly the thing that does not answer.
  */
  let because: string | null = null;
  if (existing) {
    because = await recycleReason(existing, options.heapFraction ?? 0.6);
    if (!because) return existing;
  }

  if (existing) {
    log.info('recycling a role tab', { role, because });
    tabs.delete(role);
    // A crashed tab is still an open tab. Left behind it costs the memory that
    // killed it and gets adopted again by the next scan looking for our window
    // name, which is still on it.
    if (!existing.page.isClosed()) await existing.page.close().catch(() => undefined);
  }

  const adopted = await findExisting(context, role);
  const page = adopted ?? (await context.newPage());
  await writeTag(page, role);

  const state: TabState = {
    role,
    page,
    openedAt: Date.now(),
    lastUsedAt: Date.now(),
    lastError: null,
    queue: Promise.resolve(),
    busy: false,
    heldSince: null,
    navigations: 0,
    // Carried onto the new tab, so the owner-facing panel can say "the mentions
    // tab ran out of memory and was replaced" rather than leaving them to infer
    // it from a run of failed polls.
    recycled: because ? { at: Date.now(), because } : null,
  };
  tabs.set(role, state);

  // Keep the map honest without polling: a tab someone closes is removed the
  // moment it happens, so the next caller creates rather than reusing a handle
  // to nothing. A closed Playwright page does not throw on every method, which
  // is exactly how a dead tab used to look healthy.
  page.on('close', () => {
    if (tabs.get(role) === state) tabs.delete(role);
    log.info('tab closed', { role, adopted: Boolean(adopted) });
  });

  // A renderer killed for memory does not close its tab.
  //
  // This is the failure that looked healthiest: on 2026-09-03 a session died
  // with "Error code: Out of Memory" and the tab stayed open on the error page.
  // isClosed() is false, every method still resolves, and each read returns
  // nothing at all -- so a monitor found no mentions, forever, while reporting
  // success. Playwright raises `crash` for exactly this, and dropping the tab
  // from the map is enough: the next acquire builds a fresh one.
  page.on('crash', () => {
    if (tabs.get(role) === state) tabs.delete(role);
    state.lastError = 'the tab crashed, usually out of memory';
    log.warn('tab crashed, it will be recreated on next use', { role });
  });

  log.info(adopted ? 'tab adopted' : 'tab opened', { role, pages: context.pages().length });
  return state;
}

/**
 * Serialises operations on one tab.
 *
 * Different roles run concurrently — that is the point of having three — but
 * two operations on the same tab would interleave navigations and produce
 * results from a page neither of them asked for. Returns the function that
 * hands the tab to whoever is waiting.
 */
export async function lockTab(state: TabState): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const ahead = state.queue;
  state.queue = ahead.then(
    () => held,
    () => held,
  );

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Hand the tab on so a timed-out waiter does not wedge the queue behind it.
      release();
      reject(
        PipelineError.retryable(
          'tab_busy',
          `The ${state.role.toLowerCase()} tab was still busy after ${Math.round(TAB_WAIT_MS / 1000)}s. Another operation is holding it.`,
          { role: state.role },
        ),
      );
    }, TAB_WAIT_MS);
    // Never a reason to keep the process alive.
    timer.unref?.();
  });

  try {
    await Promise.race([ahead.catch(() => undefined), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  state.busy = true;
  state.heldSince = Date.now();

  /*
    A hold has a bound, because a wait always did and that asymmetry cost an
    afternoon.

    On 2026-09-15 an operation took the mentions tab at 21:19:01 and never gave
    it back: its renderer had run out of memory, the evaluation it was waiting
    on never settled, and nothing existed to take the tab away from it. Fifty-six
    minutes later `busy` was still true, three monitors had failed twenty-odd
    times each, and the health snapshot still said BUSY -- a word that sounds
    like work is happening.

    Taking it back does not rescue the stuck operation; nothing can. It stops
    that one operation costing every later one. The tab is marked with why, so
    the next acquire recycles it rather than handing out the same dead renderer.
  */
  let handedBack = false;
  let watchdog: NodeJS.Timeout | undefined = setTimeout(() => {
    if (handedBack) return;
    /*
      The same flag the holder's own release checks.

      Without this the wedged operation's release still runs when it finally
      returns -- possibly minutes later, with somebody else now holding the tab
      -- and clears `busy` out from under them. Two operations then drive one
      page at once, which is the exact failure the queue exists to prevent, and
      the recovery would have caused it.
    */
    handedBack = true;
    state.busy = false;
    state.heldSince = null;
    state.lastError = `an operation held the ${state.role.toLowerCase()} tab for over ${Math.round(TAB_HOLD_MS / 1000)}s without finishing; the tab was taken back`;
    log.warn('took a tab back from an operation that never finished', { role: state.role });
    release();
  }, TAB_HOLD_MS);
  watchdog.unref?.();

  return () => {
    // Idempotent, and shared with the watchdog: a turn that is over must not be
    // ended a second time by whoever was holding it.
    if (handedBack) return;
    handedBack = true;
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = undefined;
    }
    state.busy = false;
    state.heldSince = null;
    state.lastUsedAt = Date.now();
    release();
  };
}

/** What each role is doing right now. Never opens anything to answer. */
export function tabHealth(tabs: TabMap): TabHealth[] {
  return TAB_ROLES.map((role) => {
    const state = tabs.get(role);
    if (!state) {
      return {
        role,
        state: 'MISSING' as const,
        url: null,
        openedAt: null,
        lastUsedAt: null,
        lastError: null,
        recycled: null,
      };
    }
    const closed = state.page.isClosed();
    let url: string | null = null;
    try {
      url = closed ? null : state.page.url();
    } catch {
      url = null;
    }
    // A tab sitting on an error page reports FAILED, not READY. Health that
    // says READY for a tab which can never show anything again is worse than
    // no health at all: it is what let an out-of-memory session look fine for
    // four hours.
    const dead = !closed && isDeadPage(state.page);

    /*
      Busy is a state something is expected to leave.

      The live failure reported `BUSY` for fifty-six minutes and nothing looked
      twice, because busy reads as work in progress. Past the point where the
      lease would have taken the tab back, busy is not busy: it is broken, and
      the health snapshot has to say so or the panel keeps reassuring somebody
      whose monitors have all stopped.
    */
    const heldMs = state.heldSince ? Date.now() - state.heldSince : 0;
    const wedged = state.busy && heldMs > TAB_HOLD_MS;

    return {
      role,
      state: closed
        ? ('MISSING' as const)
        : dead || state.lastError || wedged
          ? ('FAILED' as const)
          : state.busy
            ? ('BUSY' as const)
            : ('READY' as const),
      url,
      openedAt: new Date(state.openedAt).toISOString(),
      lastUsedAt: new Date(state.lastUsedAt).toISOString(),
      recycled: state.recycled
        ? { at: new Date(state.recycled.at).toISOString(), because: state.recycled.because }
        : null,
      lastError: wedged
        ? `one operation has been holding this tab for ${Math.round(heldMs / 60_000)} minutes`
        : dead
          ? (state.lastError ?? 'the tab crashed, usually out of memory')
          : state.lastError,
    };
  });
}
