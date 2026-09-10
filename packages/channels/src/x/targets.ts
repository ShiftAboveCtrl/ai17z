/**
 * Canonical identity for an X post.
 *
 * This is the single strongest idea inherited from AI4CZ. Every dedupe key,
 * every verification step, and every stored target reference goes through here,
 * so `123`, `twitter.com/u/status/123?s=20`, and `https://x.com/u/status/123`
 * are one target and can never produce two replies.
 */

const X_HOST = 'x.com';

export function normalizeTargetId(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  if (/^\d{5,25}$/.test(raw)) return `https://${X_HOST}/i/status/${raw}`;

  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== X_HOST && host !== 'twitter.com' && host !== 'mobile.twitter.com' && host !== 'mobile.x.com') {
    return null;
  }
  if (!/\/status\/\d+/.test(url.pathname)) return null;

  url.hostname = X_HOST;
  url.protocol = 'https:';
  url.search = '';
  url.hash = '';
  // Strip trailing segments such as /photo/1 or /video/1 so a media permalink and
  // the post itself normalise to the same target.
  const match = url.pathname.match(/^(\/[^/]+\/status\/\d+)/);
  url.pathname = match?.[1] ?? url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export function extractStatusId(target: string | null | undefined): string | null {
  if (!target) return null;
  const raw = String(target).trim();
  if (/^\d{5,25}$/.test(raw)) return raw;
  const match = raw.match(/\/status\/(\d{5,25})/);
  return match?.[1] ?? null;
}

export function buildStatusUrl(target: string | null | undefined): string | null {
  const normalized = normalizeTargetId(target);
  if (normalized) return normalized;
  const statusId = extractStatusId(target);
  return statusId ? `https://${X_HOST}/i/status/${statusId}` : null;
}

export function normalizeHandle(handle: string | null | undefined): string | null {
  if (!handle) return null;
  const cleaned = String(handle).trim().replace(/^@+/, '').toLowerCase();
  return /^[a-z0-9_]{1,15}$/.test(cleaned) ? cleaned : null;
}

export function handleFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = String(url).match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\//);
  return match?.[1] ? normalizeHandle(match[1]) : null;
}

/** Text X shows when a post is gone. Each entry is a case seen in production. */
export const UNAVAILABLE_MARKERS = [
  'this post was deleted by the post author',
  'this tweet was deleted by the tweet author',
  'hmm...this page doesn',
  'hmm... this page doesn',
  'post not found',
  'tweet not found',
  'this account owner limits who can view',
  'you are not authorized to see this',
  'sorry, that page does',
];

export function looksUnavailable(pageText: string): boolean {
  const haystack = pageText.toLowerCase();
  return UNAVAILABLE_MARKERS.some((marker) => haystack.includes(marker));
}

/**
 * X saying its own request failed.
 *
 * Different from a page that is unavailable, and the difference matters: this
 * one is transient and worth retrying, and the post or the results are probably
 * still there.
 *
 * It exists because a search that hits this returns an empty list. "X errored"
 * and "nobody has said anything about that" then look identical to everything
 * upstream, and an agent told there are no results will say so. Found on a live
 * signed-in session, where a search for "ethereum" -- which certainly has
 * results -- came back with nought.
 *
 * The connectivity banner is the same failure wearing different words, and it
 * was found the same way: reading @ai17zOS's profile returned no articles at
 * all, and the page said "Seems like you lost connectivity. We'll keep
 * retrying." Both halves are listed because either sentence can be reworded on
 * its own, and matching one of them is better than matching neither.
 *
 * Every marker here is apostrophe-free on purpose. X writes a typographic
 * apostrophe, so a marker containing one matches the page and not the string
 * anybody would write down here.
 */
export const RETRYABLE_MARKERS = [
  'something went wrong. try reloading',
  'something went wrong, but don',
  'try reloading',
  'seems like you lost connectivity',
  'keep retrying',
];

export function looksLikeXBroke(pageText: string): boolean {
  const haystack = pageText.toLowerCase();
  return RETRYABLE_MARKERS.some((marker) => haystack.includes(marker));
}
