/**
 * Noticing that a browser has stopped working, and doing something about it.
 *
 * Every failure this handles has the same shape: the browser is technically
 * present and functionally dead, so nothing throws, health looks fine, and the
 * agent goes on reporting itself as running while no work is possible. That is
 * the worst kind of outage, because the only symptom is silence and silence is
 * also what a quiet day looks like.
 *
 * Four things are watched, and they fail differently:
 *
 *   a tab closed          -- somebody closed it, or a crash took it
 *   a renderer killed     -- the tab stays open on an internal error page
 *   a tab that hangs      -- it answers navigation but never finishes anything
 *   the browser gone      -- the process died, or CDP dropped
 *
 * Recovery is per role and bounded. A dead research tab must not take a
 * half-finished sign-in on the action tab with it, and a tab that cannot be
 * rebuilt must stop being retried rather than being rebuilt for ever.
 */
import type { TabRole } from './tabs';

/** What is wrong with one role, in the order it is worth acting on. */
export type Ailment =
  | 'HEALTHY'
  /** No tab for this role at all. Ordinary before first use. */
  | 'MISSING'
  /** The tab is gone: closed by somebody, or taken by a crash. */
  | 'CLOSED'
  /** Open, on an internal error page. A renderer killed for memory does this. */
  | 'CRASHED'
  /** Open, and not answering. Frozen script, or a modal nothing dismissed. */
  | 'UNRESPONSIVE'
  /** Open and answering, but sitting on the same navigation far too long. */
  | 'STUCK';

export type Remedy =
  | 'NONE'
  /** Rebuild this one role. The others are untouched. */
  | 'RECREATE_TAB'
  /** The browser itself is the problem; one tab cannot fix it. */
  | 'RECONNECT_BROWSER'
  /** Tried enough. Stop, and say so, rather than looping. */
  | 'GIVE_UP';

export interface TabProbe {
  role: TabRole;
  /** Whether a tab for this role exists in this process at all. */
  present: boolean;
  /** Closed, per the driver. */
  closed: boolean;
  /** Sitting on an internal error page. */
  onErrorPage: boolean;
  /**
   * How long a trivial evaluation took, or null when it never answered.
   *
   * Null is the important one: a page that never answers is not slow, it is
   * gone, and every read against it returns nothing rather than failing.
   */
  respondedMs: number | null;
  /** How long it has been on the same URL, when that is known. */
  onSameUrlMs?: number | null;
  /** How many times recovery has already been attempted for this role. */
  attempts?: number;
}

export interface RoleVerdict {
  role: TabRole;
  ailment: Ailment;
  remedy: Remedy;
  /** One sentence, for the account page and the log. */
  detail: string;
}

/** Beyond this a page is treated as not answering rather than as slow. */
export const RESPONSE_BUDGET_MS = 5_000;

/**
 * A navigation that has not moved in this long is stuck.
 *
 * Generous on purpose: a monitor legitimately sits on one timeline for minutes
 * at a time, so this is about a page that never finished loading rather than
 * one nobody has asked to move.
 */
export const STUCK_NAVIGATION_MS = 10 * 60_000;

/** Rebuilding a role more than this many times means something else is wrong. */
export const MAX_RECOVERY_ATTEMPTS = 3;

/** What is wrong with one role, and what to do about it. */
export function diagnoseTab(probe: TabProbe): RoleVerdict {
  const attempts = probe.attempts ?? 0;
  const exhausted = attempts >= MAX_RECOVERY_ATTEMPTS;

  const verdict = (ailment: Ailment, detail: string, remedy: Remedy): RoleVerdict => ({
    role: probe.role,
    ailment,
    // Once recovery has been tried enough times, stop. A tab rebuilt on a loop
    // is a busy worker achieving nothing, and the honest report is that this
    // role is not working.
    remedy: remedy !== 'NONE' && exhausted ? 'GIVE_UP' : remedy,
    detail: remedy !== 'NONE' && exhausted ? `${detail} Rebuilding it has not helped, so it is being left alone.` : detail,
  });

  if (!probe.present) {
    // Not a fault. A role gets its tab the first time something needs it.
    return { role: probe.role, ailment: 'MISSING', remedy: 'NONE', detail: 'No tab open for this yet.' };
  }
  if (probe.closed) {
    return verdict('CLOSED', 'The tab was closed.', 'RECREATE_TAB');
  }
  if (probe.onErrorPage) {
    return verdict(
      'CRASHED',
      'The tab is on an error page, which is what Chrome does when it kills a renderer for memory.',
      'RECREATE_TAB',
    );
  }
  if (probe.respondedMs === null) {
    return verdict('UNRESPONSIVE', 'The tab did not answer, so nothing can be read from it.', 'RECREATE_TAB');
  }
  if (probe.respondedMs > RESPONSE_BUDGET_MS) {
    return verdict('UNRESPONSIVE', `The tab took ${Math.round(probe.respondedMs / 1000)}s to answer.`, 'RECREATE_TAB');
  }
  if ((probe.onSameUrlMs ?? 0) > STUCK_NAVIGATION_MS) {
    return verdict('STUCK', 'The tab has not finished a navigation for a long time.', 'RECREATE_TAB');
  }
  return { role: probe.role, ailment: 'HEALTHY', remedy: 'NONE', detail: 'Working.' };
}

