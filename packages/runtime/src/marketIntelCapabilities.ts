import { z } from 'zod';
import { defineCapability, registerCapability } from '@xbam/tools';
import {
  GECKO_FAMILY,
  JUPITER_FAMILY,
  ask,
  familyHealth,
  type GeckoQuery,
  type GeckoResult,
  type JupiterQuery,
  type JupiterResult,
  type MarketPairs,
  type MarketQuery,
  type Provenance,
} from '@xbam/upstream';

/**
 * What a trader looks at before anything else: which token a name means, how
 * a pair is trading right now, the swaps going through it, and, for a Solana
 * token, who holds it and who made it.
 *
 * ### A search finds candidates and never decides
 *
 * `market.search` takes a name, a symbol or an address and returns every
 * distinct token it matched, each with its chain and exact address, and says
 * when more than one token answers to the same symbol. It never picks one.
 * `market.resolve_exact` is still where an identity comes from; this is how a
 * person gets from "BONK" to choosing which BONK.
 *
 * ### Absent is not zero
 *
 * Every number a source did not send is null, and stays null all the way to
 * the screen, where it reads "unavailable". A holder count of zero and a
 * holder count nobody reported are different facts about a token, and only
 * one of them is alarming.
 *
 * ### Links are data
 *
 * A token's website and social links are whatever its creator typed. Only
 * `http` and `https` addresses survive, so a `javascript:` link cannot reach
 * a page as something clickable, and they are labelled as the token's own
 * links rather than as anything AI17Z vouches for.
 */

const ProvenanceOut = z.object({ source: z.string(), host: z.string(), readAt: z.string(), fellBackFrom: z.array(z.string()) });
function reported(provenance: Provenance): z.infer<typeof ProvenanceOut> {
  return { source: provenance.upstreamId, host: provenance.origin, readAt: provenance.fetchedAt, fellBackFrom: provenance.fellBackFrom };
}

/** Our chain names, and what DexScreener and GeckoTerminal each call them. Mapped, never guessed. */
const CHAINS = {
  ethereum: { dexscreener: 'ethereum', gecko: 'eth' },
  base: { dexscreener: 'base', gecko: 'base' },
  arbitrum: { dexscreener: 'arbitrum', gecko: 'arbitrum' },
  optimism: { dexscreener: 'optimism', gecko: 'optimism' },
  polygon: { dexscreener: 'polygon', gecko: 'polygon_pos' },
  bnb: { dexscreener: 'bsc', gecko: 'bsc' },
  avalanche: { dexscreener: 'avalanche', gecko: 'avax' },
  solana: { dexscreener: 'solana', gecko: 'solana' },
} as const;
type Chain = keyof typeof CHAINS;
const ChainName = z.enum(Object.keys(CHAINS) as [Chain, ...Chain[]]);
const FROM_DEXSCREENER = new Map<string, Chain>(Object.entries(CHAINS).map(([ours, ids]) => [ids.dexscreener, ours as Chain]));

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const POOL_ID = /^(0x[0-9a-fA-F]{40}|0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
const IDENTITY_REFUSAL = 'This needs an exact address. A name or symbol is not an identity.';

type Rec = Record<string, unknown>;
/** A nested object from a source's JSON, or an empty one. Never throws on a shape that moved. */
function rec(value: unknown): Rec {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : {};
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A number the source sent, or null. Never a zero standing in for nothing. */
function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}
function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
/** Only an http or https address survives, and only with a host. */
export function safeLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname ? url.toString() : null;
  } catch {
    return null;
  }
}

async function readPairs(query: MarketQuery) {
  const answer = await ask<MarketQuery, MarketPairs>('market_pairs', query);
  return { pairs: answer.value.pairs, provenance: reported(answer.provenance) };
}
async function readGecko(query: Partial<GeckoQuery> & { operation: GeckoQuery['operation'] }) {
  const answer = await ask<GeckoQuery, GeckoResult>(GECKO_FAMILY, { network: '', address: '', timeframe: 'hour', limit: 24, withTokens: false, ...query } as GeckoQuery);
  return { data: answer.value.data, provenance: reported(answer.provenance) };
}
async function readJupiter(query: Partial<JupiterQuery> & { operation: JupiterQuery['operation'] }) {
  const answer = await ask<JupiterQuery, JupiterResult>(JUPITER_FAMILY, { query: '', list: 'toptrending', interval: '1h', limit: 30, ...query } as JupiterQuery);
  return { tokens: answer.value.tokens, provenance: reported(answer.provenance) };
}

