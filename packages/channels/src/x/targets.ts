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
  'this account doesn',
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

/**
 * X's epoch, from which every status id counts.
 *
 * A status id is a snowflake: the top forty-one bits are milliseconds since
 * this moment, which is Twitter's own epoch and has never moved.
 */
const X_EPOCH_MS = 1_288_834_974_657n;

/** The oldest id this will vouch for, below which the arithmetic is guesswork. */
const FIRST_SNOWFLAKE_ID = 300_000_000_000_000n;

/**
 * When a post was written, read out of its own id.
 *
 * The rendered `time` element is the obvious source and is the one preferred
 * everywhere, but it is not always there: X's notifications surface renders
 * rows that carry no timestamp at all, and a virtualised article caught
 * mid-render can lose it too. The monitors answered that with
 * `createdAt ?? new Date()`, which does not record "X did not say" -- it
 * records a specific claim that the post was written at the moment AI17Z
 * happened to look at it.
 *
 * Measured on a live installation, after it came back from being off for two
 * days: six mentions were recorded with the ingest time as their post time and
 * were wrong by up to forty-four hours. The freshness gate is fed exactly this
 * field, so the consequences ran both ways in one minute. A mention written
 * twenty-three hours earlier looked new and was answered in public. A mention
 * written three hours earlier, whose timestamp *was* readable, was refused for
 * being stale. The gate was working; what it was being told was invented.
 *
 * The id cannot be invented. It is in the permalink that identifies the post
 * at all, so if there is a candidate there is an id, and the answer is exact
 * rather than approximate: checked against three posts on that installation
 * whose timestamps X did render, all three agreed to the minute.
 *
 * Null for anything that is not a plausible snowflake, because a wrong
 * timestamp is what this function exists to stop producing.
 */
export function postedAtFromStatusId(statusId: string | null | undefined): string | null {
  if (!statusId || !/^\d{5,25}$/.test(statusId)) return null;
  let id: bigint;
  try {
    id = BigInt(statusId);
  } catch {
    return null;
  }
  if (id < FIRST_SNOWFLAKE_ID) return null;
  const ms = Number((id >> 22n) + X_EPOCH_MS);
  // A time in the future, or before X existed, means the assumption is wrong
  // about this id and the honest answer is that nothing was read.
  if (!Number.isFinite(ms) || ms > Date.now() + 60_000) return null;
  return new Date(ms).toISOString();
}
