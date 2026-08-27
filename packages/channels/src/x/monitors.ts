import type { RadarCandidate, RadarPollResult, RadarSourceKind } from '@xbam/shared/contracts';
import { errorMessage } from '@xbam/shared';
import type { Page } from '@xbam/browser';
import { SEL, X_URLS } from './selectors';
import { extractStatusId, handleFromUrl, normalizeHandle, normalizeTargetId } from './targets';

/**
 * The several ways X will tell you something happened.
 *
 * Notifications drop things. Search is incomplete and ranked. A thread collects
 * replies that never produce a notification at all. Each monitor here is one
 * imperfect view, and the reconciler upstream merges them on the status id, so
 * being missed by one surface no longer means being missed entirely.
 *
 * Every X-specific idea about how to find a post stays in this file.
 */

export interface MonitorContext {
  page: Page;
  /** Handles belonging to this account, so its own posts are never candidates. */
  selfHandles: string[];
  limit: number;
  /** High-water mark from the previous poll, when the source keeps one. */
  cursor: string | null;
  target: string | null;
}

/** A post as seen on a timeline, before anything is decided about it. */
interface Seen {
  statusId: string | null;
  authorHandle: string | null;
  text: string;
  url: string | null;
}

async function readArticle(page: Page, selector: string): Promise<Seen> {
  const article = page.locator(selector).first();
  const href = await article
    .locator('a[href*="/status/"]')
    .first()
    .getAttribute('href')
    .catch(() => null);
  const url = href ? `https://x.com${href.startsWith('/') ? href : `/${href}`}` : null;

  const nameBlock = await article
    .locator(SEL.userName)
    .first()
    .innerText()
    .catch(() => '');

  const textParts = await article
    .locator(SEL.tweetText)
    .allInnerTexts()
    .catch(() => [] as string[]);

  return {
    statusId: extractStatusId(url),
    authorHandle: normalizeHandle(nameBlock.match(/@([A-Za-z0-9_]{1,15})/)?.[1] ?? null) ?? handleFromUrl(url),
    text: textParts.join('\n').trim(),
    url: normalizeTargetId(url),
  };
}

/**
 * Walks whatever timeline is currently loaded and turns it into candidates.
 *
 * Scans further than the limit because timelines interleave things that are not
 * candidates at all — the account's own posts, promoted content, empty cards.
 */
async function harvest(ctx: MonitorContext, eventType: string, sourceLabel: string): Promise<RadarCandidate[]> {
  const articles = ctx.page.locator(SEL.tweetArticle);
  const available = await articles.count().catch(() => 0);
  const scan = Math.min(available, Math.max(ctx.limit, 1) * 3);

  const candidates: RadarCandidate[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < scan && candidates.length < ctx.limit; index += 1) {
    const snapshot = await readArticle(ctx.page, `${SEL.tweetArticle} >> nth=${index}`);
    if (!snapshot.statusId || seen.has(snapshot.statusId)) continue;
    seen.add(snapshot.statusId);

    // Never treat our own posts as something to respond to. This is what stops
    // an agent holding a conversation with itself.
    if (snapshot.authorHandle && ctx.selfHandles.includes(snapshot.authorHandle)) continue;
    if (!snapshot.text) continue;

    // The cursor is the newest post from last time, so everything below it has
    // already been seen. Stopping here is what keeps a poll cheap.
    if (ctx.cursor && snapshot.statusId === ctx.cursor) break;

    candidates.push({
      remoteId: snapshot.statusId,
      remoteUrl: snapshot.url,
      authorHandle: snapshot.authorHandle,
      authorId: null,
      authorDisplayName: null,
      text: snapshot.text,
      parentRemoteId: null,
      conversationRemoteId: snapshot.statusId,
      occurredAt: new Date().toISOString(),
      eventType,
      raw: { source: sourceLabel, index },
    });
  }
  return candidates;
}

