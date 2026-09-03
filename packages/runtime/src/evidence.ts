/**
 * Turning what came back into something a model can be trusted with.
 *
 * A search engine returns a list of things that mention the words. That is not
 * evidence. Evidence is a claim, a place it came from, a time it was true, and
 * an honest statement of how much weight it will carry -- and the difference
 * matters most exactly when the answer is wrong, because a model handed ten
 * undifferentiated snippets will pick the confident one.
 *
 * Two rules run through everything here.
 *
 * Nothing is invented. A field the source did not supply stays null rather than
 * being guessed at, because a publication date the agent made up is worse than
 * no date: it makes stale information look current.
 *
 * Rank is recorded, never applied silently. Every ordering decision keeps the
 * reason it was made, so the trace can say why a project's own announcement
 * outranked a summary of it rather than presenting the order as natural.
 */

/** Where a piece of evidence came from, in the order we prefer to believe it. */
export type Authority = 'OFFICIAL' | 'PRIMARY' | 'REPUTABLE' | 'SECONDARY' | 'UNKNOWN';

export interface Evidence {
  /** The engine or service that produced it: "Web search", "DexScreener". */
  source: string;
  title: string;
  /** The claim itself, trimmed to something a prompt can afford. */
  snippet: string;
  url: string | null;
  /** The site, for attribution and for ranking. */
  domain: string | null;
  /** When the source says it was published. Null when it did not say. */
  publishedAt: string | null;
  /** When we read it. Always known. */
  retrievedAt: string;
  authority: Authority;
  /** What this is evidence *about*, when the plan named an entity. */
  entity: string | null;
  /** 0 to 1. How well this answers the question that was asked. */
  relevance: number;
  /** Why it ranks where it does, in words, for the trace. */
  why: string;
}

/** Ordering used everywhere: higher is believed first. */
const AUTHORITY_RANK: Record<Authority, number> = {
  OFFICIAL: 5,
  PRIMARY: 4,
  REPUTABLE: 3,
  SECONDARY: 2,
  UNKNOWN: 1,
};

/**
 * Sites whose own word is the best available on their own subject.
 *
 * Deliberately short and deliberately about *kinds* of source rather than a
 * list of publishers. A curated list of "good websites" is a list that is wrong
 * within a year and carries somebody's opinion about who is trustworthy; a rule
 * that a project's own domain is authoritative about that project is true
 * regardless of who the project is.
 */
const REPUTABLE_DOMAINS = [
  'reuters.com',
  'apnews.com',
  'bbc.co.uk',
  'bbc.com',
  'ft.com',
  'bloomberg.com',
  'wsj.com',
  'nytimes.com',
  'theguardian.com',
  'economist.com',
  'npr.org',
  'nature.com',
  'science.org',
  'arxiv.org',
  'github.com',
  'wikipedia.org',
];