async function readable(family: string, what: string): Promise<{ status: 'AVAILABLE' | 'UNAVAILABLE'; why?: string }> {
  const health = await familyHealth(family);
  if (health.some((entry) => entry.health.state === 'READY')) return { status: 'AVAILABLE' };
  return { status: 'UNAVAILABLE', why: `${what} is not answering.` };
}

/* ------------------------------------------------------------------ pairs */

const Window = z.object({ buys: z.number().nullable(), sells: z.number().nullable(), volumeUsd: z.number().nullable(), priceChangePct: z.number().nullable() });
const Pair = z.object({
  chain: z.string(),
  /** False for a chain AI17Z does not read; shown, never acted on. */
  supported: z.boolean(),
  pairAddress: z.string(),
  dex: z.string().nullable(),
  url: z.string().nullable(),
  baseToken: z.object({ address: z.string(), name: z.string().nullable(), symbol: z.string().nullable() }),
  quoteToken: z.object({ address: z.string(), name: z.string().nullable(), symbol: z.string().nullable() }),
  priceUsd: z.number().nullable(),
  priceNative: z.string().nullable(),
  liquidityUsd: z.number().nullable(),
  fdv: z.number().nullable(),
  marketCap: z.number().nullable(),
  pairCreatedAt: z.string().nullable(),
  windows: z.object({ m5: Window, h1: Window, h6: Window, h24: Window }),
  imageUrl: z.string().nullable(),
  links: z.array(z.object({ kind: z.string(), url: z.string() })),
});
type Pair = z.infer<typeof Pair>;

export function pairFrom(raw: unknown): Pair | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = rec(raw);
  const base = rec(p.baseToken);
  const quote = rec(p.quoteToken);
  const info = rec(p.info);
  if (typeof p.pairAddress !== 'string' || typeof base.address !== 'string' || typeof quote.address !== 'string') return null;
  const chain = FROM_DEXSCREENER.get(String(p.chainId));
  const win = (key: string) => ({
    buys: num(rec(rec(p.txns)[key]).buys),
    sells: num(rec(rec(p.txns)[key]).sells),
    volumeUsd: num(rec(p.volume)[key]),
    priceChangePct: num(rec(p.priceChange)[key]),
  });
  const links: { kind: string; url: string }[] = [];
  for (const w of list(info.websites)) {
    const url = safeLink(rec(w).url);
    if (url) links.push({ kind: 'website', url });
  }
  for (const social of list(info.socials)) {
    const url = safeLink(rec(social).url);
    const type = rec(social).type;
    if (url) links.push({ kind: typeof type === 'string' ? type.slice(0, 20) : 'social', url });
  }
  const created = num(p.pairCreatedAt);
  return {
    chain: chain ?? String(p.chainId ?? 'unknown'),
    supported: chain !== undefined,
    pairAddress: p.pairAddress as string,
    dex: str(p.dexId),
    url: safeLink(p.url),
    baseToken: { address: base.address as string, name: str(base.name), symbol: str(base.symbol) },
    quoteToken: { address: quote.address as string, name: str(quote.name), symbol: str(quote.symbol) },
    priceUsd: num(p.priceUsd),
    priceNative: str(p.priceNative),
    liquidityUsd: num(rec(p.liquidity).usd),
    fdv: num(p.fdv),
    marketCap: num(p.marketCap),
    pairCreatedAt: created !== null ? new Date(created).toISOString() : null,
    windows: { m5: win('m5'), h1: win('h1'), h6: win('h6'), h24: win('h24') },
    imageUrl: safeLink(info.imageUrl),
    links: links.slice(0, 8),
  };
}

