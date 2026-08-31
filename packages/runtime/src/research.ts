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

export interface DexPair {
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
 * source wired in by default.
 *
 * The price is the *median* across pairs, not the price on the deepest one.
 * That is not fussiness: the deepest UNI pair on DexScreener is UNI/SASHIMI,
 * which reports $5,178,076 a token against a real price of $5.18. One
 * manipulated or broken pair can top the liquidity table; it cannot move a
 * median. Liquidity is summed across pairs for the same reason.
 */
export async function lookupToken(query: string, timeoutMs = 8_000): Promise<Finding | null> {
  const cleaned = query.replace(/^\$/, '');
  const isAddress = /^(?:0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(cleaned);
  // The dedicated endpoint for an address returns only that token's pairs.
  // `search` matches either side, which is how a query for a token comes back
  // with pairs where it is the quote asset and the price belongs to something
  // else entirely.
  const url = isAddress
    ? `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(cleaned)}`
    : `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(cleaned)}`;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;

    const body = (await response.json()) as { pairs?: DexPair[] };
    let pairs = (body.pairs ?? []).filter((p) => (p.liquidity?.usd ?? 0) > 0);
    if (pairs.length === 0) return null;

    const chosen = choosePair(pairs, isAddress ? null : cleaned);
    if (!chosen) return null;
    const { best, price, totalLiquidity, totalVolume, pairCount, oldest, ambiguous } = chosen;
    const name = best.baseToken?.name ?? best.baseToken?.symbol ?? cleaned;
    const symbol = best.baseToken?.symbol ? `$${best.baseToken.symbol}` : '';
    const change = best.priceChange?.h24;

    const parts = [
      `price $${formatPrice(price)}`,
      change !== undefined ? `${change > 0 ? '+' : ''}${change}% over 24h` : null,
      `liquidity ${formatUsd(totalLiquidity)} across ${pairCount} pair${pairCount === 1 ? '' : 's'}`,
      totalVolume > 0 ? `24h volume ${formatUsd(totalVolume)}` : null,
      best.fdv !== undefined ? `FDV ${formatUsd(best.fdv)}` : null,
      best.chainId ? `on ${best.chainId}` : null,
      // Age matters more than any other number for a token somebody is asking
      // about in a reply, and it is the one nobody volunteers.
      oldest ? `first pair created ${describeAge(oldest)}` : null,
      // The address, because a ticker is not an identity and somebody reading
      // the reply may want to check which token this actually was.
      best.baseToken?.address ? `contract ${best.baseToken.address}` : null,
      ambiguous > 0
        ? `${ambiguous} other token${ambiguous === 1 ? '' : 's'} use this ticker; this is the most traded one`
        : null,
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

export interface ChosenPair {
  best: DexPair;
  price: number;
  totalLiquidity: number;
  totalVolume: number;
  pairCount: number;
  oldest: number | undefined;
  /** How many other tokens share this ticker. Zero for an address lookup. */
  ambiguous: number;
}

/**
 * Picks which pair, and which price, actually answers the question.
 *
 * Two real failures shaped this, both found against the live API:
 *
 *   - The deepest UNI pair on DexScreener is UNI/SASHIMI, reporting $5,178,076
 *     a token against a real price of $5.18. One manipulated or broken pair can
 *     top the liquidity table; it cannot move a median.
 *   - A search for $WIF returns twenty different tokens using that ticker. The
 *     answer came back as an impostor with $26k of liquidity. Anyone can mint a
 *     token called anything, so a ticker is not an identity: group by contract
 *     and take the deepest group, then say how many others there were.
 *
 * `symbol` is null for an address lookup, where neither problem arises.
 */
export function choosePair(pairs: DexPair[], symbol: string | null): ChosenPair | null {
  let candidates = pairs.filter((p) => (p.liquidity?.usd ?? 0) > 0);
  if (candidates.length === 0) return null;

  let ambiguous = 0;
  if (symbol) {
    const wanted = symbol.toLowerCase().replace(/^\$/, '');
    const priced = candidates.filter((p) => p.baseToken?.symbol?.toLowerCase() === wanted);
    if (priced.length > 0) candidates = priced;

    // Anyone can mint a token called anything, so a ticker is not an identity:
    // group by contract and pick one group.
    const byAddress = new Map<string, DexPair[]>();
    for (const pair of candidates) {
      const key = pair.baseToken?.address?.toLowerCase() ?? 'unknown';
      byAddress.set(key, [...(byAddress.get(key) ?? []), pair]);
    }
    if (byAddress.size > 1) {
      ambiguous = byAddress.size - 1;
      // Ranked by traded volume rather than by claimed liquidity. Liquidity is a
      // number in a pool and can be inflated for nothing; volume is trades that
      // had to happen. A search for $UNI returned a Solana token claiming $6.6B
      // of liquidity against $3.99 of daily volume, and won on liquidity.
      candidates = [...byAddress.values()].sort(compareGroups)[0]!;
    }
  }

  // A pool nobody trades in is not price discovery. Pairs that do trade set the
  // price; if none of them do, they are all we have and the price is whatever
  // they say, which at least is not a lie about being busy.
  const traded = candidates.filter((p) => (p.volume?.h24 ?? 0) >= MIN_MEANINGFUL_VOLUME_USD);
  const pricing = traded.length > 0 ? traded : candidates;

  const withPrice = pricing
    .map((pair) => ({ pair, price: Number(pair.priceUsd) }))
    .filter((p) => Number.isFinite(p.price) && p.price > 0)
    .sort((a, b) => a.price - b.price);
  if (withPrice.length === 0) return null;

  const median = withPrice[Math.floor(withPrice.length / 2)]!;
  return {
    best: median.pair,
    price: median.price,
    totalLiquidity: candidates.reduce((sum, p) => sum + (p.liquidity?.usd ?? 0), 0),
    totalVolume: candidates.reduce((sum, p) => sum + (p.volume?.h24 ?? 0), 0),
    pairCount: candidates.length,
    oldest: candidates
      .map((p) => p.pairCreatedAt)
      .filter((t): t is number => typeof t === 'number')
      .sort((a, b) => a - b)[0],
    ambiguous,
  };
}

/**
 * Below this, a pair is not trading and its price means nothing.
 *
 * A hundred dollars a day is a very low bar deliberately: it is meant to
 * exclude pools with no activity at all, not to judge small tokens.
 */
const MIN_MEANINGFUL_VOLUME_USD = 100;

/**
 * Which of two tokens sharing a ticker is the one being asked about.
 *
 * Compared in order rather than scored, because these are unbounded numbers and
 * any weighted sum either caps one of them or lets it drown the others.
 *
 *   1. 24h volume, because it is expensive to fake: it is trades that had to
 *      happen. A Solana token claiming $6.6B of liquidity against $3.99 of
 *      daily volume beat the real Uniswap on liquidity alone.
 *   2. How many venues it trades in, because a token people hold trades in
 *      several.
 *   3. Liquidity, last, as the tie-break for when nothing has traded — which is
 *      the only case where the number that gets inflated is the best available.
 */
function compareGroups(a: DexPair[], b: DexPair[]): number {
  const sum = (pairs: DexPair[], pick: (p: DexPair) => number) => pairs.reduce((total, p) => total + pick(p), 0);

  const byVolume = sum(b, (p) => p.volume?.h24 ?? 0) - sum(a, (p) => p.volume?.h24 ?? 0);
  if (byVolume !== 0) return byVolume;

  const byVenues = b.length - a.length;
  if (byVenues !== 0) return byVenues;

  return sum(b, (p) => p.liquidity?.usd ?? 0) - sum(a, (p) => p.liquidity?.usd ?? 0);
}

/** Prices span nine orders of magnitude, so the useful precision moves. */
function formatPrice(value: number): string {
  if (value >= 1) return value.toFixed(2);
  if (value >= 0.01) return value.toFixed(4);
  return value.toPrecision(3);
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
