/**
 * Working out which token somebody meant.
 *
 * A ticker is not an identity. Anyone can mint a token called DOG on any chain,
 * and several people have; the live agent asked DexScreener about "BTC" and got
 * a Tron pair calling itself Bitcoin. Answering that question with a price is
 * not a small error, because the person reading the reply will act on it.
 *
 * So this is a resolver rather than a lookup. It takes everything the
 * conversation offers -- an address, a chain, a pair, a DexScreener link, a
 * ticker, the addresses the agent has been given -- and either identifies one
 * token or says it could not. Saying it could not is a real answer here; picking
 * the first match and presenting it as fact is the failure being prevented.
 *
 * Facts only. Every field is one the API returned, and a field it did not
 * return is absent rather than zero. What may be *said* about these numbers is
 * the persona's business and never this module's: a tool that supplies a price
 * grants no permission to predict one.
 */
import { createLogger, errorMessage } from '@xbam/shared';

const log = createLogger('token');

/** Chains DexScreener names, and the spellings people use for them. */
const CHAIN_ALIASES: Record<string, string> = {
  sol: 'solana',
  solana: 'solana',
  eth: 'ethereum',
  ethereum: 'ethereum',
  erc20: 'ethereum',
  bsc: 'bsc',
  bnb: 'bsc',
  binance: 'bsc',
  base: 'base',
  arb: 'arbitrum',
  arbitrum: 'arbitrum',
  poly: 'polygon',
  polygon: 'polygon',
  matic: 'polygon',
  avax: 'avalanche',
  avalanche: 'avalanche',
  tron: 'tron',
  trx: 'tron',
  ton: 'ton',
  sui: 'sui',
  apt: 'aptos',
  aptos: 'aptos',
  op: 'optimism',
  optimism: 'optimism',
  blast: 'blast',
  pulsechain: 'pulsechain',
};

export function normaliseChain(value: string | null | undefined): string | null {
  if (!value) return null;
  return CHAIN_ALIASES[value.trim().toLowerCase()] ?? value.trim().toLowerCase();
}

const EVM = /\b0x[a-fA-F0-9]{40}\b/;
const BASE58 = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;

/** What the text says about which token is meant. */
export interface TokenReference {
  address: string | null;
  chain: string | null;
  pairAddress: string | null;
  symbol: string | null;
  /** True when this came from a DexScreener link, which names both parts. */
  fromUrl: boolean;
}

const EMPTY: TokenReference = { address: null, chain: null, pairAddress: null, symbol: null, fromUrl: false };

/**
 * Everything the text says about which token is meant, from most specific to
 * least.
 *
 * A DexScreener link is the strongest signal there is: it names the chain and
 * the pair, and somebody who pastes one has already done the disambiguation.
 */
export function parseTokenReference(text: string): TokenReference {
  const reference: TokenReference = { ...EMPTY };
  if (!text?.trim()) return reference;

  // dexscreener.com/<chain>/<pairAddress>
  const link = text.match(/dexscreener\.com\/([a-z0-9-]+)\/([A-Za-z0-9]{20,})/i);
  if (link) {
    reference.chain = normaliseChain(link[1]!);
    reference.pairAddress = link[2]!;
    reference.fromUrl = true;
  }

  const evm = text.match(EVM);
  if (evm) reference.address = evm[0];
  else {
    // Only outside a URL: a base58 run inside a link is usually the pair.
    const withoutLinks = text.replace(/https?:\/\/\S+/g, ' ');
    const base58 = withoutLinks.match(BASE58);
    if (base58) reference.address = base58[0];
  }

  const ticker = text.match(/\$([A-Za-z][A-Za-z0-9]{1,9})\b/);
  if (ticker) reference.symbol = ticker[1]!;

  if (!reference.chain) {
    // "DOG on Solana", "the Base one", "solana $DOG"
    const named = text.match(
      /\b(?:on|chain|network)\s+([A-Za-z]{2,12})\b|\b([A-Za-z]{2,12})\s+(?:chain|network)\b/i,
    );
    const candidate = named?.[1] ?? named?.[2];
    if (candidate && CHAIN_ALIASES[candidate.toLowerCase()]) reference.chain = normaliseChain(candidate);
    else {
      const bare = Object.keys(CHAIN_ALIASES).find((alias) =>
        new RegExp(`\\b${alias}\\b`, 'i').test(text) && alias.length > 3,
      );
      if (bare) reference.chain = normaliseChain(bare);
    }
  }

  return reference;
}

