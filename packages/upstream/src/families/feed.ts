import { parseXml, XmlElement, XmlText, type XmlNode } from '@rgrove/parse-xml';
import { z } from 'zod';
import { defineUpstream, type Upstream } from '../contract';
import { perMinute, perSecond } from '../quota';
import { registerUpstream } from '../registry';
import { safeFetch } from '../http';
import { UpstreamFailure, classifyStatus, classifyThrown } from '../failures';

/**
 * RSS and Atom, read once and normalised into one shape.
 *
 * ### Why a parser rather than regular expressions
 *
 * Feeds are XML somebody else wrote, and the two attacks that matter are
 * entity expansion and external entity resolution. `@rgrove/parse-xml` was
 * chosen because it does not resolve entities at all -- by design rather than
 * by an option somebody could turn off -- and because it is ISC, has no
 * dependencies of its own, and is 212 KB. The obvious alternative was 1.3 MB
 * across six transitive packages, one of which is an XML *builder* nothing here
 * would ever call.
 *
 * Verified rather than taken on trust, September 2026:
 *
 *   a six-level billion-laughs bomb  refused in 1ms, "&lol6; isn't defined"
 *   <!ENTITY xxe SYSTEM "file:...">  refused, the file is never opened
 *   a plain <!DOCTYPE rss>           parses, because real feeds carry one
 *
 * That last line matters: the GitHub blog's feed really does declare a DOCTYPE,
 * so refusing every document that has one would refuse a working feed.
 *
 * ### What real feeds actually look like
 *
 * Probed September 2026, and the variety is the point:
 *
 *   rust blog, Atom        155 KB   ETag + Last-Modified, 304 works
 *   Hacker News, RSS        11 KB   no ETag, no Last-Modified, no <guid>
 *   GitHub blog, RSS       646 KB   ETag, CDATA, DOCTYPE, isPermaLink="false"
 *
 * Three feeds, three different answers to "what identifies an entry", which is
 * why identity here is a priority order rather than a field.
 *
 * ### One family, many hosts
 *
 * Every other family talks to one operator. A feed is whatever URL somebody
 * subscribed to, so `origin` cannot be a host and the machine-scoped windows
 * below carry a `per` discriminator instead: each feed host gets its own
 * budget, keyed within the family's. The host that actually answered travels
 * on the answer as `servedBy`, because provenance naming a placeholder would
 * be worse than useless.
 */

export const FEED_FAMILY = 'feed';

/** Where the entry's identity came from, so a weak one can be recognised. */
export const ENTRY_IDENTITY_SOURCES = ['GUID', 'ATOM_ID', 'URL', 'FINGERPRINT'] as const;
export type EntryIdentitySource = (typeof ENTRY_IDENTITY_SOURCES)[number];

export const FEED_KINDS = ['RSS', 'ATOM', 'RDF'] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

export const FeedQuery = z.object({
  url: z.string().min(1).max(2048),
  /** From the last read of this feed, so an unchanged feed costs nothing. */
  etag: z.string().max(400).nullable().default(null),
  lastModified: z.string().max(200).nullable().default(null),
  /** How many entries to keep. Feeds are ordered newest first by convention. */
  limit: z.number().int().min(1).max(200).default(50),
});
export type FeedQuery = z.infer<typeof FeedQuery>;

export interface FeedEntry {
  /**
   * What this entry is, for deduplication.
   *
   * Never the title. A title is edited, reused across posts, and identical
   * between a draft and its correction -- treating it as identity produces both
   * duplicates and silent losses.
   */
  id: string;
  identitySource: EntryIdentitySource;
  title: string | null;
  /** The entry's own page, absolute where it could be resolved. */
  url: string | null;
  author: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  /** Bounded. HTML is carried as text and is never anything but data. */
  summary: string | null;
  content: string | null;
  categories: string[];
  /** A hash of the parts that carry meaning, for noticing an edit in place. */
  fingerprint: string;
}

export interface FeedAnswer {
  /** True when the source said nothing changed, and nothing was parsed. */
  notModified: boolean;
  kind: FeedKind | null;
  title: string | null;
  /** The feed's own home page. */
  siteUrl: string | null;
  /** Validators to send back next time, when the source offered them. */
  etag: string | null;
  lastModified: string | null;
  entries: FeedEntry[];
  /** How many entries the feed held before the limit was applied. */
  totalEntries: number;
  /** The host that actually answered. */
  servedBy: string;
}

