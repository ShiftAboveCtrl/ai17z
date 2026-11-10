/**
 * The text of a Bluesky post: how long it may be, and what in it is more than text.
 *
 * A post is plain text plus **facets**, which say that a span of bytes is a
 * mention, a link or a tag. Without a facet `@someone` is only letters: nobody
 * is notified and nothing is clickable. An agent that writes "@alice" and
 * silently fails to reach alice is a worse agent than one that cannot mention
 * at all, so facets are detected here and every mention is resolved to a DID
 * before it is sent.
 *
 * Spans are **UTF-8 byte** offsets, not UTF-16 units and not graphemes. That is
 * the protocol's rule and the one that goes wrong silently on any text with an
 * emoji in it, which is why it is computed in one place and tested with some.
 */

/** Bluesky's limit: 300 graphemes, and 3000 bytes of the record's text. */
export const MAX_POST_GRAPHEMES = 300;
export const MAX_POST_BYTES = 3_000;

const encoder = new TextEncoder();
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

export function graphemeCount(text: string): number {
  let count = 0;
  for (const _ of segmenter.segment(text)) count += 1;
  return count;
}

export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** Why a draft cannot be sent as it is, or null. Never shortens it. */
export function lengthProblem(text: string): string | null {
  if (text.trim().length === 0) return 'The text is empty.';
  const graphemes = graphemeCount(text);
  if (graphemes > MAX_POST_GRAPHEMES) {
    return `The text is ${graphemes} characters and Bluesky allows ${MAX_POST_GRAPHEMES}.`;
  }
  const bytes = byteLength(text);
  if (bytes > MAX_POST_BYTES) return `The text is ${bytes} bytes and Bluesky allows ${MAX_POST_BYTES}.`;
  return null;
}

export type FacetSpan =
  | { kind: 'mention'; handle: string; start: number; end: number }
  | { kind: 'link'; uri: string; start: number; end: number }
  | { kind: 'tag'; tag: string; start: number; end: number };

/** A string index (UTF-16) turned into a byte offset. */
function byteOffset(text: string, index: number): number {
  return encoder.encode(text.slice(0, index)).length;
}

const MENTION = /(^|[\s(])@([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+)/g;
const LINK = /(^|[\s(])(https?:\/\/[^\s]+)/g;
const TAG = /(^|\s)#([\p{L}\p{N}_]*[\p{L}_][\p{L}\p{N}_]*)/gu;
/** Punctuation a sentence puts after a link without it being part of the link. */
const TRAILING = /[.,;:!?'")\]]+$/;

/**
 * Finds the spans of a text that should be facets, as string indices.
 *
 * Only explicit `https://` and `http://` links are recognised. A bare
 * `example.com` is left as text: guessing that a word is a domain is how
 * "not.sure" becomes a link to somebody's website.
 */
export function detectSpans(text: string): FacetSpan[] {
  const spans: FacetSpan[] = [];

  for (const match of text.matchAll(MENTION)) {
    const lead = match[1] ?? '';
    const handle = match[2]!;
    const start = (match.index ?? 0) + lead.length;
    spans.push({ kind: 'mention', handle: handle.toLowerCase(), start, end: start + 1 + handle.length });
  }

  for (const match of text.matchAll(LINK)) {
    const lead = match[1] ?? '';
    let uri = match[2]!;
    const trimmed = uri.replace(TRAILING, '');
    uri = trimmed.length > 0 ? trimmed : uri;
    try {
      // A link that does not parse is text, not a facet the server would refuse.
      new URL(uri);
    } catch {
      continue;
    }
    const start = (match.index ?? 0) + lead.length;
    spans.push({ kind: 'link', uri, start, end: start + uri.length });
  }

  for (const match of text.matchAll(TAG)) {
    const lead = match[1] ?? '';
    const tag = match[2]!;
    if (tag.length > 64) continue;
    const start = (match.index ?? 0) + lead.length;
    spans.push({ kind: 'tag', tag, start, end: start + 1 + tag.length });
  }

  return spans.sort((a, b) => a.start - b.start);
}

export interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Array<
    | { $type: 'app.bsky.richtext.facet#mention'; did: string }
    | { $type: 'app.bsky.richtext.facet#link'; uri: string }
    | { $type: 'app.bsky.richtext.facet#tag'; tag: string }
  >;
}

/**
 * Builds the facets for a text.
 *
 * `resolveHandle` answers with a DID or null. A mention that does not resolve
 * gets no facet and stays as text: the post still goes out, and nobody is
 * "mentioned" who was not. Spans that overlap (a tag inside a link, say) keep
 * the earlier one.
 */
export async function buildFacets(
  text: string,
  resolveHandle: (handle: string) => Promise<string | null>,
): Promise<Facet[]> {
  const facets: Facet[] = [];
  let lastEnd = -1;
  for (const span of detectSpans(text)) {
    if (span.start < lastEnd) continue;
    const index = { byteStart: byteOffset(text, span.start), byteEnd: byteOffset(text, span.end) };

    if (span.kind === 'mention') {
      const did = await resolveHandle(span.handle).catch(() => null);
      if (!did) continue;
      facets.push({ index, features: [{ $type: 'app.bsky.richtext.facet#mention', did }] });
    } else if (span.kind === 'link') {
      facets.push({ index, features: [{ $type: 'app.bsky.richtext.facet#link', uri: span.uri }] });
    } else {
      facets.push({ index, features: [{ $type: 'app.bsky.richtext.facet#tag', tag: span.tag }] });
    }
    lastEnd = span.end;
  }
  return facets;
}