const Candidate = z.object({
  chain: z.string(),
  supported: z.boolean(),
  tokenAddress: z.string(),
  name: z.string().nullable(),
  symbol: z.string().nullable(),
  /** The deepest pair found for this token: where its price should come from. */
  pairAddress: z.string(),
  dex: z.string().nullable(),
  quoteSymbol: z.string().nullable(),
  priceUsd: z.number().nullable(),
  liquidityUsd: z.number().nullable(),
  marketCap: z.number().nullable(),
  fdv: z.number().nullable(),
  volume24hUsd: z.number().nullable(),
  pairCreatedAt: z.string().nullable(),
  pairsFound: z.number(),
});
type Candidate = z.infer<typeof Candidate>;

/**
 * The distinct tokens a set of pairs is about, deepest pair each. The side
 * of the pair that matched the query is the token; a pair matched only on
 * its quote side is about the quote token.
 */
export function pairCandidatesFrom(pairs: Pair[], query: string): { candidates: Candidate[]; ambiguous: boolean } {
  const q = query.trim().toLowerCase();
  const byToken = new Map<string, { candidate: Candidate; depth: number }>();
  for (const pair of pairs) {
    const quoteMatches =
      pair.quoteToken.address.toLowerCase() === q || pair.quoteToken.symbol?.toLowerCase() === q || pair.quoteToken.name?.toLowerCase() === q;
    const baseMatches =
      pair.baseToken.address.toLowerCase() === q || pair.baseToken.symbol?.toLowerCase() === q || pair.baseToken.name?.toLowerCase() === q;
    const token = quoteMatches && !baseMatches ? pair.quoteToken : pair.baseToken;
    const other = token === pair.baseToken ? pair.quoteToken : pair.baseToken;
    const key = `${pair.chain}:${token.address.toLowerCase()}`;
    const depth = pair.liquidityUsd ?? -1;
    const existing = byToken.get(key);
    if (existing) {
      existing.candidate.pairsFound += 1;
      if (depth <= existing.depth) continue;
    }
    byToken.set(key, {
      depth,
      candidate: {
        chain: pair.chain,
        supported: pair.supported,
        tokenAddress: token.address,
        name: token.name,
        symbol: token.symbol,
        pairAddress: pair.pairAddress,
        dex: pair.dex,
        quoteSymbol: other.symbol,
        // Only meaningful when the token is the pair's base side; a quote-side
        // match has no USD price of its own in this answer.
        priceUsd: token === pair.baseToken ? pair.priceUsd : null,
        liquidityUsd: pair.liquidityUsd,
        marketCap: token === pair.baseToken ? pair.marketCap : null,
        fdv: token === pair.baseToken ? pair.fdv : null,
        volume24hUsd: pair.windows.h24.volumeUsd,
        pairCreatedAt: pair.pairCreatedAt,
        pairsFound: (existing?.candidate.pairsFound ?? 0) + (existing ? 0 : 1),
      },
    });
  }
  const candidates = [...byToken.values()]
    .map((entry) => entry.candidate)
    .sort((a, b) => {
      const exact = (c: Candidate) => (c.symbol?.toLowerCase() === q || c.tokenAddress.toLowerCase() === q ? 0 : 1);
      return exact(a) - exact(b) || (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1);
    });
  const sameSymbol = candidates.filter((c) => c.symbol?.toLowerCase() === q).length;
  return { candidates, ambiguous: sameSymbol > 1 };
}

