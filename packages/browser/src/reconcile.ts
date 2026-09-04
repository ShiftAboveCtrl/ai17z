/**
 * Working out which of the tabs already open belongs to which role.
 *
 * `window.name` is the identity, and it is not durable. A cross-origin
 * navigation clears it, and `retagIfLost` re-asserts it afterwards -- but a
 * worker that dies in the gap between those two leaves a tab that is perfectly
 * good and permanently anonymous. The next worker cannot claim it, opens its
 * own, and the old one stays.
 *
 * That is why a real profile was found holding fifteen pages, twelve of them
 * the same timeline: it is one abandoned tab per unclean restart, accumulating
 * until Chrome runs out of memory. Which it did.
 *
 * So identity is decided in three passes, strongest first:
 *
 *   1. the tag, when it survived
 *   2. what the page is showing, which is characteristic per role
 *   3. nothing -- and an unclaimed page is closed rather than left
 *
 * The second pass is what makes restarts safe, and the third is what keeps the
 * count bounded. Both are deliberately conservative: a page that might be
 * somebody's sign-in is never claimed and never closed.
 */
import type { TabRole } from './tabs';

export const RECONCILE_ROLES: readonly TabRole[] = ['ACTION', 'MENTIONS', 'NOTIFICATIONS', 'RESEARCH'];

export interface OpenPage {
  /** Stable within one browser, for referring back to the page. */
  id: string;
  /** The role its window.name claims, when it still has one. */
  tag: TabRole | null;
  url: string;
}

export interface Reconciliation {
  /** Which page each role should use. A role missing here needs a new tab. */
  adopt: Partial<Record<TabRole, string>>;
  /** Roles with no usable page, which the caller opens. */
  create: TabRole[];
  /** Pages nothing needs, which are safe to close. */
  close: string[];
  /** Pages left alone that nothing claimed, with the reason. */
  keep: { id: string; reason: string }[];
}

/**
 * Pages that must never be claimed for a role and never closed.
 *
 * A sign-in half finished is the most expensive thing in the browser: closing
 * it costs somebody their session and there is no way to give it back. A
 * challenge is the same, and a composer holds text nobody has sent. When in
 * doubt the page stays exactly where it is.
 */
const PROTECTED =
  /\/(login|logout|i\/flow|account\/access|checkpoint|challenge|oauth|authorize|signin|sign_in|compose|settings)\b/i;

/**
 * What each role's page looks like, for a tab whose tag did not survive.
 *
 * Only used when the tag is gone, and only where the shape is unambiguous:
 * these are the URLs this runtime navigates to itself, so a match is strong
 * evidence the tab was ours. Deliberately no pattern for ACTION, because its
 * page is whichever status is being replied to and that matches nothing
 * distinctive -- guessing there would claim a stranger's tab.
 */
const LOOKS_LIKE: Partial<Record<TabRole, RegExp>> = {
  MENTIONS: /x\.com\/search\?q=|x\.com\/[^/]+\/with_replies/i,
  NOTIFICATIONS: /x\.com\/notifications/i,
  RESEARCH: /^https?:\/\/(?!.*x\.com)/i,
};

/** Whether a page is one this runtime may act on at all. */
function claimable(page: OpenPage): boolean {
  if (!page.url || page.url === 'about:blank') return false;
  return !PROTECTED.test(page.url);
}

/**
 * Decide what to adopt, what to open and what to close.
 *
 * Pure, so the restart cycle can be run twenty times in a test without a
 * browser and the tab count asserted to stay bounded -- which is the property
 * that was actually broken.
 */
export function reconcileTabs(pages: OpenPage[]): Reconciliation {
  const adopt: Partial<Record<TabRole, string>> = {};
  const taken = new Set<string>();

  // 1. The tag, where it survived. Strongest signal and never overridden.
  for (const role of RECONCILE_ROLES) {
    const tagged = pages.find((p) => p.tag === role && !taken.has(p.id));
    if (tagged) {
      adopt[role] = tagged.id;
      taken.add(tagged.id);
    }
  }

  // 2. What the page is showing. Only for roles still unclaimed, only for
  //    pages with no tag of their own, and only where the shape is unambiguous.
  for (const role of RECONCILE_ROLES) {
    if (adopt[role]) continue;
    const shape = LOOKS_LIKE[role];
    if (!shape) continue;
    const match = pages.find((p) => !taken.has(p.id) && p.tag === null && claimable(p) && shape.test(p.url));
    if (match) {
      adopt[role] = match.id;
      taken.add(match.id);
    }
  }

  // 3. One anonymous page can become the action tab, which is what a freshly
  //    launched Chrome's blank-ish first tab usually is.
  if (!adopt.ACTION) {
    const spare = pages.find((p) => !taken.has(p.id) && p.tag === null && claimable(p) && /x\.com/i.test(p.url));
    if (spare) {
      adopt.ACTION = spare.id;
      taken.add(spare.id);
    }
  }

  const create = RECONCILE_ROLES.filter((role) => !adopt[role]);

  const close: string[] = [];
  const keep: { id: string; reason: string }[] = [];
  for (const page of pages) {
    if (taken.has(page.id)) continue;
    if (!page.url || page.url === 'about:blank') {
      keep.push({ id: page.id, reason: 'a blank tab, which is what Chrome opens with' });
      continue;
    }
    if (PROTECTED.test(page.url)) {
      keep.push({ id: page.id, reason: 'a sign-in, challenge or composer, which is never touched' });
      continue;
    }
    // Anything left is a page this runtime opened and abandoned. Left alone it
    // is one more timeline holding memory until the browser is killed.
    close.push(page.id);
  }

  return { adopt, create, close, keep };
}

/**
 * How many pages a browser should have after reconciling.
 *
 * The number that has to stay flat across restarts. Anything that grows with
 * the number of restarts is the leak this exists to stop.
 */
export function expectedPageCount(result: Reconciliation, before: OpenPage[]): number {
  return before.length - result.close.length + result.create.length;
}
