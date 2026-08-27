import type { MediaCandidate, MediaInventory, QuotedPost } from '@xbam/shared/contracts';
import type { Page } from '@xbam/browser';
import { extractStatusId, normalizeHandle, normalizeTargetId } from './targets';

/**
 * Reading what is attached to an X post.
 *
 * All of X's ideas about where media lives stay here. Everything downstream
 * receives a MediaInventory and never learns that `pbs.twimg.com` exists.
 */

export const MEDIA_SEL = {
  /** Photos render as an image inside a tweetPhoto container. */
  photo: '[data-testid="tweetPhoto"] img',
  /** Video and GIF both render as a player; the poster frame is the thumbnail. */
  video: '[data-testid="videoPlayer"], [data-testid="videoComponent"]',
  gifBadge: '[data-testid="placementTracking"] [aria-label*="GIF" i]',
  card: '[data-testid="card.wrapper"]',
  cardLink: '[data-testid="card.wrapper"] a[href]',
  poll: '[data-testid="cardPoll"]',
  /** A quoted post is a nested article-like block inside the tweet. */
  quote: 'div[role="link"][tabindex="0"]:has([data-testid="tweetText"])',
  tweetText: '[data-testid="tweetText"]',
  userName: '[data-testid="User-Name"]',
} as const;

/**
 * X serves the same photo at several sizes through a query parameter. The
 * largest is the one worth describing, so `name=small` is upgraded.
 */
export function upgradeImageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('name')) parsed.searchParams.set('name', 'large');
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Pulls http(s) URLs out of post text, ignoring t.co shorteners as noise. */
export function linksInText(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s]+/g) ?? [];
  return [...new Set(found.map((u) => u.replace(/[.,)\]]+$/, '')))].filter((u) => !u.includes('t.co/'));
}

async function readPhotos(scope: ReturnType<Page['locator']>): Promise<MediaCandidate[]> {
  const images = scope.locator(MEDIA_SEL.photo);
  const count = await images.count().catch(() => 0);
  const media: MediaCandidate[] = [];

  for (let index = 0; index < Math.min(count, 4); index += 1) {
    const image = images.nth(index);
    const src = await image.getAttribute('src').catch(() => null);
    if (!src) continue;
    // X uses the alt text for its own labels as well as real descriptions, so
    // the generic ones are dropped rather than passed off as a description.
    const alt = await image.getAttribute('alt').catch(() => null);
    const meaningful = alt && !/^image$/i.test(alt.trim()) ? alt.trim() : null;

    media.push({
      kind: 'image',
      position: index,
      sourceUrl: upgradeImageUrl(src),
      altText: meaningful,
      meta: {},
    });
  }
  return media;
}

async function readVideo(scope: ReturnType<Page['locator']>, position: number): Promise<MediaCandidate | null> {
  const player = scope.locator(MEDIA_SEL.video).first();
  if ((await player.count().catch(() => 0)) === 0) return null;

  const isGif = (await scope.locator(MEDIA_SEL.gifBadge).count().catch(() => 0)) > 0;
  const poster = await player
    .locator('video')
    .first()
    .getAttribute('poster')
    .catch(() => null);

  return {
    // A GIF on X is a short silent video, but it means something different: it
    // is a reaction, not content, and is worth describing far more briefly.
    kind: isGif ? 'gif' : 'video',
    position,
    sourceUrl: poster,
    altText: null,
    meta: { posterOnly: true },
  };
}

async function readQuoted(scope: ReturnType<Page['locator']>): Promise<QuotedPost | null> {
  const quote = scope.locator(MEDIA_SEL.quote).first();
  if ((await quote.count().catch(() => 0)) === 0) return null;

  const href = await quote
    .locator('a[href*="/status/"]')
    .first()
    .getAttribute('href')
    .catch(() => null);
  const url = href ? `https://x.com${href.startsWith('/') ? href : `/${href}`}` : null;

  const nameBlock = await quote
    .locator(MEDIA_SEL.userName)
    .first()
    .innerText()
    .catch(() => '');
  const text = await quote
    .locator(MEDIA_SEL.tweetText)
    .allInnerTexts()
    .catch(() => [] as string[]);

  return {
    remoteId: extractStatusId(url),
    remoteUrl: normalizeTargetId(url),
    authorHandle: normalizeHandle(nameBlock.match(/@([A-Za-z0-9_]{1,15})/)?.[1] ?? null),
    text: text.join('\n').trim(),
    media: await readPhotos(quote),
  };
}

/**
 * Everything attached to one post.
 *
 * The quoted post is read before photos on the outer post, because X nests the
 * quote inside the article and its images would otherwise be attributed to the
 * post doing the quoting.
 */
export async function readMediaInventory(
  page: Page,
  articleSelector: string,
  text: string,
): Promise<MediaInventory> {
  const article = page.locator(articleSelector).first();
  const quoted = await readQuoted(article);

  // Photos inside the quote belong to the quote. Excluding that subtree is the
  // difference between "Alice posted a chart" and "Alice quoted a chart".
  const outer = quoted ? article.locator(`:scope > *:not(:has(${MEDIA_SEL.quote}))`) : article;
  const photos = await readPhotos(quoted ? article : outer).catch(() => [] as MediaCandidate[]);
  const quotedUrls = new Set((quoted?.media ?? []).map((m) => m.sourceUrl));
  const ownPhotos = photos.filter((p) => !quotedUrls.has(p.sourceUrl)).map((p, i) => ({ ...p, position: i }));

  const video = await readVideo(article, ownPhotos.length).catch(() => null);

  const cardHref = await article
    .locator(MEDIA_SEL.cardLink)
    .first()
    .getAttribute('href')
    .catch(() => null);

  const links = linksInText(text);
  if (cardHref && cardHref.startsWith('http') && !links.includes(cardHref)) links.push(cardHref);

  const hasPoll = (await article.locator(MEDIA_SEL.poll).count().catch(() => 0)) > 0;

  return {
    media: [
      ...ownPhotos,
      ...(video ? [video] : []),
      ...(hasPoll ? [{ kind: 'poll' as const, position: 99, sourceUrl: null, altText: null, meta: {} }] : []),
    ],
    quoted,
    links,
  };
}