const search = defineCapability({
  id: 'market.search',
  name: 'Find the tokens a name, symbol or address could mean',
  description:
    'Search markets by token name, symbol, contract or mint. Returns every distinct token that matched, each with its ' +
    'chain and exact address, deepest pool first, and says when several tokens share a symbol. It never chooses one: ' +
    'pass the exact address to market.resolve_exact or market.pair_detail once a person has.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ query: z.string().trim().min(1).max(80), limit: z.number().int().min(1).max(30).default(12) }),
  output: z.object({
    query: z.string(),
    ambiguous: z.boolean(),
    candidates: z.array(Candidate),
    caveats: z.array(z.string()),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 20_000,
  readiness: () => readable('market_pairs', 'The pair index'),
  async run(input) {
    const exact = EVM_ADDRESS.test(input.query) || SOLANA_ADDRESS.test(input.query);
    const read = await readPairs(exact ? { kind: 'token', address: input.query } : { kind: 'search', symbol: input.query });
    const pairs = read.pairs.map(pairFrom).filter((p): p is Pair => p !== null);
    const { candidates, ambiguous } = pairCandidatesFrom(pairs, input.query);
    const caveats = ['A name or symbol is not an identity: check the chain and address before anything else.'];
    if (ambiguous) caveats.unshift(`Several different tokens are called ${input.query}. Choose by chain and address; the deepest is not necessarily the one meant.`);
    if (candidates.some((c) => !c.supported)) caveats.push('Some results are on chains AI17Z does not read; they are listed so the choice is visible, not to be traded.');
    return { query: input.query, ambiguous, candidates: candidates.slice(0, input.limit), caveats, provenance: read.provenance };
  },
});

const pairDetail = defineCapability({
  id: 'market.pair_detail',
  name: 'Read how one exact pair is trading now',
  description:
    'For one exact pair on one chain: price, liquidity, market cap and FDV, buys, sells, volume and price change over ' +
    'five minutes, an hour, six hours and a day, when the pair was created, and the token’s own links.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ chain: ChainName, pairAddress: z.string().trim().max(120).refine((v) => POOL_ID.test(v), IDENTITY_REFUSAL) }),
  output: z.object({ found: z.boolean(), pair: Pair.nullable(), caveats: z.array(z.string()), provenance: ProvenanceOut }),
  modelCallable: true,
  timeoutMs: 20_000,
  readiness: () => readable('market_pairs', 'The pair index'),
  async run(input) {
    const read = await readPairs({ kind: 'pair', chain: CHAINS[input.chain].dexscreener, pairAddress: input.pairAddress });
    const pair = read.pairs.map(pairFrom).find((p) => p?.pairAddress.toLowerCase() === input.pairAddress.toLowerCase()) ?? null;
    const caveats = ['Links are the token’s own and are not checked by AI17Z.', 'Prices here are the index’s, not an execution quote.'];
    if (pair && (pair.liquidityUsd ?? 0) < 10_000) caveats.unshift('This pair is thin: a small trade can move its price a long way.');
    return { found: pair !== null, pair, caveats, provenance: read.provenance };
  },
});

/* ----------------------------------------------------------------- trades */

const Trade = z.object({
  at: z.string(),
  side: z.enum(['buy', 'sell']),
  volumeUsd: z.number().nullable(),
  priceUsd: z.number().nullable(),
  tokenAmount: z.string().nullable(),
  wallet: z.string().nullable(),
  txHash: z.string(),
  block: z.number().nullable(),
});

export function tradeFrom(raw: unknown): z.infer<typeof Trade> | null {
  const a = (raw as { attributes?: Record<string, unknown> } | null)?.attributes;
  if (!a || typeof a.tx_hash !== 'string' || typeof a.block_timestamp !== 'string') return null;
  const side = a.kind === 'buy' ? 'buy' : a.kind === 'sell' ? 'sell' : null;
  if (!side) return null;
  return {
    at: a.block_timestamp,
    side,
    volumeUsd: num(a.volume_in_usd),
    // The token's price is the "to" side of a buy and the "from" side of a sell.
    priceUsd: num(side === 'buy' ? a.price_to_in_usd : a.price_from_in_usd),
    tokenAmount: str(side === 'buy' ? a.to_token_amount : a.from_token_amount),
    wallet: str(a.tx_from_address),
    txHash: a.tx_hash,
    block: num(a.block_number),
  };
}

const recentTrades = defineCapability({
  id: 'market.recent_trades',
  name: 'Read the latest swaps through one exact pool',
  description: 'The most recent buys and sells through one exact pool, newest first: when, how much, at what price, and which wallet sent it.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    chain: ChainName,
    poolAddress: z.string().trim().max(120).refine((v) => POOL_ID.test(v), IDENTITY_REFUSAL),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  output: z.object({ trades: z.array(Trade), caveats: z.array(z.string()), provenance: ProvenanceOut }),
  modelCallable: true,
  timeoutMs: 25_000,
  readiness: () => readable(GECKO_FAMILY, 'The market indexer'),
  async run(input) {
    const read = await readGecko({ operation: 'trades', network: CHAINS[input.chain].gecko, address: input.poolAddress });
    const trades = (Array.isArray(read.data) ? read.data : [])
      .map(tradeFrom)
      .filter((t): t is z.infer<typeof Trade> => t !== null)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, input.limit);
    return {
      trades,
      caveats: ['A wallet here is whoever sent the transaction, which for a routed swap may be a router rather than a person.'],
      provenance: read.provenance,
    };
  },
});

/* ---------------------------------------------------------- Solana tokens */

const Stats = z.object({
  priceChangePct: z.number().nullable(),
  buyVolumeUsd: z.number().nullable(),
  sellVolumeUsd: z.number().nullable(),
  buys: z.number().nullable(),
  sells: z.number().nullable(),
  traders: z.number().nullable(),
  netBuyers: z.number().nullable(),
  organicBuyers: z.number().nullable(),
  liquidityChangePct: z.number().nullable(),
  holderChangePct: z.number().nullable(),
});
const SolanaToken = z.object({
  mint: z.string(),
  name: z.string().nullable(),
  symbol: z.string().nullable(),
  decimals: z.number().nullable(),
  tokenProgram: z.string().nullable(),
  /** Token-2022 can carry transfer fees and hooks; said rather than left to a program id. */
  token2022: z.boolean().nullable(),
  launchpad: z.string().nullable(),
  developer: z.string().nullable(),
  firstPoolAt: z.string().nullable(),
  holderCount: z.number().nullable(),
  topHoldersPct: z.number().nullable(),
  developerHoldsPct: z.number().nullable(),
  developerLaunches: z.number().nullable(),
  developerMigrations: z.number().nullable(),
  botHoldersPct: z.number().nullable(),
  mintAuthorityDisabled: z.boolean().nullable(),
  freezeAuthorityDisabled: z.boolean().nullable(),
  /** Present only when the index flagged it; null means no flag was reported, not that it is clean. */
  flaggedByIndex: z.boolean(),
  organicScore: z.number().nullable(),
  organicLabel: z.string().nullable(),
  verified: z.boolean().nullable(),
  tags: z.array(z.string()),
  priceUsd: z.number().nullable(),
  liquidityUsd: z.number().nullable(),
  marketCap: z.number().nullable(),
  fdv: z.number().nullable(),
  stats: z.object({ m5: Stats.nullable(), h1: Stats.nullable(), h6: Stats.nullable(), h24: Stats.nullable() }),
  website: z.string().nullable(),
  twitter: z.string().nullable(),
  priceBlock: z.number().nullable(),
  updatedAt: z.string().nullable(),
});
type SolanaToken = z.infer<typeof SolanaToken>;

const TOKENKEG = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export function solanaTokenFrom(raw: unknown): SolanaToken | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = rec(raw);
  if (typeof t.id !== 'string' || !SOLANA_ADDRESS.test(t.id)) return null;
  const stat = (value: unknown) => {
    const s = rec(value);
    return Object.keys(s).length
      ? {
          priceChangePct: num(s.priceChange),
          buyVolumeUsd: num(s.buyVolume),
          sellVolumeUsd: num(s.sellVolume),
          buys: num(s.numBuys),
          sells: num(s.numSells),
          traders: num(s.numTraders),
          netBuyers: num(s.numNetBuyers),
          organicBuyers: num(s.numOrganicBuyers),
          liquidityChangePct: num(s.liquidityChange),
          holderChangePct: num(s.holderChange),
        }
      : null;
  };
  const program = str(t.tokenProgram);
  const audit = rec(t.audit);
  return {
    mint: t.id as string,
    name: str(t.name),
    symbol: str(t.symbol),
    decimals: num(t.decimals),
    tokenProgram: program,
    token2022: program ? program !== TOKENKEG : null,
    launchpad: str(t.launchpad),
    developer: str(t.dev),
    firstPoolAt: str(rec(t.firstPool).createdAt),
    holderCount: num(t.holderCount),
    topHoldersPct: num(audit.topHoldersPercentage),
    developerHoldsPct: num(audit.devBalancePercentage),
    developerLaunches: num(audit.devMints),
    developerMigrations: num(audit.devMigrations),
    botHoldersPct: num(audit.botHoldersPercentage),
    mintAuthorityDisabled: bool(audit.mintAuthorityDisabled),
    freezeAuthorityDisabled: bool(audit.freezeAuthorityDisabled),
    flaggedByIndex: audit.isSus === true,
    organicScore: num(t.organicScore),
    organicLabel: str(t.organicScoreLabel),
    verified: bool(t.isVerified),
    tags: list(t.tags).filter((x): x is string => typeof x === 'string').slice(0, 12),
    priceUsd: num(t.usdPrice),
    liquidityUsd: num(t.liquidity),
    marketCap: num(t.mcap),
    fdv: num(t.fdv),
    stats: { m5: stat(t.stats5m), h1: stat(t.stats1h), h6: stat(t.stats6h), h24: stat(t.stats24h) },
    website: safeLink(t.website),
    twitter: safeLink(t.twitter),
    priceBlock: num(t.priceBlockId),
    updatedAt: str(t.updatedAt),
  };
}

