import { createLogger, errorMessage } from '@xbam/shared';

const log = createLogger('research');

/**
 * Looking things up, so an agent asked about this morning is not limited to
 * whatever its model was trained on.
 *
 * "Hey, what is this about?" under a post from an hour ago is unanswerable from
 * a training set, and a model that answers it anyway invents something. The
 * options were to stay silent or to guess; this is the third one.
 *
 * Two sources, chosen because they cover what actually gets asked:
 *
 *   - the open web, read through the browser that is already running
 *   - DexScreener, for a contract address or a ticker, because it is free,
 *     needs no key, and is the specific question that comes up most
 *
 * What comes back is quoted as *what a source said*, never as something the
 * agent knows. A search result is evidence with a name on it, and the prompt
 * says so, because an agent that launders a search result into its own voice is
 * an agent that will state a wrong one just as confidently.
 */

export type LookupKind = 'search' | 'token' | 'link';

export interface Lookup {
  kind: LookupKind;
  query: string;
  /** Why this was worth looking up, shown in the trace. */
  reason: string;
}

export interface Finding {
  kind: LookupKind;
  query: string;
  /** Where this came from, named so the prompt can attribute it. */
  source: string;
  title: string;
  summary: string;
  url: string | null;
  retrievedAt: string;
}

export interface ResearchResult {
  findings: Finding[];
  /** Lookups that were attempted and failed, so a gap is visible not silent. */
  failed: { query: string; reason: string }[];
  /** Said in words for the trace. */
  note: string;
}

// ── Deciding what, if anything, is worth looking up ──────────────────────────

/** An EVM contract address. */
const EVM_ADDRESS = /\b0x[a-fA-F0-9]{40}\b/g;
/**
 * A Solana address. Base58, so no 0, O, I or l, and long enough not to match
 * an ordinary word — 32 is the shortest a real one gets.
 */
const SOLANA_ADDRESS = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const TICKER = /\$([A-Za-z][A-Za-z0-9]{1,9})\b/g;

/**
 * Phrases that mean "I am asking about something you cannot know".
 *
 * Deliberately about the *shape* of the question rather than its subject: an
 * agent should look things up when it is being asked to, not when a keyword
 * list happens to fire.
 */