/** Merge what several places said, preferring the more specific source. */
export function mergeReferences(...references: TokenReference[]): TokenReference {
  const merged: TokenReference = { ...EMPTY };
  for (const reference of references) {
    merged.address ??= reference.address;
    merged.chain ??= reference.chain;
    merged.pairAddress ??= reference.pairAddress;
    merged.symbol ??= reference.symbol;
    merged.fromUrl = merged.fromUrl || reference.fromUrl;
  }
  return merged;
}

export interface DexPairRaw {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { name?: string; symbol?: string; address?: string };
  quoteToken?: { symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  pairCreatedAt?: number;
}

/**
 * One token, as DexScreener described it.
 *
 * Every field optional and absent when unknown. A market cap reported as 0
 * because the API omitted it is a claim the agent would then make out loud.
 */
export interface TokenFacts {
  name: string;
  symbol: string;
  chain: string;
  contract: string;
  pairAddress: string | null;
  dex: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  priceChange24hPct: number | null;
  pairCreatedAt: string | null;
  pairCount: number;
  url: string | null;
  source: 'DexScreener';
  retrievedAt: string;
}

export interface TokenCandidate {
  facts: TokenFacts;
  /** Total liquidity across this contract's pairs, which is how they rank. */
  liquidityUsd: number;
}

export type ResolutionStatus = 'RESOLVED' | 'AMBIGUOUS' | 'NOT_FOUND';

export interface TokenResolution {
  status: ResolutionStatus;
  facts: TokenFacts | null;
  /** Every distinct contract that matched, best first. */
  candidates: TokenCandidate[];
  /** How this was decided, in words, for the trace and for the prompt. */
  how: string;
}

const num = (value: unknown): number | null => {
  const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

/** Group pairs by the contract they trade, because that is the identity. */
function byContract(pairs: DexPairRaw[]): Map<string, DexPairRaw[]> {
  const groups = new Map<string, DexPairRaw[]>();
  for (const pair of pairs) {
    const address = pair.baseToken?.address;
    const chain = pair.chainId;
    if (!address || !chain) continue;
    const key = `${chain}:${address.toLowerCase()}`;
    const existing = groups.get(key);
    if (existing) existing.push(pair);
    else groups.set(key, [pair]);
  }
  return groups;
}

/**
 * The price for a contract, taken as the median across its pairs.
 *
 * Not the deepest pair. The deepest UNI pair on DexScreener has been UNI/SASHIMI
 * reporting five million dollars a token against a real five dollars, and one
 * broken pair tops a liquidity table while it cannot move a median.
 */
function medianPrice(pairs: DexPairRaw[]): number | null {
  const prices = pairs.map((p) => num(p.priceUsd)).filter((p): p is number => p !== null && p > 0).sort((a, b) => a - b);
  if (prices.length === 0) return null;
  const middle = Math.floor(prices.length / 2);
  return prices.length % 2 ? prices[middle]! : (prices[middle - 1]! + prices[middle]!) / 2;
}

function factsFor(pairs: DexPairRaw[]): TokenFacts | null {
  const deepest = [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  const address = deepest?.baseToken?.address;
  const chain = deepest?.chainId;
  if (!deepest || !address || !chain) return null;

  const created = pairs
    .map((p) => p.pairCreatedAt)
    .filter((t): t is number => typeof t === 'number' && t > 0)
    .sort((a, b) => a - b)[0];

  return {
    name: deepest.baseToken?.name ?? deepest.baseToken?.symbol ?? address,
    symbol: deepest.baseToken?.symbol ?? '',
    chain,
    contract: address,
    pairAddress: deepest.pairAddress ?? null,
    dex: deepest.dexId ?? null,
    priceUsd: medianPrice(pairs),
    liquidityUsd: pairs.reduce((sum, p) => sum + (p.liquidity?.usd ?? 0), 0) || null,
    volume24hUsd: pairs.reduce((sum, p) => sum + (p.volume?.h24 ?? 0), 0) || null,
    fdvUsd: num(deepest.fdv),
    marketCapUsd: num(deepest.marketCap),
    priceChange24hPct: num(deepest.priceChange?.h24),
    pairCreatedAt: created ? new Date(created).toISOString() : null,
    pairCount: pairs.length,
    url: deepest.url ?? null,
    source: 'DexScreener',
    retrievedAt: new Date().toISOString(),
  };
}

export interface ResolveOptions {
  /**
   * Addresses this agent has been given, from its policy and persona.
   *
   * This is what turns "which DOG did they mean" into a decided question when
   * one of the candidates is the token the agent is actually about.
   */
  knownAddresses?: readonly string[];
  /** How much deeper the leader must be to win on liquidity alone. */
  dominanceRatio?: number;
}

/**
 * Choose between contracts that all answer to the same ticker.
 *
 * The order is the point, and it is deliberately not "most liquid wins":
 *
 *   1. An address, pair or chain the person actually supplied.
 *   2. A contract the agent has been given, which settles its own token.
 *   3. Liquidity, but only when the leader is far enough ahead to be an answer
 *      rather than a coin toss.
 *
 * Anything else is AMBIGUOUS, and the agent should say so or ask. Two tokens
 * within a factor of three of each other are not one token and a confident
 * price for the wrong one is worse than no price at all.
 */
export function chooseCandidate(
  candidates: TokenCandidate[],
  reference: TokenReference,
  options: ResolveOptions = {},
): TokenResolution {
  const known = new Set((options.knownAddresses ?? []).map((a) => a.toLowerCase()));
  const dominance = options.dominanceRatio ?? 3;

  if (candidates.length === 0) {
    return { status: 'NOT_FOUND', facts: null, candidates: [], how: 'nothing on DexScreener matched' };
  }

  const ranked = [...candidates].sort((a, b) => b.liquidityUsd - a.liquidityUsd);

  if (reference.address) {
    const wanted = reference.address.toLowerCase();
    const exact = ranked.find((c) => c.facts.contract.toLowerCase() === wanted);
    if (exact) return { status: 'RESOLVED', facts: exact.facts, candidates: ranked, how: 'the contract address they gave' };
  }

  if (reference.pairAddress) {
    const wanted = reference.pairAddress.toLowerCase();
    const exact = ranked.find((c) => c.facts.pairAddress?.toLowerCase() === wanted);
    if (exact) return { status: 'RESOLVED', facts: exact.facts, candidates: ranked, how: 'the pair they linked' };
  }

  const onChain = reference.chain ? ranked.filter((c) => normaliseChain(c.facts.chain) === reference.chain) : ranked;
  if (reference.chain && onChain.length === 1) {
    return { status: 'RESOLVED', facts: onChain[0]!.facts, candidates: ranked, how: `the only one on ${reference.chain}` };
  }
  if (reference.chain && onChain.length === 0) {
    return { status: 'NOT_FOUND', facts: null, candidates: ranked, how: `nothing with that ticker on ${reference.chain}` };
  }

  const mine = onChain.find((c) => known.has(c.facts.contract.toLowerCase()));
  if (mine) {
    return { status: 'RESOLVED', facts: mine.facts, candidates: ranked, how: 'the contract this agent was given' };
  }

  if (onChain.length === 1) {
    return { status: 'RESOLVED', facts: onChain[0]!.facts, candidates: ranked, how: 'the only token with that ticker' };
  }

  const [first, second] = onChain;
  if (first && second && first.liquidityUsd >= second.liquidityUsd * dominance) {
    return {
      status: 'RESOLVED',
      facts: first.facts,
      candidates: ranked,
      how: `much the most traded of ${onChain.length} tokens using that ticker`,
    };
  }

  return {
    status: 'AMBIGUOUS',
    facts: null,
    candidates: onChain,
    how: `${onChain.length} different tokens use that ticker and none is clearly the one meant`,
  };
}

/** Raw pairs into ranked candidates, one per contract. */
export function candidatesFrom(pairs: DexPairRaw[], symbol?: string | null): TokenCandidate[] {
  const wanted = symbol?.replace(/^\$/, '').toLowerCase();
  const groups = byContract(pairs.filter((p) => (p.liquidity?.usd ?? 0) > 0));

  const candidates: TokenCandidate[] = [];
  for (const group of groups.values()) {
    // A search for a ticker returns pairs where it is the *quote* asset too,
    // and the price on those belongs to something else entirely.
    if (wanted && !group.some((p) => p.baseToken?.symbol?.toLowerCase() === wanted)) continue;
    const facts = factsFor(group);
    if (!facts) continue;
    candidates.push({ facts, liquidityUsd: facts.liquidityUsd ?? 0 });
  }
  return candidates.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
}

/** Which DexScreener endpoint answers this reference. */
export function endpointFor(reference: TokenReference): string | null {
  if (reference.pairAddress && reference.chain) {
    return `https://api.dexscreener.com/latest/dex/pairs/${encodeURIComponent(reference.chain)}/${encodeURIComponent(reference.pairAddress)}`;
  }
  if (reference.address) {
    // The token endpoint returns only that contract's pairs. `search` matches
    // either side of a pair, which is how asking about a token comes back with
    // a price belonging to whatever it trades against.
    return `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(reference.address)}`;
  }
  if (reference.symbol) {
    return `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(reference.symbol)}`;
  }
  return null;
}

/** Resolve a reference against the live API. */
export async function resolveToken(
  reference: TokenReference,
  options: ResolveOptions & { timeoutMs?: number } = {},
): Promise<TokenResolution> {
  const url = endpointFor(reference);
  if (!url) {
    return { status: 'NOT_FOUND', facts: null, candidates: [], how: 'nothing in the message identified a token' };
  }

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      return { status: 'NOT_FOUND', facts: null, candidates: [], how: `DexScreener answered ${response.status}` };
    }
    const body = (await response.json()) as { pairs?: DexPairRaw[] | null };
    const candidates = candidatesFrom(body.pairs ?? [], reference.address ? null : reference.symbol);
    return chooseCandidate(candidates, reference, options);
  } catch (error) {
    log.debug('token resolution failed', { message: errorMessage(error) });
    return { status: 'NOT_FOUND', facts: null, candidates: [], how: 'DexScreener could not be reached' };
  }
}

const usd = (value: number | null): string | null => {
  if (value === null) return null;
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
};

const price = (value: number | null): string | null => {
  if (value === null) return null;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toPrecision(3)}`;
};

/**
 * The facts as a sentence, for the prompt.
 *
 * Only fields that came back. An absent market cap is not written as zero and
 * not written at all, because the model will repeat whatever is here.
 */
export function describeToken(resolution: TokenResolution): string {
  if (resolution.status === 'AMBIGUOUS') {
    const list = resolution.candidates
      .slice(0, 4)
      .map((c) => `${c.facts.symbol || c.facts.name} on ${c.facts.chain} (${c.facts.contract})`)
      .join('; ');
    return `Could not tell which token was meant. ${resolution.how}: ${list}.`;
  }
  const f = resolution.facts;
  if (!f) return resolution.how;

  const parts = [
    price(f.priceUsd) ? `price ${price(f.priceUsd)}` : null,
    f.priceChange24hPct !== null ? `${f.priceChange24hPct > 0 ? '+' : ''}${f.priceChange24hPct}% over 24h` : null,
    usd(f.liquidityUsd) ? `liquidity ${usd(f.liquidityUsd)} across ${f.pairCount} pair${f.pairCount === 1 ? '' : 's'}` : null,
    usd(f.volume24hUsd) ? `24h volume ${usd(f.volume24hUsd)}` : null,
    usd(f.marketCapUsd) ? `market cap ${usd(f.marketCapUsd)}` : usd(f.fdvUsd) ? `FDV ${usd(f.fdvUsd)}` : null,
    `on ${f.chain}`,
    f.pairCreatedAt ? `first pair ${describeAge(f.pairCreatedAt)}` : null,
    `contract ${f.contract}`,
    resolution.candidates.length > 1 ? `chosen as ${resolution.how}` : null,
  ].filter(Boolean);

  return `${f.name}${f.symbol ? ` $${f.symbol}` : ''}: ${parts.join(', ')}.`;
}

function describeAge(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return 'recently';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}