const SOLANA_CAVEATS = [
  'Holder figures, developer figures and the flag are the index’s readings, not AI17Z’s; a missing reading means it was not reported.',
  'A price here can be old for a token that has not traded lately. It is not an execution quote.',
];

const solanaProfile = defineCapability({
  id: 'token.solana_profile',
  name: 'Read what is known about one Solana token',
  description:
    'For one exact Solana mint: identity, token program, launchpad, developer and how many tokens they launched, holder ' +
    'count and concentration, mint and freeze authority, organic activity, buys and sells over several windows, and links.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ mint: z.string().trim().refine((v) => SOLANA_ADDRESS.test(v), IDENTITY_REFUSAL) }),
  output: z.object({ found: z.boolean(), token: SolanaToken.nullable(), caveats: z.array(z.string()), provenance: ProvenanceOut }),
  modelCallable: true,
  timeoutMs: 20_000,
  readiness: () => readable(JUPITER_FAMILY, 'The Solana token index'),
  async run(input) {
    const read = await readJupiter({ operation: 'search', query: input.mint });
    // A search can return similar tokens; only the exact mint is this one.
    const token = read.tokens.map(solanaTokenFrom).find((t) => t?.mint === input.mint) ?? null;
    return { found: token !== null, token, caveats: SOLANA_CAVEATS, provenance: read.provenance };
  },
});

