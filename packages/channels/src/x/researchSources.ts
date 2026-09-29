import { createHash } from 'node:crypto';
import type { EvidenceKind, ResearchObservation, SourceFamily, SourceTrustTier } from '@xbam/shared/contracts';
import type { XPostRecord } from './intelligence/contract';
import type { ChannelContext } from '../contract';
import { withSession } from './page';

/**
 * What X and its copies look like, for the Research Fabric.
 *
 * The fabric sees opaque object keys and source families; this file is the one
 * place that knows `x.com/<handle>/status/<id>` is a post, that twstalker.com
 * and www6.twstalker.com are the same mirror, and what a challenge page says.
 * Kept here because nothing downstream of a channel may know what X looks like.
 *
 * Mirrors are handled as copies, never as witnesses. A post read off a mirror
 * is recorded with the mirror's family and tier, keyed on the X post it copies,
 * so the X reading of the same post and the mirror's copy of it are one object
 * with two sightings, and the X reading wins.
 */

const X_HOSTS = new Set(['x.com', 'twitter.com', 'mobile.x.com', 'mobile.twitter.com']);

/** Hosts that are one mirror however many subdomains it serves from. */
const MIRROR_FAMILIES: ReadonlyArray<{ family: SourceFamily; host: RegExp }> = [
  { family: 'TWSTALKER', host: /(^|\.)twstalker\.com$/i },
  { family: 'SOTWE', host: /(^|\.)sotwe\.com$/i },
];

/** A handle as X spells it in a URL, never one of X's own reserved paths. */
const RESERVED = new Set(['i', 'home', 'search', 'explore', 'notifications', 'messages', 'settings', 'intent', 'share', 'hashtag']);

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Which family a URL belongs to, or null for the ordinary web. */
export function sourceFamilyOfUrl(url: string | null | undefined): SourceFamily | null {
  if (!url) return null;
  const host = hostOf(url);
  if (!host) return null;
  if (X_HOSTS.has(host)) return 'X';
  return MIRROR_FAMILIES.find((m) => m.host.test(host))?.family ?? null;
}

export interface XStatusRef {
  handle: string | null;
  statusId: string;
}

/**
 * The post a URL points at, on X or on a mirror.
 *
 * X: `/<handle>/status/<id>`, `/i/web/status/<id>`, `/<handle>/statuses/<id>`.
 * Mirrors copy the same id into their own paths (`/status/<id>`, `/tweet/<id>`),
 * so any path segment of that shape following one of those words is read. The
 * id is what matters: a status id is a snowflake, so fewer than ten digits is
 * not one.
 */
export function xStatusRefOf(url: string | null | undefined): XStatusRef | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const family = sourceFamilyOfUrl(url);
  if (!family || (family !== 'X' && family !== 'TWSTALKER' && family !== 'SOTWE')) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  for (let i = 0; i < parts.length - 1; i += 1) {
    const word = parts[i]!.toLowerCase();
    const id = parts[i + 1]!;
    if ((word === 'status' || word === 'statuses' || word === 'tweet') && /^\d{10,25}$/.test(id)) {
      const before = i > 0 ? parts[i - 1]! : null;
      // `/i/web/status/<id>` is X's own path for a post whose author it has
      // not said; `web` there is not somebody called @web.
      const xOwnPath = i >= 2 && parts[i - 2]!.toLowerCase() === 'i';
      const handle =
        before && !xOwnPath && /^[A-Za-z0-9_]{1,15}$/.test(before) && !RESERVED.has(before.toLowerCase()) ? before : null;
      return { handle, statusId: id };
    }
  }
  return null;
}

/** The one URL a post is known by, whichever copy it was found through. */
export function canonicalXStatusUrl(ref: XStatusRef): string {
  return ref.handle ? `https://x.com/${ref.handle}/status/${ref.statusId}` : `https://x.com/i/web/status/${ref.statusId}`;
}

/** The fabric's key for an X post: the same whether read on X, a mirror or in a search result. */
export function xPostKey(statusId: string): string {
  return `x:status:${statusId}`;
}

export function xProfileKey(handle: string): string {
  return `x:user:${handle.replace(/^@+/, '').toLowerCase()}`;
}

/**
 * Text that means a page is a bot check rather than the page.
 *
 * Cloudflare's managed challenge ("Just a moment", "Enable JavaScript and
 * cookies to continue") is what TwStalker and Sotwe answer every automated
 * request with, robots.txt included. Seeing one is a full stop for that source:
 * it is recorded as unavailable and never waited out, retried around or solved.
 */
