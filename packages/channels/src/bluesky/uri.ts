/**
 * Naming a Bluesky post.
 *
 * A post is a record in its author's repository, and its identity is the
 * at:// URI of that record: `at://<did>/app.bsky.feed.post/<rkey>`. The author is
 * a DID rather than a handle on purpose, because a handle can be changed and a
 * DID cannot, so a key built on the URI survives somebody renaming themselves.
 *
 * People paste the web address instead (`https://bsky.app/profile/<handle>/post/<rkey>`),
 * which names the author by handle. That form needs one network question to
 * become a URI, so it is parsed here and resolved by the client.
 */

export const POST_COLLECTION = 'app.bsky.feed.post';
export const LIKE_COLLECTION = 'app.bsky.feed.like';

export interface AtUri {
  /** The author's DID. */
  repo: string;
  collection: string;
  rkey: string;
}

const DID = /^did:(plc|web):[a-zA-Z0-9._:%-]+$/;
// Deliberately the shape rather than the full syntax: the network is the judge
// of whether a handle exists, and a stricter regex here would refuse valid ones.
const HANDLE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;
const RKEY = /^[a-zA-Z0-9._:~-]{1,512}$/;

export function isDid(value: string): boolean {
  return DID.test(value);
}

export function isHandle(value: string): boolean {
  return value.length <= 253 && HANDLE.test(value);
}

/** Parses an at:// URI, or answers null for anything that is not exactly one. */
export function parseAtUri(uri: string): AtUri | null {
  const match = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri.trim());
  if (!match) return null;
  const [, repo, collection, rkey] = match;
  if (!repo || !collection || !rkey) return null;
  if (!isDid(repo)) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z0-9-]+)+$/.test(collection)) return null;
  if (!RKEY.test(rkey) || rkey === '.' || rkey === '..') return null;
  return { repo, collection, rkey };
}

export function isPostUri(uri: string): boolean {
  return parseAtUri(uri)?.collection === POST_COLLECTION;
}

/** What a model or a person may hand us to mean one post. */
export type PostReference =
  | { kind: 'uri'; uri: string }
  | { kind: 'web'; actor: string; rkey: string };

/**
 * Reads a post reference: an at:// URI, or a bsky.app address.
 *
 * Anything else, a bare handle above all, is refused rather than guessed at.
 * `@someone` is the argument a model actually gets wrong, and it would otherwise
 * be read as a profile and return nothing about any post.
 */
export function parsePostReference(raw: string): PostReference | null {
  const value = raw.trim();
  if (value.startsWith('at://')) {
    return isPostUri(value) ? { kind: 'uri', uri: value } : null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'bsky.app') return null;
  const match = /^\/profile\/([^/]+)\/post\/([^/]+)\/?$/.exec(url.pathname);
  if (!match) return null;
  const actor = decodeURIComponent(match[1]!);
  const rkey = match[2]!;
  if (!isDid(actor) && !isHandle(actor)) return null;
  if (!RKEY.test(rkey)) return null;
  return { kind: 'web', actor, rkey };
}

/**
 * The address a person can open.
 *
 * Handle where there is one, because it reads better, DID where there is not.
 * Either works on bsky.app.
 */
export function postPermalink(authorHandleOrDid: string, uri: string): string | null {
  const parsed = parseAtUri(uri);
  if (!parsed) return null;
  return `https://bsky.app/profile/${authorHandleOrDid}/post/${parsed.rkey}`;
}

export function normaliseHandle(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase();
}
