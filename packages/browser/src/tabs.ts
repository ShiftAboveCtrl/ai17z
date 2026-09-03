import type { BrowserContext, Page } from 'playwright';
import { PipelineError, createLogger, errorMessage } from '@xbam/shared';

const log = createLogger('browser-tabs');

/**
 * Three tabs, each with one job.
 *
 * One page doing everything is why reading used to break posting. A monitor
 * navigating to the notifications timeline while a reply composer was open
 * would discard the composer; an action navigating to a status page would throw
 * away the monitor's scroll position and its place in the timeline. Neither
 * failure is visible in a log — the work simply comes back empty.
 *
 * So the account gets three persistent tabs in the one browser:
 *
 *   ACTION         replies, posts, and the target verification before them
 *   MENTIONS       mention and reply discovery, and the agent's own threads
 *   NOTIFICATIONS  X's own notifications surface, as an independent source
 *   RESEARCH       looking things up off X, so an agent asked about something
 *                  that happened this morning is not limited to whatever its
 *                  model was trained on
 *
 * A tab is identified by `window.name`, not by an in-process map, so a worker
 * that restarts and reattaches to a browser still running adopts the tabs it
 * already has instead of opening three more. That is the whole defence against
 * ending up with seventeen notification tabs.
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

export interface TabState {
  role: TabRole;
  page: Page;
  openedAt: number;
  lastUsedAt: number;
  lastError: string | null;
  /** Tail of the queue of operations on this tab. */
  queue: Promise<void>;
  busy: boolean;
}

/** What one tab is doing, for the account's browser panel. */
export interface TabHealth {
  role: TabRole;
  state: 'READY' | 'BUSY' | 'MISSING' | 'FAILED';
  url: string | null;
  openedAt: string | null;
  lastUsedAt: string | null;
  lastError: string | null;
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

  for (const [index, page] of pages.entries()) {
    const role = tags[index];
    if (role && !tabs.has(role)) {
      tabs.set(role, { role, page, openedAt: Date.now(), lastUsedAt: Date.now(), lastError: null, queue: Promise.resolve(), busy: false });
    }
  }

  // One untagged page becomes ACTION, which is what it almost always was.
  if (!tabs.has('ACTION')) {
    const orphan = pages.find((_, index) => tags[index] === null);
    if (orphan) {
      await writeTag(orphan, 'ACTION');
      tabs.set('ACTION', {
        role: 'ACTION',
        page: orphan,
        openedAt: Date.now(),
        lastUsedAt: Date.now(),
        lastError: null,
        queue: Promise.resolve(),
        busy: false,
      });
      log.info('adopted an untagged tab as the action tab', { url: orphan.url().slice(0, 80) });
    }
  }
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
export async function acquireTab(context: BrowserContext, tabs: TabMap, role: TabRole): Promise<TabState> {
  const existing = tabs.get(role);
  if (existing && !existing.page.isClosed() && !isDeadPage(existing.page)) return existing;

  if (existing) {
    log.info(existing.page.isClosed() ? 'tab was closed, recreating it' : 'tab died, recreating it', {
      role,
      url: existing.page.isClosed() ? null : existing.page.url(),
    });
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
  return () => {
    state.busy = false;
    state.lastUsedAt = Date.now();
    release();
  };
}

/** What each role is doing right now. Never opens anything to answer. */
export function tabHealth(tabs: TabMap): TabHealth[] {
  return TAB_ROLES.map((role) => {
    const state = tabs.get(role);
    if (!state) {
      return { role, state: 'MISSING' as const, url: null, openedAt: null, lastUsedAt: null, lastError: null };
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

    return {
      role,
      state: closed
        ? ('MISSING' as const)
        : dead || state.lastError
          ? ('FAILED' as const)
          : state.busy
            ? ('BUSY' as const)
            : ('READY' as const),
      url,
      openedAt: new Date(state.openedAt).toISOString(),
      lastUsedAt: new Date(state.lastUsedAt).toISOString(),
      lastError: dead ? (state.lastError ?? 'the tab crashed, usually out of memory') : state.lastError,
    };
  });
}