const CHALLENGE_PAGE =
  /just a moment\.{0,3}|enable javascript and cookies to continue|checking your browser|cf-chl|challenge-platform|attention required!? \| cloudflare|verify you are (?:a )?human|are you a robot|unusual traffic|captcha/i;

export function isChallengePage(input: { title?: string | null; text?: string | null; status?: number | null }): boolean {
  if (input.status === 403 || input.status === 429 || input.status === 503) {
    if (CHALLENGE_PAGE.test(`${input.title ?? ''}\n${(input.text ?? '').slice(0, 4_000)}`)) return true;
  }
  return CHALLENGE_PAGE.test(input.title ?? '') || CHALLENGE_PAGE.test((input.text ?? '').slice(0, 1_500));
}

function contentHash(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex');
}

/** A web URL's identity: scheme and host lower-cased, fragment and tracking removed. */
export function canonicalWebUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|ref$|ref_src$|s$|t$)/i.test(key)) u.searchParams.delete(key);
    }
    u.hostname = u.hostname.toLowerCase();
    let out = u.toString();
    if (out.endsWith('/') && u.pathname !== '/') out = out.slice(0, -1);
    return out;
  } catch {
    return null;
  }
}

/**
 * A search engine's result, as evidence.
 *
 * A result that points at an X post is keyed on that post, so it joins the X
 * reading of it as one more sighting rather than standing as a separate claim,
 * and it is always a SNIPPET: the engine chose those words, the author may have
 * written more. Anything else is a web page known only by its snippet.
 */
export function observationFromSearchResult(
  result: { title: string; snippet: string; url: string | null },
  fetchedAt: string,
  engine: string,
): ResearchObservation {
  const ref = xStatusRefOf(result.url);
  const content = [result.title, result.snippet].filter(Boolean).join('\n').slice(0, 4_000);
  if (ref) {
    return {
      objectKey: xPostKey(ref.statusId),
      family: 'SEARCH_ENGINE',
      kind: 'SEARCH_RESULT',
      tier: 'SEARCH_INDEX',
      completeness: 'SNIPPET',
      canonicalUrl: canonicalXStatusUrl(ref),
      originalUrl: result.url,
      platform: 'x',
      externalId: ref.statusId,
      author: ref.handle,
      inReplyTo: null,
      publishedAt: null,
      fetchedAt,
      content,
      language: null,
      meta: { engine },
    };
  }
  const canonical = result.url ? canonicalWebUrl(result.url) : null;
  return {
    objectKey: canonical ? `web:${canonical}` : `web:hash:${contentHash(content)}`,
    family: 'SEARCH_ENGINE',
    kind: 'SEARCH_RESULT',
    tier: 'SEARCH_INDEX',
    completeness: 'SNIPPET',
    canonicalUrl: canonical,
    originalUrl: result.url,
    platform: null,
    externalId: null,
    author: null,
    inReplyTo: null,
    publishedAt: null,
    fetchedAt,
    content,
    language: null,
    meta: { engine },
  };
}

/** One post as a mirror rendered it: its link, its text, and whatever else it showed. */
export interface MirrorArticle {
  href: string;
  text: string;
  author?: string | null;
  inReplyTo?: string | null;
  publishedAt?: string | null;
}

/**
 * A mirror page's posts, as evidence about the X posts they copy.
 *
 * Only articles whose link names an X status id are kept: a copy that cannot be
 * tied back to the post it copies cannot be confirmed on X, and an unconfirmable
 * copy is exactly what must not be allowed to stand on its own. Duplicates on
 * one page collapse here; duplicates across a mirror's hosts collapse in the
 * fabric, because they share a key and a family.
 */
export function observationsFromMirrorArticles(
  articles: MirrorArticle[],
  family: Extract<SourceFamily, 'TWSTALKER' | 'SOTWE'>,
  fetchedAt: string,
): ResearchObservation[] {
  const seen = new Set<string>();
  const out: ResearchObservation[] = [];
  for (const article of articles) {
    const ref = xStatusRefOf(article.href);
    const text = article.text.replace(/\s+/g, ' ').trim();
    if (!ref || !text || seen.has(ref.statusId)) continue;
    seen.add(ref.statusId);
    const kind: EvidenceKind = article.inReplyTo ? 'REPLY' : 'POST';
    const tier: SourceTrustTier = 'PUBLIC_MIRROR';
    out.push({
      objectKey: xPostKey(ref.statusId),
      family,
      kind,
      tier,
      completeness: 'FULL',
      canonicalUrl: canonicalXStatusUrl({ handle: ref.handle ?? article.author ?? null, statusId: ref.statusId }),
      originalUrl: article.href,
      platform: 'x',
      externalId: ref.statusId,
      author: ref.handle ?? article.author ?? null,
      inReplyTo: article.inReplyTo ?? null,
      publishedAt: article.publishedAt ?? null,
      fetchedAt,
      content: text.slice(0, 4_000),
      language: null,
      meta: {},
    });
  }
  return out;
}