export interface BrowserVerdict {
  /** Per role, always all four, so a missing one is visible as missing. */
  roles: RoleVerdict[];
  /**
   * Whether browser work is possible at all right now.
   *
   * This is the number that must never be optimistic. An agent that presents
   * itself as running while this is false is the failure the whole file exists
   * to prevent.
   */
  usable: boolean;
  /** What the browser as a whole needs, when one tab cannot fix it. */
  remedy: Remedy;
  detail: string;
}

export interface BrowserProbe {
  /** Whether the driver still has a connection. */
  connected: boolean;
  /** Whether the process AI17Z started is still alive, when that is known. */
  processAlive?: boolean | null;
  tabs: TabProbe[];
}

/**
 * The whole browser, from the tabs and the connection.
 *
 * A browser-level problem is diagnosed before the tabs, because rebuilding four
 * tabs inside a browser that has gone is four failures instead of one, and the
 * message somebody reads should name the browser rather than the tabs.
 */
export function diagnoseBrowser(probe: BrowserProbe): BrowserVerdict {
  const roles = probe.tabs.map(diagnoseTab);

  if (!probe.connected) {
    return {
      roles,
      usable: false,
      remedy: 'RECONNECT_BROWSER',
      detail: 'The connection to Chrome has dropped. Nothing can be read or posted until it is back.',
    };
  }
  if (probe.processAlive === false) {
    return {
      roles,
      usable: false,
      remedy: 'RECONNECT_BROWSER',
      detail: 'The Chrome AI17Z started is no longer running.',
    };
  }

  const present = roles.filter((r) => r.ailment !== 'MISSING');
  const broken = present.filter((r) => r.ailment !== 'HEALTHY');

  // Every tab failing at once is a browser problem wearing four tab-shaped
  // disguises, and reconnecting is cheaper and likelier to work than
  // rebuilding each of them inside it.
  if (present.length > 1 && broken.length === present.length) {
    return {
      roles,
      usable: false,
      remedy: 'RECONNECT_BROWSER',
      detail: 'Every tab has stopped responding, which is the browser rather than the tabs.',
    };
  }

  const givenUp = roles.filter((r) => r.remedy === 'GIVE_UP');
  if (givenUp.length > 0) {
    return {
      roles,
      usable: false,
      remedy: 'GIVE_UP',
      detail: `${givenUp.map((r) => r.role).join(', ')} could not be recovered. This agent cannot do browser work until somebody looks.`,
    };
  }

  return {
    roles,
    usable: broken.length === 0,
    remedy: broken.length > 0 ? 'RECREATE_TAB' : 'NONE',
    detail:
      broken.length === 0
        ? 'All tabs responding.'
        : `${broken.map((r) => `${r.role} (${r.ailment.toLowerCase()})`).join(', ')} being rebuilt.`,
  };
}

/**
 * Whether an account should be described as able to work.
 *
 * Deliberately separate from "is there a session": a session object exists long
 * after the browser behind it has died, and reporting on the object rather than
 * on the browser is exactly how an agent claimed to be running for four hours
 * while every poll failed.
 */
export function browserUsable(verdict: BrowserVerdict | null, lastSeenMs: number | null): boolean {
  if (!verdict) return false;
  if (!verdict.usable) return false;
  // A snapshot nobody has refreshed is not evidence of health.
  if (lastSeenMs !== null && lastSeenMs > 90_000) return false;
  return true;
}

/**
 * Pages that must never be closed automatically, whatever else is true.
 *
 * Sign-in is always the person's job, and a half-finished one is the most
 * expensive thing in the browser: closing it costs somebody their session and
 * there is no way to give it back. A composer holds text nobody has sent yet.
 * When in doubt the tab stays.
 */
const NEVER_CLOSE =
  /\/(login|logout|i\/flow|account\/access|checkpoint|challenge|oauth|authorize|signin|sign_in|compose)\b/i;

/**
 * Tabs an account has open that no role is using.
 *
 * They accumulate: a worker that dies without closing its tabs leaves them
 * behind, the next one cannot recognise them because a cross-origin navigation
 * cleared the window.name they were identified by, and it opens its own. After
 * a few restarts one profile was holding fifteen pages, twelve of them the same
 * timeline -- which is a browser using several gigabytes to do the work of
 * four tabs, and is what an out-of-memory kill looks like before it happens.
 *
 * Returns what is safe to close, never what is in use.
 */
export function orphanTabs(input: {
  /** Every page URL currently open, in order. */
  pages: { url: string; isRole: boolean }[];
  /** Leave this many non-role pages alone even when they look spare. */
  keepSpare?: number;
}): number[] {
  const keepSpare = input.keepSpare ?? 1;
  const closable: number[] = [];

  input.pages.forEach((page, index) => {
    if (page.isRole) return;
    if (NEVER_CLOSE.test(page.url)) return;
    // A blank tab is what Chrome opens with; it is not evidence of anything.
    if (!page.url || page.url === 'about:blank') return;
    closable.push(index);
  });

  // Keep the newest spare, in case somebody is looking at it.
  return closable.slice(0, Math.max(0, closable.length - keepSpare));
}