const ASKS_ABOUT_SOMETHING = [
  /\bwhat(?:'s| is| are| was| were)\b.{0,40}\b(?:this|that|it|going on|happening|about)\b/i,
  /\bwho(?:'s| is| are)\b/i,
  /\bany (?:news|update|info|information)\b/i,
  /\bwhat happened\b/i,
  /\bexplain\b/i,
  /\bcontext\b/i,
  /\bthoughts on\b/i,
  /\bis (?:this|it) (?:real|true|legit|a scam)\b/i,
];

/** Words that mean the answer changes by the day. */
const TIME_SENSITIVE = [
  /\b(?:today|tonight|this (?:morning|week|month)|just now|breaking|latest|current|right now|recently)\b/i,
  /\b(?:price|pump|dump|listing|airdrop|launch|hack|exploit|outage|announcement)\b/i,
];

export interface ResearchSubject {
  /** What the person said to the agent. */
  incoming: string;
  /** The post they were replying to, when there is one. */
  parent?: string | null;
  /** Links found on either. */
  links?: string[];
  /** Whether anything on the branch had an image nobody could read. */
  hasUnreadMedia?: boolean;
}

/**
 * What to look up, and why.
 *
 * Returns nothing for the ordinary case, which is most of them: an agent that
 * searches the web before every reply is slow, expensive, and no better at
 * answering "nice one".
 */
export function whatToResearch(subject: ResearchSubject, max = 3): Lookup[] {
  const lookups: Lookup[] = [];
  const haystack = `${subject.incoming}\n${subject.parent ?? ''}`;
  const seen = new Set<string>();

  const add = (lookup: Lookup) => {
    const key = `${lookup.kind}:${lookup.query.toLowerCase()}`;
    if (seen.has(key) || lookups.length >= max) return;
    seen.add(key);
    lookups.push(lookup);
  };

  // A contract address is unambiguous and cheap to resolve, so it goes first
  // whatever else the message says.
  for (const match of haystack.matchAll(EVM_ADDRESS)) {
    add({ kind: 'token', query: match[0], reason: 'A contract address was mentioned.' });
  }
  for (const match of haystack.matchAll(SOLANA_ADDRESS)) {
    // Skip anything that is really a URL fragment or a status id.
    if (/^\d+$/.test(match[0])) continue;
    add({ kind: 'token', query: match[0], reason: 'A contract address was mentioned.' });
  }
  for (const match of haystack.matchAll(TICKER)) {
    add({ kind: 'token', query: match[1]!, reason: `A ticker ($${match[1]}) was mentioned.` });
  }

  const asking = ASKS_ABOUT_SOMETHING.some((re) => re.test(subject.incoming));
  const timeSensitive = TIME_SENSITIVE.some((re) => re.test(haystack));

  // A link somebody is asking about is the most direct answer available.
  if (asking) {
    for (const link of subject.links ?? []) {
      add({ kind: 'link', query: link, reason: 'They asked about a link on the post.' });
    }
  }

  if (asking || timeSensitive) {
    // Search for what the conversation is about, not for the question itself:
    // "what is this about" is a useless query, and the parent is the subject.
    const subjectText = (subject.parent ?? subject.incoming)
      .replace(/@[A-Za-z0-9_]{1,15}/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (subjectText.split(' ').filter(Boolean).length >= 3) {
      add({
        kind: 'search',
        query: subjectText.slice(0, 200),
        reason: asking
          ? 'They asked what this is about, and the answer is not in the post.'
          : 'The subject changes by the day, so a trained answer would be out of date.',
      });
    }
  }

  return lookups;
}

// ── DexScreener ──────────────────────────────────────────────────────────────

interface DexPair {
  chainId?: string;
  dexId?: string;
  url?: string;
  baseToken?: { name?: string; symbol?: string; address?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  fdv?: number;
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  pairCreatedAt?: number;
}

function formatUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return 'unknown';
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(2)}`;
}

/**
 * Looks a token up on DexScreener.
 *
 * No key, no account, no configuration — which is why it is the one market
 * source wired in by default. The most liquid pair is the one reported: a token
 * with fifty pairs has one that matters and forty-nine that are noise.
 */
export async function lookupToken(query: string, timeoutMs = 8_000): Promise<Finding | null> {
  const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;

    const body = (await response.json()) as { pairs?: DexPair[] };
    const pairs = (body.pairs ?? []).filter((p) => (p.liquidity?.usd ?? 0) > 0);
    if (pairs.length === 0) return null;

    const best = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]!;
    const name = best.baseToken?.name ?? best.baseToken?.symbol ?? query;
    const symbol = best.baseToken?.symbol ? `$${best.baseToken.symbol}` : '';
    const change = best.priceChange?.h24;

    const parts = [
      best.priceUsd ? `price $${best.priceUsd}` : null,
      change !== undefined ? `${change > 0 ? '+' : ''}${change}% over 24h` : null,
      `liquidity ${formatUsd(best.liquidity?.usd)}`,
      best.volume?.h24 !== undefined ? `24h volume ${formatUsd(best.volume.h24)}` : null,
      best.fdv !== undefined ? `FDV ${formatUsd(best.fdv)}` : null,
      best.chainId ? `on ${best.chainId}` : null,
      // Age matters more than any other number for a token somebody is asking
      // about in a reply, and it is the one nobody volunteers.
      best.pairCreatedAt ? `pair created ${describeAge(best.pairCreatedAt)}` : null,
    ].filter(Boolean);

    return {
      kind: 'token',
      query,
      source: 'DexScreener',
      title: `${name} ${symbol}`.trim(),
      summary: parts.join(', '),
      url: best.url ?? null,
      retrievedAt: new Date().toISOString(),
    };
  } catch (error) {
    log.debug('token lookup failed', { query, message: errorMessage(error) });
    return null;
  }
}

function describeAge(createdAtMs: number): string {
  const days = Math.floor((Date.now() - createdAtMs) / 86_400_000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

// ── Putting it together ──────────────────────────────────────────────────────

/** Supplied by the caller, because searching needs a browser and this is pure. */
export type SearchFn = (query: string) => Promise<Finding[]>;

export async function research(
  lookups: Lookup[],
  options: { search?: SearchFn } = {},
): Promise<ResearchResult> {
  const findings: Finding[] = [];
  const failed: { query: string; reason: string }[] = [];

  for (const lookup of lookups) {
    if (lookup.kind === 'token') {
      const found = await lookupToken(lookup.query);
      if (found) findings.push(found);
      else failed.push({ query: lookup.query, reason: 'No liquid pair found for that token.' });
      continue;
    }

    if (!options.search) {
      failed.push({ query: lookup.query, reason: 'No browser was available to search with.' });
      continue;
    }
    try {
      const results = await options.search(lookup.query);
      if (results.length > 0) findings.push(...results);
      else failed.push({ query: lookup.query, reason: 'The search returned nothing usable.' });
    } catch (error) {
      failed.push({ query: lookup.query, reason: errorMessage(error) });
    }
  }

  const note =
    findings.length > 0
      ? `Looked up ${findings.length} thing${findings.length === 1 ? '' : 's'}${failed.length > 0 ? `, ${failed.length} failed` : ''}.`
      : failed.length > 0
        ? `Tried to look up ${failed.length} thing${failed.length === 1 ? '' : 's'} and could not.`
        : 'Nothing needed looking up.';

  return { findings, failed, note };
}

/**
 * How findings are put to the model.
 *
 * Attributed, dated, and framed as something a source said rather than as
 * something the agent knows. An agent that launders a search result into its
 * own voice will state a wrong one just as confidently as a right one.
 */
export function renderResearch(result: ResearchResult): string {
  if (result.findings.length === 0 && result.failed.length === 0) return '';

  const lines: string[] = [];
  for (const finding of result.findings) {
    lines.push(`${finding.source} — ${finding.title}`);
    if (finding.summary) lines.push(`  ${finding.summary}`);
    if (finding.url) lines.push(`  ${finding.url}`);
  }

  if (result.failed.length > 0) {
    lines.push('');
    lines.push(
      `Could not check: ${result.failed.map((f) => f.query.slice(0, 60)).join('; ')}. Say you do not know rather than guessing.`,
    );
  }

  lines.push('');
  lines.push(
    'This was looked up just now and is not something you knew. Use it if it answers the question, ' +
      'say where it came from if the number matters, and do not repeat any of it as your own knowledge.',
  );
  return lines.join('\n');
}