/**
 * The largest feed this will read.
 *
 * The GitHub blog's is 646 KB, which is the largest seen in the wild and is
 * real rather than pathological. Three times that leaves room without inviting
 * a feed that is really a database dump.
 */
export const MAX_FEED_BYTES = 2_000_000;
/** How much of one entry's text may travel. */
export const MAX_ENTRY_CHARS = 8_000;

const USER_AGENT = 'AI17Z/1.0 (+https://github.com/ShiftAboveCtrl/ai17z) feed-reader';

// --- reading the tree ------------------------------------------------------
//
// Everything below matches on the *local* name. Feeds use prefixes freely --
// `content:encoded`, `dc:creator`, `media:thumbnail` -- and which prefix maps to
// which namespace is the document's business, not ours.

function localName(element: XmlElement): string {
  const at = element.name.indexOf(':');
  return (at === -1 ? element.name : element.name.slice(at + 1)).toLowerCase();
}

function elements(node: XmlElement): XmlElement[] {
  return node.children.filter((child): child is XmlElement => child instanceof XmlElement);
}

function childNamed(node: XmlElement, ...names: string[]): XmlElement | null {
  const wanted = names.map((name) => name.toLowerCase());
  return elements(node).find((child) => wanted.includes(localName(child))) ?? null;
}

function childrenNamed(node: XmlElement, ...names: string[]): XmlElement[] {
  const wanted = names.map((name) => name.toLowerCase());
  return elements(node).filter((child) => wanted.includes(localName(child)));
}

