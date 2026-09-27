import { PipelineError, envBool, errorMessage, sleep } from '@xbam/shared';
import {
  leaseSession,
  resolveProfileDir,
  type LeasedSession,
  type Page,
  type TabRole,
} from '@xbam/browser';
import type { ChannelContext } from '../contract';
import { SEL } from './selectors';
import type { ArticleSnapshot } from './conversation';
import {
  extractStatusId,
  handleFromUrl,
  looksLikeXBroke,
  looksLikeXStalled,
  normalizeHandle,
  normalizeTargetId,
} from './targets';

/**
 * Driving a page on X, without knowing what it is being driven for.
 *
 * These came out of a 1,648-line adapter that held them alongside the channel
 * contract, the composer and engagement. What is here is the part with no
 * opinion about replies, posts or monitors: taking a lease on a tab, waiting
 * the way a person waits, going somewhere, and reading one article.
 *
 * Everything X-specific about *where things are on the page* still lives in
 * `selectors.ts`. This is the part that uses them.
 */

/**
 * How far down a status page to read.
 *
 * A busy thread renders hundreds of replies, and everything past the focal post
 * is a different branch anyway. Twenty covers a deep ancestor chain with room
 * to spare and keeps one context resolution to a few hundred milliseconds.
 */
export const MAX_ARTICLES_READ = 20;

/**
 * The page type, re-exported so a reader does not have to reach for Playwright.
 *
 * Every surface reader takes one of these. Importing it from `@xbam/browser`
 * in each of them would put the automation library's name in six more files
 * for no benefit; the boundary rule is that nothing about the DOM leaves this
 * package, and the type of the thing holding the DOM is part of that.
 */
export type { Page };

/**
 * Refuses to call an empty page an empty answer.
 *
 * X answers a failed request with its own error page and a Retry button, and
 * every reader here would otherwise return an empty list from it -- so "X
 * errored" and "nobody has said anything about that" arrive upstream looking
 * identical, and an agent told there are no results says so.
 *
 * Found on a live signed-in session: a search for "ethereum" came back with
 * nothing at all, and the page said "Something went wrong. Try reloading."
 *
 * Retryable rather than permanent. The results are probably still there; this
 * request is the thing that failed.
 */
export async function refuseIfXBroke(page: Page, what: string): Promise<void> {
  const text = await readText(page).catch(() => '');
  if (looksLikeXBroke(text)) {
    throw PipelineError.retryable(
      'x_page_error',
      `X could not show ${what}: its own page says something went wrong. Nothing was read, which is not the same as nothing being there.`,
    );
  }
  // The same refusal for a page X never drew. Asked last, because an error
  // page names its own cause and a stalled one does not.
  const spinner = await page
    .locator('[data-testid="primaryColumn"] [role="progressbar"]')
    .first()
    .isVisible()
    .catch(() => false);
  if (looksLikeXStalled(text, spinner)) {
    throw PipelineError.retryable(
      'x_page_stalled',
      `X never finished drawing ${what}: it showed its loading screen and nothing else. Nothing was read, which is not the same as nothing being there.`,
    );
  }
}

/**
 * How many times to scroll a feed looking for more.
 *
 * Eight passes of two thousand pixels reaches roughly sixty mentions, which is
 * far more than a poll every two minutes will ever need. The cap exists because
 * an infinite feed has no end to scroll to, and a poller that tries to find one
 * never returns.
 */
export const MAX_SCROLL_PASSES = 8;

/**
 * Short randomised pause between UI steps.
 *
 * This exists for reliability, not for evading anything: the X timeline is a
 * virtualised list that re-renders asynchronously, and acting on the frame that
 * was there a moment ago is the single largest source of flaky automation.
 */
export async function settle(minMs = 350, maxMs = 900): Promise<void> {
  await sleep(minMs + Math.random() * (maxMs - minMs));
}

/**
 * Runs one operation on the tab that belongs to it.
 *
 * ACTION for anything that changes something on X or verifies where a change
 * will land; MENTIONS and NOTIFICATIONS for the two discovery surfaces. Reading
 * on one tab can no longer discard a composer open on another, and a monitor
 * that fails is recorded against its own tab rather than against the account.
 */
