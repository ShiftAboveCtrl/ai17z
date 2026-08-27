import { sha256Hex } from '@xbam/shared';

/**
 * Cleans a corpus item without destroying its voice.
 *
 * The line to hold: scraping artifacts and boilerplate go, phrasing stays. A
 * two-word reply can carry more personality than a fifteen-paragraph
 * announcement, so nothing is dropped for being short.
 */
export function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    // Collapse the whitespace runs that scraping introduces, keep paragraphs.
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    // Trailing t.co links carry no voice and differ per post, which would
    // otherwise defeat duplicate detection.
    .replace(/https?:\/\/t\.co\/\S+/g, '')
    .replace(/\s+([.,!?;:])/g, '$1')
    .trim();
}

/** Strips leading mentions, which are addressing rather than content. */
export function stripLeadingMentions(text: string): string {
  return text.replace(/^(?:@[A-Za-z0-9_]{1,15}[\s,]*)+/, '').trim();
}

/**
 * Fingerprint for duplicate detection.
 *
 * Case, punctuation, mentions, numbers and URLs are removed so that reposted
 * announcements and campaign variants collapse together, which is exactly the
 * material that would otherwise dominate an inferred persona.
 */
export function contentFingerprint(normalized: string): string {
  const skeleton = stripLeadingMentions(normalized)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[0-9]+/g, ' ')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return sha256Hex(skeleton);
}

export interface NormalizedItem {
  normalized: string;
  fingerprint: string;
  /** Words after mentions and links are removed. Drives several scores. */
  wordCount: number;
  hasLink: boolean;
  mentionCount: number;
  hashtagCount: number;
  isAllCaps: boolean;
}

export function analyse(raw: string): NormalizedItem {
  const normalized = normalizeText(raw);
  const body = stripLeadingMentions(normalized).replace(/https?:\/\/\S+/g, ' ');
  const words = body.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  const letters = body.replace(/[^\p{L}]/gu, '');
  return {
    normalized,
    fingerprint: contentFingerprint(normalized),
    wordCount: words.length,
    hasLink: /https?:\/\/\S+/.test(normalized),
    mentionCount: (normalized.match(/@[A-Za-z0-9_]{1,15}/g) ?? []).length,
    hashtagCount: (normalized.match(/#\p{L}[\p{L}\p{N}_]*/gu) ?? []).length,
    isAllCaps: letters.length > 8 && letters === letters.toUpperCase(),
  };
}
