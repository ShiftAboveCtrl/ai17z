import { SEL } from './selectors';
import type { Page } from './page';

/**
 * The numbers X puts under a post.
 *
 * A file of its own because three different callers need them and two of them
 * would otherwise import each other: `read.ts` reads a post on purpose,
 * `analytics.ts` reads the author's own figures, and `monitors.ts` is already
 * standing on the status page every time it checks one of the agent's own posts
 * for replies. That last one is what makes measurement automatic rather than
 * something a capability has to be asked for.
 */

/**
 * How long to wait for the count group before deciding it is not there.
 *
 * Playwright's locator actions auto-wait for the whole default timeout, so a
 * missing element costs thirty seconds before the catch runs. Two is longer
 * than a rendered element needs, and a post whose counts did not render is a
 * post with unknown counts rather than a failure.
 */
const FIELD_TIMEOUT_MS = 2_000;

/**
 * Turns X's abbreviated counts into numbers, or into nothing.
 *
 * "1,234" is 1234 and "12.3K" is 12300, but the important case is the third
 * one: a count the page did not show comes back undefined rather than zero.
 * `docs/ENGINEERING.md` treats an unread image as an explicit gap instead of
 * silence, and a follower count behind a login wall is the same kind of gap --
 * an agent told an account has zero followers will say so.
 */
export function parseCount(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const text = raw.replace(/,/g, '').trim();
  const match = text.match(/^(\d+(?:\.\d+)?)\s*([KMB])?/i);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1]!);
  if (!Number.isFinite(value)) return undefined;
  const scale = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[(match[2] ?? '').toLowerCase()] ?? 1;
  return Math.round(value * scale);
}

export interface PostCounts {
  replies?: number;
  reposts?: number;
  likes?: number;
  bookmarks?: number;
  views?: number;
}

/**
 * The counts X renders under a post, from the one aria-label it puts on the
 * action group -- "12 replies, 3 reposts, 40 likes, 1,205 views".
 *
 * Read from the label rather than from four separate spans, because X hides an
 * individual count when it is zero and names it in the label either way. So the
 * label is the only place that distinguishes "nobody replied" from "we could
 * not see how many replied", and that distinction is the whole point.
 */
export function parseCounts(label: string | null | undefined): PostCounts {
  if (!label) return {};
  const of = (word: string): number | undefined => {
    const match = label.match(new RegExp(String.raw`([\d.,]+[KMB]?)\s+` + word, 'i'));
    return parseCount(match?.[1]);
  };
  const counts = {
    replies: of('repl(?:y|ies)'),
    reposts: of('reposts?'),
    likes: of('likes?'),
    bookmarks: of('bookmarks?'),
    views: of('views?'),
  };
  // Only what was actually there. An object of undefineds reads as "we looked
  // and found nothing", which is different from "we did not look".
  return Object.fromEntries(Object.entries(counts).filter(([, value]) => value !== undefined));
}

/** The counts on one article, or nothing when X did not render the group. */
export async function readCounts(page: Page, articleSelector: string): Promise<PostCounts> {
  const label = await page
    .locator(`${articleSelector} ${SEL.countGroup}`)
    .first()
    .getAttribute('aria-label', { timeout: FIELD_TIMEOUT_MS })
    .catch(() => null);
  return parseCounts(label);
}