export async function withSession<T>(
  ctx: ChannelContext,
  role: TabRole,
  fn: (session: LeasedSession) => Promise<T>,
): Promise<T> {
  const session = await leaseSession(
    {
      accountId: ctx.account.id,
      mode: ctx.session?.mode ?? 'MANAGED',
      profileDir: resolveProfileDir(ctx.account.id, ctx.session?.profileDir),
      cdpUrl: ctx.session?.cdpUrl ?? null,
      engine: ctx.session?.engine ?? 'GOOGLE_CHROME',
      channel: ctx.session?.channel ?? null,
      headless: envBool('AI17Z_BROWSER_HEADLESS', false),
    },
    role,
  );
  try {
    const result = await fn(session);
    await session.release();
    return result;
  } catch (error) {
    await session.releaseFailed(errorMessage(error));
    throw error;
  }
}

export async function goto(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  } catch (error) {
    throw PipelineError.retryable('navigation_failed', `Could not open ${url}: ${errorMessage(error)}`, { url }, error);
  }
  await settle(800, 1_600);
}

export async function isAuthenticated(page: Page): Promise<boolean> {
  const marker = page.locator(SEL.loggedIn).first();
  try {
    await marker.waitFor({ state: 'visible', timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

export async function readText(page: Page): Promise<string> {
  try {
    return (await page.locator('body').innerText({ timeout: 10_000 })) ?? '';
  } catch {
    return '';
  }
}

export function selfHandles(ctx: ChannelContext): string[] {
  const configured = Array.isArray((ctx.account.settings as { selfHandles?: unknown }).selfHandles)
    ? ((ctx.account.settings as { selfHandles: unknown[] }).selfHandles as string[])
    : [];
  return [ctx.account.handle, ...configured]
    .map((h) => normalizeHandle(h))
    .filter((h): h is string => Boolean(h));
}

/**
 * Handles from the "Replying to @a @b" line X renders above a reply.
 *
 * There is no test id on that line, so it is read from the article's own text
 * rather than by selector — which also means a redesign of the markup does not
 * silently turn the cross-check off. X truncates the list ("and 3 others"), so
 * this is a confirmation signal and never the thing that picks a parent.
 */
export function replyingToHandles(articleText: string): string[] {
  const line = articleText.split('\n').find((l) => /^\s*replying to\b/i.test(l));
  if (!line) return [];
  return [...line.matchAll(/@([A-Za-z0-9_]{1,15})/g)]
    .map((m) => normalizeHandle(m[1]))
    .filter((h): h is string => Boolean(h));
}

/**
 * Whether a post says enough to be answered without looking at anything else.
 *
 * Deliberately crude and deliberately conservative: "thoughts?" and "this?" are
 * questions about something else, and treating them as self-contained is how an
 * agent answers confidently about a chart it never saw.
 */
// `textStandsAlone` now lives in @xbam/shared, because the runtime asks the
// same question when deciding whether an unread image is a gap worth admitting
// to, and the two copies had drifted into being a bare word count.

/** How long one read of a whole thread may take before the slow path is used. */
const ARTICLES_READ_TIMEOUT_MS = 15_000;

/**
 * Reads the first `count` articles on the page in one evaluation.
 *
 * The same fields, from the same selectors, as `readArticle`, which asks the
 * renderer for each field of each article separately: six or seven round trips
 * an article, and a thread reads up to twenty of them. Measured on a live
 * installation, reading the thread took 30 to 60 seconds of every reply, with
 * the model itself taking under ten. The radar's monitors paid the same price
 * once and were fixed the same way.
 *
 * Returns null when the evaluation fails or does not come back in time, and the
 * caller reads the articles one at a time as before. A renderer that has
 * stopped answering is exactly the case a single long evaluation must not wait
 * on for ever.
 */
export async function readArticles(page: Page, count: number): Promise<ArticleSnapshot[] | null> {
  const evaluation = page
    .locator(SEL.tweetArticle)
    .evaluateAll(
      (nodes, args) =>
        nodes.slice(0, args.max).map((node) => {
          const el = node as HTMLElement;
          const timed = el.querySelector('a:has(time)') as HTMLAnchorElement | null;
          const anyStatus = el.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null;
          const href = timed?.getAttribute('href') ?? anyStatus?.getAttribute('href') ?? null;
          const nameEl = el.querySelector(args.userName) as HTMLElement | null;
          const nameBlock = nameEl ? nameEl.innerText : '';
          const texts = Array.from(el.querySelectorAll(args.tweetText)).map((t) => (t as HTMLElement).innerText);
          const createdAt = el.querySelector('time')?.getAttribute('datetime') ?? null;
          const verified = el.querySelector(args.verifiedBadge) !== null;
          const whole = el.innerText ?? '';
          return { href, nameBlock, texts, createdAt, verified, whole };
        }),
      { max: count, userName: SEL.userName, tweetText: SEL.tweetText, verifiedBadge: SEL.verifiedBadge },
    )
    .catch(() => null);

  let timer: NodeJS.Timeout | undefined;
  const raw = await Promise.race([
    evaluation,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ARTICLES_READ_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  if (!raw) return null;

  return raw.map((item, index) => {
    const url = item.href ? `https://x.com${item.href.startsWith('/') ? item.href : `/${item.href}`}` : null;
    const handleFromName = item.nameBlock.match(/@([A-Za-z0-9_]{1,15})/)?.[1] ?? null;
    const displayName = item.nameBlock.split('\n')[0]?.trim() || null;
    return {
      index,
      statusId: extractStatusId(url),
      authorHandle: normalizeHandle(handleFromName) ?? handleFromUrl(url),
      authorDisplayName: displayName && !displayName.startsWith('@') ? displayName : null,
      text: item.texts.join('\n').trim(),
      url: normalizeTargetId(url),
      createdAt: item.createdAt,
      // Unknown, not unverified, when the name block itself could not be read.
      authorVerified: item.nameBlock ? item.verified : null,
      replyingTo: replyingToHandles(item.whole),
    };
  });
}

/** Reads one anchored article. All extraction is scoped to the article element. */
/*
  The article was already found on the page, so a part of it that is absent now
  is absent. Playwright waits up to thirty seconds for an element to appear
  before reading it, and an article with no timestamp link spent that full
  wait before the fallback ran. Two seconds rather than media.ts's one, because
  verification before a reply reads through here too. See media.ts.
*/
const ALREADY_DRAWN = { timeout: 2_000 };

export async function readArticle(page: Page, articleSelector: string, index = 0): Promise<ArticleSnapshot> {
  const article = page.locator(articleSelector).first();

  // An article's own permalink is the link wrapping its timestamp. Taking the
  // first `/status/` link instead meant an article carrying a quoted post could
  // report the quoted post's id as its own -- so the focal post was read under
  // the wrong id, `resolveBranch` could not find it, and the job retried five
  // times against a post the page was plainly showing before going to a person.
  //
  // Falls back to the first link, because an article with no timestamp is
  // stranger than one whose first link is the right one.
  const href =
    (await article
      .locator('a:has(time)')
      .first()
      .getAttribute('href', ALREADY_DRAWN)
      .catch(() => null)) ??
    (await article
      .locator('a[href*="/status/"]')
      .first()
      .getAttribute('href', ALREADY_DRAWN)
      .catch(() => null));
  const url = href ? `https://x.com${href.startsWith('/') ? href : `/${href}`}` : null;

  // "Display Name\n@handle\n·\n2h" is how X composes this block, so the first
  // line is the display name and the rest is machine detail.
  const nameBlock = await article
    .locator(SEL.userName)
    .first()
    .innerText(ALREADY_DRAWN)
    .catch(() => '');
  const handleFromName = nameBlock.match(/@([A-Za-z0-9_]{1,15})/)?.[1] ?? null;
  const displayName = nameBlock.split('\n')[0]?.trim() || null;

  const textParts = await article
    .locator(SEL.tweetText)
    .allInnerTexts()
    .catch(() => [] as string[]);

  const createdAt = await article
    .locator('time')
    .first()
    .getAttribute('datetime', ALREADY_DRAWN)
    .catch(() => null);

  // X marks a verified account with a badge inside the name block. Its absence
  // is reported as "not verified" only when the name block itself was readable;
  // an unread block is unknown, not unverified.
  const authorVerified = nameBlock
    ? (await article
        .locator(SEL.verifiedBadge)
        .first()
        .count()
        .catch(() => 0)) > 0
    : null;

  const whole = await article.innerText(ALREADY_DRAWN).catch(() => '');

  return {
    index,
    statusId: extractStatusId(url),
    authorHandle: normalizeHandle(handleFromName) ?? handleFromUrl(url),
    authorDisplayName: displayName && !displayName.startsWith('@') ? displayName : null,
    text: textParts.join('\n').trim(),
    url: normalizeTargetId(url),
    createdAt,
    authorVerified,
    replyingTo: replyingToHandles(whole),
  };
}
