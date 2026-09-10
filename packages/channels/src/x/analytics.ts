import { PipelineError } from '@xbam/shared';
import type { ChannelContext } from '../contract';
import { goto, settle, withSession, type Page } from './page';
import { parseCount } from './read';
import { extractStatusId } from './targets';

/**
 * What X tells the author about their own post.
 *
 * The counts under a post are what anyone can see. This is the other set: the
 * numbers X shows only to the account that posted it -- impressions, profile
 * visits, link clicks, detail expands -- and they are the ones that answer
 * whether anything worked. They are a different claim from the public counts
 * and are recorded as a different source, because a like read off a timeline
 * and one read off this page were measured by different things.
 *
 * Only the account's own posts have this page. Asking for somebody else's is
 * not a permission problem to work around; X simply does not have the answer
 * for us, and the honest result is to say so.
 */

/** How long to wait for the page to render its figures before giving up. */
const RENDER_TIMEOUT_MS = 8_000;

/** The metrics this file is willing to claim, in our own vocabulary. */
export interface PostAnalyticsReading {
  impressions?: number;
  likes?: number;
  reposts?: number;
  replies?: number;
  quotes?: number;
  bookmarks?: number;
  profileVisits?: number;
  linkClicks?: number;
  /** X's own labels that were on the page and are not mapped here. */
  unmapped: string[];
}

/**
 * X's label for a figure, mapped to ours.
 *
 * Kept as a table rather than a chain of `includes`, because the labels overlap
 * -- "Profile visits" contains "visits", "Detail expands" contains "expands",
 * and "New followers" is a follower count that is emphatically not the
 * account's follower count. A substring match here writes the wrong number into
 * the right column, which no test that only checks the row exists would catch.
 */
const LABELS: Record<string, keyof Omit<PostAnalyticsReading, 'unmapped'>> = {
  impressions: 'impressions',
  views: 'impressions',
  likes: 'likes',
  reposts: 'reposts',
  retweets: 'reposts',
  replies: 'replies',
  quotes: 'quotes',
  bookmarks: 'bookmarks',
  'profile visits': 'profileVisits',
  'link clicks': 'linkClicks',
};

/**
 * Turns the label/value pairs on the page into a reading.
 *
 * Pure, so the mapping can be pinned by fixtures. Anything X showed that is not
 * in the table is listed rather than dropped: a metric that appears in a
 * redesign is then visible as a name nobody has mapped, instead of silently not
 * existing.
 */
export function parseAnalytics(pairs: { label: string; value: string }[]): PostAnalyticsReading {
  const reading: PostAnalyticsReading = { unmapped: [] };
  for (const pair of pairs) {
    const label = pair.label.trim().toLowerCase().replace(/\s+/g, ' ');
    const key = LABELS[label];
    if (!key) {
      if (label) reading.unmapped.push(pair.label.trim());
      continue;
    }
    const value = parseCount(pair.value);
    // A figure that would not parse is left absent rather than set to zero.
    // Absent is not zero is the whole discipline of this boundary.
    if (value !== undefined) reading[key] = value;
  }
  return reading;
}

/** The author's own figures for one of their posts. */
export async function readPostAnalytics(
  ctx: ChannelContext,
  reference: string,
): Promise<{ statusId: string; reading: PostAnalyticsReading }> {
  const statusId =
    extractStatusId(reference) ?? (/^\d{5,25}$/.test(reference.trim()) ? reference.trim() : null);
  if (!statusId) {
    throw PipelineError.permanent('bad_status_reference', `"${reference}" is not a post id or a post URL.`);
  }

  return withSession(ctx, 'RESEARCH', async (session) => {
    await goto(session.page, `https://x.com/i/status/${statusId}/analytics`);
    await settle();

    const pairs = await readFigures(session.page);
    if (pairs.length === 0) {
      // Either the post is not this account's, or X did not render. Both are
      // "no answer", and inventing zeroes for a post somebody else wrote would
      // be worse than saying nothing.
      throw PipelineError.permanent(
        'analytics_not_available',
        `X did not show analytics for ${statusId}. Only the author's own posts have them.`,
      );
    }
    return { statusId, reading: parseAnalytics(pairs) };
  });
}

/**
 * Every figure on the page, in one evaluation.
 *
 * X renders each as a small stack: the number above its label, with no test id
 * on either. The pairing is therefore positional within one container, which is
 * exactly the kind of thing that breaks on a redesign -- so the parser above
 * reports labels it does not recognise rather than assuming the shape held.
 */
async function readFigures(page: Page): Promise<{ label: string; value: string }[]> {
  await page
    .locator('main')
    .first()
    .waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS })
    .catch(() => undefined);

  return page
    .locator('main')
    .evaluateAll((nodes) => {
      const root = nodes[0] as HTMLElement | undefined;
      if (!root) return [] as { label: string; value: string }[];
      const out: { label: string; value: string }[] = [];
      // A figure is a two-line stack whose first line is a number and whose
      // second is a word. Walking the leaves and pairing adjacent lines finds
      // them without depending on X's class names, which change weekly.
      for (const node of Array.from(root.querySelectorAll('div'))) {
        const el = node as HTMLElement;
        if (el.children.length > 3) continue;
        const lines = (el.innerText ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        if (lines.length !== 2) continue;
        const [first, second] = lines as [string, string];
        if (!/^[\d.,]+[KMB]?$/i.test(first)) continue;
        if (!/^[A-Za-z][A-Za-z ]{2,30}$/.test(second)) continue;
        out.push({ label: second, value: first });
      }
      // The same stack matches at several nesting levels, so the same pair
      // arrives more than once. First one wins; the rest are the same fact.
      const seen = new Set<string>();
      return out.filter((pair) => {
        const key = pair.label.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    })
    .catch(() => [] as { label: string; value: string }[]);
}
