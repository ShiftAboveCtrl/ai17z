import { PipelineError } from '@xbam/shared';
import type { ChannelContext } from '../contract';
import { SEL } from './selectors';
import { goto, readArticle, refuseIfXBroke, selfHandles, settle, withSession, type Page } from './page';
import { parseCount, readCounts } from './counts';
import { extractStatusId, normalizeHandle } from './targets';

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
  /**
   * What X calls "Views" on the post, kept under that name.
   *
   * This used to be folded into `impressions`, on the strength of a label table
   * that maps the word. Nothing established the two are the same measurement,
   * and a reading that renames a metric is a reading that misstates one. X
   * writes "58,814 views" in the count group and "Views" beside the figure on
   * the post; it never says impressions there.
   */
  views?: number;
  /** Only ever set when X's own analytics view said "Impressions". */
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
  /**
   * Where the figures came from, because the two sources are not the same claim.
   *
   * `DETAILED` is X's own analytics view for the author: impressions, profile
   * visits, link clicks, detail expands. `VIEWS_ONLY` is the view count X shows
   * on the post itself, which is the impressions figure and nothing else.
   *
   * A caller that cannot tell them apart will read an absent profile-visit
   * count as a measured zero, which is the mistake this whole boundary exists
   * to prevent.
   */
  source: 'DETAILED' | 'VIEWS_ONLY';
  /** What could not be read, named rather than left as a silent absence. */
  gaps: string[];
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
/**
 * The half of a reading that is a number.
 *
 * Named rather than derived by subtraction, because a reading also carries
 * where it came from and what it could not read, and neither of those is a
 * figure a label can be mapped onto.
 */
type PostAnalyticsMetric = Exclude<keyof PostAnalyticsReading, 'unmapped' | 'source' | 'gaps'>;

const LABELS: Record<string, PostAnalyticsMetric> = {
  // Each label maps to the metric of that name and to no other. "Views" and
  // "Impressions" are different words and X uses both; which one it used is a
  // fact about the page and is preserved rather than normalised away.
  impressions: 'impressions',
  views: 'views',
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
  const reading: PostAnalyticsReading = { unmapped: [], source: 'DETAILED', gaps: [] };
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
    /*
      The post first, and the analytics from there, because that is the only
      route that works.

      This used to navigate straight to `/i/status/<id>/analytics`. Measured
      against the live signed-in session on a post the account had written
      itself: that address renders the home timeline. So does
      `/<handle>/status/<id>/analytics` on a hard navigation, waited out for
      fifteen seconds. The address was never the difficult part; X's router
      only resolves it from inside the application.

      So the post page is loaded, and the link X puts there is followed the way
      the application follows it. That link is also how eligibility is
      established: X shows it to the author and to nobody else, so its absence
      is an answer rather than a guess about one.
    */
    await goto(session.page, `https://x.com/i/web/status/${statusId}`);
    await settle();
    await refuseIfXBroke(session.page, 'that post');

    /*
      Whose post this is, established rather than inferred from a link.

      An earlier version used the presence of the analytics link as the
      eligibility test, on the reasoning that X shows it to the author. Measured
      against the live signed-in session on somebody else's post: the link is
      there too, reading "58.8K Views". It is on every post, so it proves
      nothing about who wrote one.

      The canonical signal is the one the rest of this layer already uses: the
      focal article's author against this session's own handles. Anchored on the
      article that links to this status id, exactly as the action path does,
      because on a status page the parent renders above the focal post and "the
      first article" is reliably somebody else's.
    */
    const anchor = `${SEL.tweetArticle}:has(a[href*="/status/${statusId}"])`;
    const onPage = await session.page.locator(anchor).first().isVisible({ timeout: RENDER_TIMEOUT_MS }).catch(() => false);
    if (!onPage) {
      throw PipelineError.permanent('focal_article_not_found', `The post ${statusId} is not on its own page any more.`);
    }

    const article = await readArticle(session.page, anchor);
    const author = normalizeHandle(article.authorHandle ?? '');
    const mine = selfHandles(ctx);
    if (!author || !mine.includes(author)) {
      throw PipelineError.permanent(
        'analytics_not_available',
        `${statusId} was written by @${author ?? 'somebody this could not identify'}, and this account is ` +
          `@${mine[0] ?? 'unknown'}. X shows a post's own figures to whoever wrote it.`,
      );
    }

    /*
      What X shows on the post, read through the one reader for it.

      `readCounts` takes the count group's own label, which is where X writes
      "288 replies, 155 reposts, 696 likes, 60 bookmarks, 58814 views". Absent
      figures stay absent: the label is the only place that distinguishes
      nobody replied from we could not see how many did.
    */
    const counts = await readCounts(session.page, anchor);

    const link = session.page.locator(`a[href$="/${statusId}/analytics"]`).first();
    if (await link.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await link.click({ timeout: RENDER_TIMEOUT_MS }).catch(() => undefined);
      await settle(1_200, 2_500);
    }

    const pairs = await readFigures(session.page);
    if (pairs.length > 0) return { statusId, reading: parseAnalytics(pairs) };

    /*
      X did not render a detailed view, so what the post itself showed is the
      answer.

      Measured on the live account: the address changes, the title becomes the
      post's, and the content stays the post with its counts. X gates the
      detailed figures, so an account without that entitlement sees the link and
      is then shown the post.

      Everything here came from the count group, under the names X used. What
      the group did not carry stays absent, because a figure nobody measured is
      not a figure that was nought. The detailed metrics have no values at all
      on this path and are not mentioned as though they might.
    */
    const measured = Object.entries(counts).filter(([, value]) => value !== undefined);
    if (measured.length === 0) {
      throw PipelineError.permanent(
        'analytics_not_available',
        `X rendered no figures for ${statusId}: not its detailed view, and no count group on the post ` +
          'either. There is nothing here to report.',
      );
    }

    return {
      statusId,
      reading: {
        ...Object.fromEntries(measured),
        unmapped: [],
        source: 'VIEWS_ONLY',
        gaps: [
          "X did not render its detailed analytics view for this account, so these are the figures it " +
            'shows on the post itself. Impressions, profile visits, link clicks and detail expands were ' +
            'not measured and are absent rather than zero.',
        ],
      },
    };
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