/** Documentation and announcements: a project explaining itself. */
const PRIMARY_PATTERNS = [/\bdocs?\./i, /\/docs?\//i, /\bdeveloper\./i, /\/blog\/|\bblog\./i, /\/(?:announcement|newsroom|press)/i];

export function domainOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * How much weight a source gets, and why.
 *
 * `officialDomains` is what an owner configures in Advanced: the sites that are
 * authoritative for the subjects this agent talks about. Without it the ranking
 * still works, it just cannot know that a particular project's site is the
 * project's own.
 */
export function rankAuthority(
  url: string | null,
  officialDomains: readonly string[] = [],
): { authority: Authority; why: string } {
  const domain = domainOf(url);
  if (!domain) return { authority: 'UNKNOWN', why: 'no source address' };

  const official = officialDomains
    .map((d) => d.trim().toLowerCase().replace(/^www\./, ''))
    .filter(Boolean)
    .find((d) => domain === d || domain.endsWith(`.${d}`));
  if (official) return { authority: 'OFFICIAL', why: `${domain} is a source this agent is told is official` };

  const reputable = REPUTABLE_DOMAINS.find((d) => domain === d || domain.endsWith(`.${d}`));
  if (reputable) return { authority: 'REPUTABLE', why: `${domain} is an established publication` };

  if (PRIMARY_PATTERNS.some((p) => p.test(url ?? ''))) {
    return { authority: 'PRIMARY', why: `${domain} is documentation or an announcement` };
  }

  return { authority: 'SECONDARY', why: `${domain} is a secondary source` };
}

/** Words worth matching on, ignoring the ones every sentence has. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were',
  'what', 'when', 'where', 'who', 'how', 'why', 'this', 'that', 'it', 'its', 'do', 'does', 'did', 'you', 'your',
  'about', 'from', 'at', 'by', 'as', 'be', 'been', 'has', 'have', 'had', 'will', 'would', 'can', 'could',
]);

export function keywordsOf(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}$\s]/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
    ),
  );
}

/**
 * How well a result answers the question, from 0 to 1.
 *
 * Word overlap, which is crude and is meant to be: this decides ordering among
 * things already judged worth returning, and a cleverer measure here would be
 * another model call to rank the output of a search that was itself meant to
 * save a model call.
 */
export function relevanceOf(question: string, text: string): number {
  const wanted = keywordsOf(question);
  if (wanted.length === 0) return 0.5;
  const haystack = text.toLowerCase();
  const hits = wanted.filter((w) => haystack.includes(w)).length;
  return Math.min(1, hits / wanted.length);
}

/** A date the source stated, or null. Never a guess. */
export function publishedAtFrom(text: string): string | null {
  // ISO first, then the long forms search results actually carry.
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2})?/);
  if (iso) return iso[1]!;

  const months =
    'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec';
  const long = text.match(new RegExp(`\\b(${months})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'i'));
  if (long) {
    const parsed = Date.parse(`${long[1]} ${long[2]}, ${long[3]} UTC`);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  }
  const dmy = text.match(new RegExp(`\\b(\\d{1,2})\\s+(${months})\\s+(\\d{4})\\b`, 'i'));
  if (dmy) {
    const parsed = Date.parse(`${dmy[2]} ${dmy[1]}, ${dmy[3]} UTC`);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  }
  return null;
}

export interface NormaliseInput {
  source: string;
  title: string;
  snippet: string;
  url: string | null;
  question: string;
  entity?: string | null;
  officialDomains?: readonly string[];
  retrievedAt?: string;
}

/** One raw result into one piece of evidence. */
export function toEvidence(input: NormaliseInput): Evidence {
  const { authority, why } = rankAuthority(input.url, input.officialDomains ?? []);
  const snippet = input.snippet.replace(/\s+/g, ' ').trim();
  return {
    source: input.source,
    title: input.title.replace(/\s+/g, ' ').trim(),
    snippet,
    url: input.url,
    domain: domainOf(input.url),
    publishedAt: publishedAtFrom(`${input.title} ${snippet}`),
    retrievedAt: input.retrievedAt ?? new Date().toISOString(),
    authority,
    entity: input.entity ?? null,
    relevance: relevanceOf(input.question, `${input.title} ${snippet}`),
    why,
  };
}

/**
 * Order evidence, and drop what is not worth the prompt space.
 *
 * Authority first, then relevance, then recency where a date is known. An
 * undated result is not treated as old -- most search results carry no date at
 * all, and sinking every one of them would leave only the minority of pages
 * that happen to print one.
 */
export function rankEvidence(items: Evidence[], limit = 6): Evidence[] {
  const seen = new Set<string>();
  const unique = items.filter((e) => {
    const key = (e.url ?? e.title).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique
    .sort((a, b) => {
      const byAuthority = AUTHORITY_RANK[b.authority] - AUTHORITY_RANK[a.authority];
      if (byAuthority !== 0) return byAuthority;
      const byRelevance = b.relevance - a.relevance;
      if (Math.abs(byRelevance) > 0.05) return byRelevance;
      if (a.publishedAt && b.publishedAt) return a.publishedAt < b.publishedAt ? 1 : -1;
      return 0;
    })
    .slice(0, limit);
}

/**
 * Whether it is worth opening the page itself rather than trusting the blurb.
 *
 * A search result is written to make you click. When the most authoritative
 * answer is a document the agent could simply read, reading it beats quoting
 * the summary of it -- but only when the blurb is thin enough to be worth the
 * navigation, since a page load costs a browser round trip on a shared tab.
 */
export function worthOpening(evidence: Evidence): boolean {
  if (!evidence.url) return false;
  if (evidence.authority !== 'OFFICIAL' && evidence.authority !== 'PRIMARY') return false;
  if (evidence.relevance < 0.3) return false;
  return evidence.snippet.length < 400;
}