/** All the text under a node, CDATA included, bounded and tidied. */
function textOf(node: XmlElement | null, max = MAX_ENTRY_CHARS): string | null {
  if (!node) return null;
  let out = '';
  const walk = (current: XmlNode): void => {
    if (out.length >= max) return;
    // CDATA arrives as text: this parser folds it in by default, and its
    // CDATA node is a subclass of text regardless. A separate branch for it
    // would be a branch that never runs.
    if (current instanceof XmlText) {
      out += current.text;
    } else if (current instanceof XmlElement) {
      for (const child of current.children) walk(child);
    }
  };
  for (const child of node.children) walk(child);
  const trimmed = out.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

function attribute(node: XmlElement | null, name: string): string | null {
  if (!node) return null;
  const found = Object.entries(node.attributes).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = found?.[1];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * An entry's link, which is a different thing in each format.
 *
 * RSS puts it in the element's text. Atom puts it in a `href` attribute and may
 * offer several, of which only `rel="alternate"` (or no rel at all) is the
 * entry's own page -- `rel="enclosure"` is an attachment and `rel="via"` is
 * somebody else's page. Taking the first link found would sometimes hand back
 * a podcast audio file as the article.
 */
function linkOf(node: XmlElement, base: string | null): string | null {
  const links = childrenNamed(node, 'link');
  for (const link of links) {
    const rel = attribute(link, 'rel');
    if (rel && rel.toLowerCase() !== 'alternate') continue;
    const href = attribute(link, 'href') ?? textOf(link, 2048);
    if (href) return absolute(href, base);
  }
  // RSS 1.0 and some RSS 2.0 feeds have no usable <link>; a permalink guid is
  // the next best thing the document offers.
  const guid = childNamed(node, 'guid');
  if (guid && attribute(guid, 'isPermaLink') !== 'false') {
    const text = textOf(guid, 2048);
    if (text && /^https?:\/\//i.test(text)) return absolute(text, base);
  }
  return null;
}

/** Resolves a relative link against the feed, which many feeds rely on. */
function absolute(href: string, base: string | null): string | null {
  try {
    return base ? new URL(href, base).toString() : new URL(href).toString();
  } catch {
    return null;
  }
}

/**
 * A date, from either of the two formats feeds use.
 *
 * RSS carries RFC 822 (`Fri, 11 Sep 2026 17:54:53 +0000`) and Atom carries
 * ISO 8601. `Date` parses both, so the work here is refusing what it returns
 * for nonsense rather than parsing: an unparseable date must stay null, because
 * a wrong timestamp on an entry is worse than no timestamp.
 */
function dateOf(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value.trim());
  if (Number.isNaN(parsed.getTime())) return null;
  // A feed claiming the year 1200 or 9999 has a broken date, not an old post.
  const year = parsed.getUTCFullYear();
  if (year < 1990 || year > 2200) return null;
  return parsed.toISOString();
}

/**
 * A cheap, stable hash of the parts of an entry that carry meaning.
 *
 * The parts are length-delimited rather than joined with a separator, so no
 * character is special. A separator only works while it cannot appear in the
 * data, and feed text is arbitrary: with a space, a title of "a b" and a title
 * of "a" beside a summary of "b" hash identically, and two different entries
 * would be treated as one edit of the same entry.
 */
function fingerprint(parts: (string | null)[]): string {
  // FNV-1a, 64-bit, which is plenty to notice an edit and costs nothing.
  let hash = 0xcbf29ce484222325n;
  const mix = (byte: number): void => {
    hash ^= BigInt(byte & 0xff);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  };
  for (const part of parts) {
    const text = part ?? '';
    // The length first, so where one field ends and the next begins is part of
    // what is hashed.
    mix(text.length & 0xff);
    mix((text.length >>> 8) & 0xff);
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      mix(code & 0xff);
      mix((code >>> 8) & 0xff);
    }
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * What identifies this entry, and how confident that is.
 *
 * The order is not a preference, it is a correctness ranking, and each step
 * down is a real weakening:
 *
 *   a stable id the publisher assigned  -- survives edits and re-ordering
 *   the entry's own URL                 -- stable until the site moves, and
 *                                          shared when two entries link the
 *                                          same article, which Hacker News
 *                                          does whenever a story is reposted
 *   a fingerprint of the content        -- changes the moment a typo is fixed,
 *                                          so an edit looks like a new entry
 *
 * Hacker News publishes no guid at all and GitHub publishes one that is
 * explicitly not a URL, so all three steps are reached by real feeds.
 */
function identify(entry: XmlElement, url: string | null, print: string): { id: string; source: EntryIdentitySource } {
  const guid = childNamed(entry, 'guid');
  const guidText = textOf(guid, 2048);
  if (guidText) return { id: guidText, source: 'GUID' };

  const atomId = textOf(childNamed(entry, 'id'), 2048);
  if (atomId) return { id: atomId, source: 'ATOM_ID' };

  if (url) return { id: url, source: 'URL' };
  return { id: print, source: 'FINGERPRINT' };
}

function readEntry(node: XmlElement, base: string | null): FeedEntry {
  const title = textOf(childNamed(node, 'title'), 1_000);
  const url = linkOf(node, base);
  const summary = textOf(childNamed(node, 'description', 'summary', 'subtitle'));
  const content = textOf(childNamed(node, 'encoded', 'content'));
  const author =
    textOf(childNamed(node, 'creator'), 200) ??
    textOf(childNamed(childNamed(node, 'author') ?? node, 'name'), 200) ??
    textOf(childNamed(node, 'author'), 200);

  const published = dateOf(textOf(childNamed(node, 'pubdate', 'published', 'date'), 200));
  const updated = dateOf(textOf(childNamed(node, 'updated', 'modified'), 200));

  const categories = childrenNamed(node, 'category', 'subject')
    .map((category) => attribute(category, 'term') ?? textOf(category, 120))
    .filter((value): value is string => Boolean(value))
    .slice(0, 20);

  const print = fingerprint([title, url, summary, content]);
  const { id, source } = identify(node, url, print);

  return {
    id,
    identitySource: source,
    title,
    url,
    author,
    publishedAt: published,
    updatedAt: updated ?? published,
    summary,
    content,
    categories,
    fingerprint: print,
  };
}

/** Finds the feed root and its entries, whichever of the three formats it is. */
function readDocument(xml: string, requestedUrl: string): Omit<FeedAnswer, 'notModified' | 'etag' | 'lastModified' | 'servedBy'> {
  let root: XmlElement;
  try {
    const document = parseXml(xml);
    if (!document.root) throw new Error('the document has no root element');
    root = document.root;
  } catch (error) {
    throw new UpstreamFailure('BAD_RESPONSE', `That is not XML this can read: ${(error as Error).message}`);
  }

  const name = localName(root);
  let kind: FeedKind;
  let channel: XmlElement;
  let entryNodes: XmlElement[];

  if (name === 'feed') {
    kind = 'ATOM';
    channel = root;
    entryNodes = childrenNamed(root, 'entry');
  } else if (name === 'rss') {
    kind = 'RSS';
    channel = childNamed(root, 'channel') ?? root;
    entryNodes = childrenNamed(channel, 'item');
  } else if (name === 'rdf') {
    // RSS 1.0 puts items as siblings of the channel rather than inside it.
    kind = 'RDF';
    channel = childNamed(root, 'channel') ?? root;
    entryNodes = childrenNamed(root, 'item');
  } else {
    throw new UpstreamFailure('BAD_RESPONSE', `That XML is not a feed: its root element is <${root.name}>.`);
  }

  const siteUrl = linkOf(channel, requestedUrl);
  return {
    kind,
    title: textOf(childNamed(channel, 'title'), 500),
    siteUrl,
    entries: entryNodes.map((node) => readEntry(node, siteUrl ?? requestedUrl)),
    totalEntries: entryNodes.length,
  };
}

/**
 * Decodes the body using the charset the source declared.
 *
 * The parser is UTF-8 only, and feeds in the wild are not: a windows-1252 feed
 * decoded as UTF-8 turns every curly quote into a replacement character, which
 * then travels into an agent's summary as garbage nobody can trace. The
 * declaration inside the document wins over the header, because the header is
 * frequently a server default while the declaration was written by whoever
 * generated the feed.
 */
export function decodeFeed(bytes: Uint8Array, contentType: string | null): string {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 200));
  const declared = /encoding=["']([\w-]+)["']/i.exec(head)?.[1];
  const fromHeader = contentType ? /charset=([\w-]+)/i.exec(contentType)?.[1] : undefined;
  const charset = (declared ?? fromHeader ?? 'utf-8').toLowerCase();
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    // An encoding this runtime does not know is not a reason to fail: UTF-8 is
    // right far more often than not, and a mangled accent beats no feed.
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

function feedSource(): Upstream<FeedQuery, FeedAnswer> {
  return defineUpstream<FeedQuery, FeedAnswer>({
    id: `${FEED_FAMILY}.direct`,
    family: FEED_FAMILY,
    name: 'direct',
    description: 'An RSS or Atom feed, read from wherever it is published.',
    // Not a host, because there is no one host: see the note at the top. The
    // windows below are keyed per feed host, and `servedBy` on the answer
    // carries who actually replied.
    origin: 'feeds',
    limit: {
      concurrentPerProcess: 2,
      windows: [
        // Per feed host, so a busy feed cannot spend another site's politeness.
        { ...perSecond(1, { scope: 'MACHINE' }), per: hostOf },
        { ...perMinute(20, { scope: 'MACHINE' }), per: hostOf },
      ],
    },
    timeoutMs: 20_000,
    // Short, because the point of a feed is noticing something new. The
    // conditional request is what makes frequent polling cheap, not the cache.
    freshMs: 60_000,
    rank: 1,
    cacheKey: (query) => `${query.url.toLowerCase()}:${query.etag ?? ''}:${query.lastModified ?? ''}:${query.limit}`,
    async fetch(query, ctx) {
      try {
        const response = await safeFetch(query.url, {
          signal: ctx.signal,
          headers: {
            'user-agent': USER_AGENT,
            accept: 'application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
            // Sending both is deliberate: a source may honour either, and a
            // source that honours neither simply answers 200 as before.
            ...(query.etag ? { 'if-none-match': query.etag } : {}),
            ...(query.lastModified ? { 'if-modified-since': query.lastModified } : {}),
          },
          maxBytes: MAX_FEED_BYTES,
          // Bytes, so the charset the feed declared can be honoured rather than
          // assumed. A windows-1252 feed decoded as UTF-8 is quietly corrupt.
          binary: true,
        });

        const servedBy = safeHost(response.url) ?? safeHost(query.url) ?? 'unknown';

        // The whole point of the validators. Nothing was sent, nothing is
        // parsed, and the caller keeps what it already had.
        if (response.status === 304) {
          return {
            notModified: true,
            kind: null,
            title: null,
            siteUrl: null,
            etag: query.etag,
            lastModified: query.lastModified,
            entries: [],
            totalEntries: 0,
            servedBy,
          };
        }

        const status = classifyStatus(response.status, response.headers);
        if (status) throw status;
        if (!response.bytes) throw new UpstreamFailure('BAD_RESPONSE', 'That feed answered with no body.');

        const xml = decodeFeed(response.bytes, response.headers.get('content-type'));
        const document = readDocument(xml, response.url);

        return {
          notModified: false,
          kind: document.kind,
          title: document.title,
          siteUrl: document.siteUrl,
          etag: response.headers.get('etag'),
          lastModified: response.headers.get('last-modified'),
          entries: document.entries.slice(0, query.limit),
          totalEntries: document.totalEntries,
          servedBy,
        };
      } catch (error) {
        throw classifyThrown(error);
      }
    },
  });
}

/** The host a query is aimed at, for keying its budget. */
export function hostOf(query: unknown): string | null {
  return safeHost((query as FeedQuery | undefined)?.url ?? '');
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

export function registerFeedUpstreams(): void {
  registerUpstream(feedSource());
}