/**
 * A post read from X itself: the primary sighting every copy is measured against.
 *
 * Returns null for a repost. Pressing repost is not writing, and a persona
 * learned partly from other people's words is not that persona.
 */
export function observationFromXPost(post: XPostRecord, fetchedAt: string): ResearchObservation | null {
  if (post.repost) return null;
  const kind: EvidenceKind = post.replyToPostId ? 'REPLY' : post.quotedPostId ? 'QUOTE' : 'POST';
  const canonical = canonicalXStatusUrl({ handle: post.authorHandle || null, statusId: post.postId });
  return {
    objectKey: xPostKey(post.postId),
    family: 'X',
    kind,
    tier: 'PRIMARY_PLATFORM',
    completeness: 'FULL',
    canonicalUrl: canonical,
    originalUrl: post.url || canonical,
    platform: 'x',
    externalId: post.postId,
    author: post.authorHandle || null,
    inReplyTo: post.replyToPostId ? (post.replyToUserId ?? 'unknown') : null,
    publishedAt: post.createdAt,
    fetchedAt,
    content: post.text.slice(0, 40_000),
    language: post.lang ?? null,
    meta: {
      ...(post.replyToPostId ? { replyToPostId: post.replyToPostId } : {}),
      ...(post.quotedPostId ? { quotedPostId: post.quotedPostId } : {}),
      ...(post.conversationId ? { conversationId: post.conversationId } : {}),
    },
  };
}

// ── Reading a mirror, through the browser the worker already has ───────────

/** Where a mirror shows an account, when it can be read at all. */
export const MIRROR_PROFILE_URLS: Readonly<Record<'TWSTALKER' | 'SOTWE', (handle: string) => string>> = {
  TWSTALKER: (handle) => `https://twstalker.com/${encodeURIComponent(handle)}`,
  SOTWE: (handle) => `https://www.sotwe.com/${encodeURIComponent(handle)}`,
};

export interface MirrorPageRead {
  /** A bot check was served. The caller stops asking this mirror; it is never waited out. */
  challenge: boolean;
  status: number | null;
  articles: MirrorArticle[];
  detail: string;
}

/**
 * Reads one mirror page and returns the posts on it that name an X status.
 *
 * Looks and never touches: no clicking, no scrolling past what the page first
 * drew, no waiting for a bot check to clear itself. It runs on the RESEARCH tab
 * so a mirror read cannot disturb a monitor or a reply. Bounded in time and in
 * what it returns.
 */
export async function readMirrorPage(ctx: ChannelContext, url: string, maxArticles = 100): Promise<MirrorPageRead> {
  return withSession(ctx, 'RESEARCH', async ({ page }) => {
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => null);
      const status = response?.status() ?? null;
      const title = await page.title().catch(() => '');
      const bodyText = await page
        .locator('body')
        .innerText({ timeout: 8_000 })
        .catch(() => '');
      if (isChallengePage({ title, text: bodyText, status })) {
        return { challenge: true, status, articles: [], detail: 'The mirror answered with a bot check, so it was left alone.' };
      }
      if (status !== null && status >= 400) {
        return { challenge: false, status, articles: [], detail: `The mirror answered ${status}.` };
      }
      const articles = await page
        .evaluate((limit: number) => {
          const seen = new Set<string>();
          const out: { href: string; text: string; publishedAt: string | null }[] = [];
          for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
            const href = (anchor as HTMLAnchorElement).href;
            if (!/\/(?:status|statuses|tweet)\/\d{10,25}/.test(href) || seen.has(href)) continue;
            seen.add(href);
            const box = anchor.closest('article, li, [class*="tweet"], [class*="post"]') ?? anchor.parentElement;
            const text = (box as HTMLElement | null)?.innerText ?? '';
            const time = box?.querySelector('time');
            out.push({ href, text: text.slice(0, 4_000), publishedAt: time?.getAttribute('datetime') ?? null });
            if (out.length >= limit) break;
          }
          return out;
        }, maxArticles)
        .catch(() => [] as { href: string; text: string; publishedAt: string | null }[]);
      return { challenge: false, status, articles, detail: `Read ${articles.length} post${articles.length === 1 ? '' : 's'} from the mirror.` };
    } finally {
      await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => undefined);
    }
  });
}