const solanaDiscover = defineCapability({
  id: 'market.discover_solana',
  name: 'List Solana tokens that are new, trending, heavily traded or organically active',
  description:
    'Solana tokens from the token index: just launched, trending, most traded or highest organic activity over a window, ' +
    'each with holder concentration, developer history, authorities and activity. Nothing here is a recommendation.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    list: z.enum(['recent', 'trending', 'traded', 'organic']).default('trending'),
    interval: z.enum(['5m', '1h', '6h', '24h']).default('1h'),
    limit: z.number().int().min(1).max(100).default(40),
  }),
  output: z.object({ tokens: z.array(SolanaToken), caveats: z.array(z.string()), provenance: ProvenanceOut }),
  modelCallable: true,
  timeoutMs: 20_000,
  readiness: () => readable(JUPITER_FAMILY, 'The Solana token index'),
  async run(input) {
    const read =
      input.list === 'recent'
        ? await readJupiter({ operation: 'recent', limit: input.limit })
        : await readJupiter({
            operation: 'list',
            list: input.list === 'trending' ? 'toptrending' : input.list === 'traded' ? 'toptraded' : 'toporganicscore',
            interval: input.interval,
            limit: input.limit,
          });
    const tokens = read.tokens.map(solanaTokenFrom).filter((t): t is SolanaToken => t !== null);
    return {
      tokens,
      caveats: [...SOLANA_CAVEATS, 'A list of new or trending tokens is a list of what is happening, not of what is worth buying.'],
      provenance: read.provenance,
    };
  },
});

export function registerMarketIntelCapabilities(): void {
  registerCapability(search);
  registerCapability(pairDetail);
  registerCapability(recentTrades);
  registerCapability(solanaProfile);
  registerCapability(solanaDiscover);
}