async function goto(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  // Timelines render after the document is ready; waiting for an article is more
  // reliable than a fixed pause and much faster when the page is quick.
  await page
    .locator(SEL.tweetArticle)
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .catch(() => undefined);
}

/** X's search URL for a query, newest first rather than ranked. */
export function latestSearchUrl(query: string): string {
  return `https://x.com/search?q=${encodeURIComponent(query)}&f=live`;
}

export type XMonitor = (ctx: MonitorContext) => Promise<RadarPollResult>;

/** Wraps a monitor so a failure becomes a reported error rather than a throw. */
function guarded(kind: string, run: XMonitor): XMonitor {
  return async (ctx) => {
    try {
      return await run(ctx);
    } catch (error) {
      return { candidates: [], cursor: null, error: `${kind}: ${errorMessage(error)}` };
    }
  };
}

const withCursor = (candidates: RadarCandidate[]): RadarPollResult => ({
  candidates,
  // The newest thing seen becomes the next stopping point.
  cursor: candidates[0]?.remoteId ?? null,
  error: null,
});

export const X_MONITORS: Record<RadarSourceKind, XMonitor> = {
  /** The platform's own notifications. One source, never the whole truth. */
  notifications: guarded('notifications', async (ctx) => {
    await goto(ctx.page, X_URLS.mentions);
    return withCursor(await harvest(ctx, 'MENTION', 'notifications'));
  }),

  /**
   * Searching for the handle. Catches mentions that notifications lost, and is
   * the reason a quiet notifications surface is no longer silence.
   */
  mention_search: guarded('mention_search', async (ctx) => {
    const handle = ctx.selfHandles[0];
    if (!handle) return { candidates: [], cursor: null, error: 'This account has no handle to search for.' };
    await goto(ctx.page, latestSearchUrl(`@${handle} -from:${handle}`));
    return withCursor(await harvest(ctx, 'MENTION', 'mention_search'));
  }),

  /** Replies addressed to the account, which search indexes separately. */
  reply_search: guarded('reply_search', async (ctx) => {
    const handle = ctx.selfHandles[0];
    if (!handle) return { candidates: [], cursor: null, error: 'This account has no handle to search for.' };
    await goto(ctx.page, latestSearchUrl(`to:${handle} -from:${handle}`));
    return withCursor(await harvest(ctx, 'REPLY', 'reply_search'));
  }),

  /**
   * Replies underneath the agent's own posts.
   *
   * The target is one of our own status ids, chosen by the caller from the
   * ledger of recent posts. Reading a thread directly is the only way to see a
   * reply that generated no notification.
   */
  own_threads: guarded('own_threads', async (ctx) => {
    if (!ctx.target) return { candidates: [], cursor: null, error: 'No own post was given to check.' };
    await goto(ctx.page, `https://x.com/i/status/${ctx.target}`);
    const candidates = await harvest(ctx, 'REPLY', 'own_threads');
    return {
      // Everything under our own post is a reply to it, whatever the DOM says.
      candidates: candidates.map((c) => ({ ...c, parentRemoteId: ctx.target, conversationRemoteId: ctx.target })),
      cursor: null,
      error: null,
    };
  }),

  /**
   * An account worth watching. Watching is not permission to reply — that is
   * decided by the source's own mayTrigger setting and by capabilities.
   */
  tracked_account: guarded('tracked_account', async (ctx) => {
    if (!ctx.target) return { candidates: [], cursor: null, error: 'No account was given to watch.' };
    await goto(ctx.page, `https://x.com/${normalizeHandle(ctx.target) ?? ctx.target}`);
    return withCursor(await harvest(ctx, 'POST', 'tracked_account'));
  }),

  /** A keyword, phrase, ticker, or a custom query written by the owner. */
  tracked_keyword: guarded('tracked_keyword', async (ctx) => {
    if (!ctx.target) return { candidates: [], cursor: null, error: 'No keyword was given to watch.' };
    await goto(ctx.page, latestSearchUrl(ctx.target));
    return withCursor(await harvest(ctx, 'POST', 'tracked_keyword'));
  }),
};
