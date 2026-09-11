import { z } from 'zod';
import { defineCapability, registerCapability } from '@xbam/tools';
import { GECKO_FAMILY, ask, familyHealth, type GeckoQuery, type GeckoResult, type Provenance } from '@xbam/upstream';

/**
 * What a token is trading at, and where.
 *
 * ### Identity first, and it is not negotiable
 *
 * A ticker is not an identity. Anybody can mint a token called USDC, and
 * somebody has -- several times, on several chains. Every capability here takes
 * **a chain and an exact contract or pool address** and refuses to resolve a
 * symbol into one. `market.resolve_exact` exists to make that refusal useful
 * rather than merely obstructive: it takes the exact address and says what it
 * is, so a conversation that started with a ticker has somewhere to go that is
 * not a guess.
 *
 * ### This extends the existing market reading rather than replacing it
 *
 * `market_pairs` already reads DexScreener, and `market.price_check` already
 * asks two sources about a price and reports disagreement rather than
 * resolving it. Nothing here duplicates either. What it adds is what a second
 * independent indexer can answer that the first cannot: which pools exist and
 * how deep they are, price history for an exact pair, and what was created
 * recently.
 *
 * ### Liquidity is the number that decides whether a price means anything
 *
 * A price from a pool with two hundred dollars in it is a number, not a market.
 * Every pool answer carries its liquidity next to its price for that reason,
 * and the thin ones are called thin rather than left for the reader to notice.
 */

const ProvenanceOut = z.object({
  source: z.string(),
  host: z.string(),
  readAt: z.string(),
  fellBackFrom: z.array(z.string()),
});

function reported(provenance: Provenance): z.infer<typeof ProvenanceOut> {
  return {
    source: provenance.upstreamId,
    host: provenance.origin,
    readAt: provenance.fetchedAt,
    fellBackFrom: provenance.fellBackFrom,
  };
}

/**
 * Their network ids, which are not ours.
 *
 * Mapped explicitly rather than lower-cased and hoped for: `eth` is not
 * `ethereum`, and a wrong network id returns somebody else's pool rather than
 * an error.
 */
const NETWORKS: Record<string, string> = {
  ethereum: 'eth',
  base: 'base',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  polygon: 'polygon_pos',
  bnb: 'bsc',
  avalanche: 'avax',
  solana: 'solana',
};

const ChainName = z.enum(Object.keys(NETWORKS) as [string, ...string[]]);

/** An address, checked. EVM hex or Solana base58 -- never a symbol. */
const IDENTITY_REFUSAL =
  'This needs an exact contract or pool address, not a name or ticker. A ticker is not an identity: anyone can ' +
  'mint a token with a given symbol, and people do — there are several tokens called USDC.';

/**
 * An address, and a refusal that explains itself.
 *
 * Written as one check rather than `min` then `regex`, because a length rule
 * fires first and answers "String must contain at least 26 character(s)" for
 * the input this exists to refuse — a ticker. The whole point is to say why a
 * symbol is not an identity, and that message has to survive the short case.
 */
const ExactAddress = z
  .string()
  .trim()
  .max(120)
  .refine((value) => /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(value), IDENTITY_REFUSAL);

/** Below this a price is arithmetic rather than a market. */
const THIN_LIQUIDITY_USD = 10_000;

async function readGecko(query: Partial<GeckoQuery> & { operation: GeckoQuery['operation'] }) {
  const answer = await ask<GeckoQuery, GeckoResult>(GECKO_FAMILY, {
    network: '',
    address: '',
    timeframe: 'hour',
    limit: 24,
    ...query,
  } as GeckoQuery);
  return { data: answer.value.data, provenance: reported(answer.provenance) };
}

async function marketReadable(): Promise<{ status: 'AVAILABLE' | 'UNAVAILABLE'; why?: string }> {
  const health = await familyHealth(GECKO_FAMILY);
  if (health.some((entry) => entry.health.state === 'READY')) return { status: 'AVAILABLE' };
  return { status: 'UNAVAILABLE', why: 'The market indexer is not answering.' };
}

/**
 * A pool, with both sides priced and neither called "the price".
 *
 * The indexer reports `base_token_price_usd`, and reading that as "the price"
 * is wrong half the time: for the WETH/USDC pool it is 2467, so asking what
 * USDC is worth and reading the first pool's price answers two and a half
 * thousand dollars. Both sides are named and priced, and when a particular
 * token was asked about, `priceUsdOfRequested` is that token's own price.
 */
const Pool = z.object({
  address: z.string(),
  name: z.string().nullable(),
  dex: z.string().nullable(),
  baseToken: z.object({ address: z.string().nullable(), priceUsd: z.string().nullable() }),
  quoteToken: z.object({ address: z.string().nullable(), priceUsd: z.string().nullable() }),
  /** The price of the token that was asked about. Null if none was. */
  priceUsdOfRequested: z.string().nullable(),
  liquidityUsd: z.string().nullable(),
  volume24hUsd: z.string().nullable(),
  /** Said rather than left for a reader to work out. */
  thin: z.boolean(),
});

/** A number the source sent as a string, kept as one. */
function text(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** Their token ids look like `eth_0xabc...`; the address is the tail. */
function addressOf(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const at = id.indexOf('_');
  return at >= 0 ? id.slice(at + 1) : id;
}

function poolFrom(entry: unknown, requested?: string): z.infer<typeof Pool> | null {
  if (!entry || typeof entry !== 'object') return null;
  const row = entry as { attributes?: Record<string, unknown>; relationships?: Record<string, unknown> };
  const a = row.attributes ?? {};
  const liquidity = text(a.reserve_in_usd);
  const links = row.relationships as
    | { dex?: { data?: { id?: unknown } }; base_token?: { data?: { id?: unknown } }; quote_token?: { data?: { id?: unknown } } }
    | undefined;

  const baseAddress = addressOf(links?.base_token?.data?.id);
  const quoteAddress = addressOf(links?.quote_token?.data?.id);
  const basePrice = text(a.base_token_price_usd);
  const quotePrice = text(a.quote_token_price_usd);

  // Matched case-insensitively: their ids are lower-cased and an address
  // somebody pastes is usually checksummed.
  const wanted = requested?.toLowerCase();
  const priceUsdOfRequested =
    wanted && baseAddress?.toLowerCase() === wanted
      ? basePrice
      : wanted && quoteAddress?.toLowerCase() === wanted
        ? quotePrice
        : null;

  return {
    address: typeof a.address === 'string' ? a.address : '',
    name: typeof a.name === 'string' ? a.name : null,
    dex: typeof links?.dex?.data?.id === 'string' ? (links.dex.data.id as string) : null,
    baseToken: { address: baseAddress, priceUsd: basePrice },
    quoteToken: { address: quoteAddress, priceUsd: quotePrice },
    priceUsdOfRequested,
    liquidityUsd: liquidity,
    volume24hUsd: text((a.volume_usd as Record<string, unknown> | undefined)?.h24),
    // Compared as a number only for the verdict; the value itself stays exact.
    thin: liquidity !== null ? Number(liquidity) < THIN_LIQUIDITY_USD : true,
  };
}

const resolveExact = defineCapability({
  id: 'market.resolve_exact',
  name: 'Say what an exact token address is, and where it trades',
  description:
    'Given a chain and an exact contract address, what that token is and the pools it trades in, deepest first. ' +
    'It will not resolve a ticker: anyone can mint a token with a given symbol, so a symbol is not an identity. ' +
    'Use it to turn an address somebody pasted into something an answer can safely be about.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ chain: ChainName, address: ExactAddress, limit: z.number().int().min(1).max(10).default(5) }),
  output: z.object({
    chain: z.string(),
    address: z.string(),
    found: z.boolean(),
    name: z.string().nullable(),
    symbol: z.string().nullable(),
    decimals: z.number().nullable(),
    totalSupply: z.string().nullable(),
    pools: z.array(Pool),
    caveats: z.array(z.string()),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 40_000,
  readiness: () => marketReadable(),
  async run(input) {
    const network = NETWORKS[input.chain]!;
    const token = await readGecko({ operation: 'token', network, address: input.address }).catch(() => null);
    if (!token) {
      return {
        chain: input.chain,
        address: input.address,
        found: false,
        name: null,
        symbol: null,
        decimals: null,
        totalSupply: null,
        pools: [],
        caveats: ['This address is not known to the market indexer, which usually means it has never traded.'],
        provenance: { source: 'none', host: '', readAt: new Date().toISOString(), fellBackFrom: [] },
      };
    }

    const attributes = (token.data as { attributes?: Record<string, unknown> } | null)?.attributes ?? {};
    const pools = await readGecko({ operation: 'token_pools', network, address: input.address }).catch(() => null);
    const list = Array.isArray(pools?.data) ? pools.data : [];
    const parsed = list
      .map((entry) => poolFrom(entry, input.address))
      .filter((pool): pool is z.infer<typeof Pool> => pool !== null && pool.address.length > 0)
      // Deepest first: the deepest pool is the one a price should come from,
      // and the shallow ones are where a misleading price comes from.
      .sort((a, b) => Number(b.liquidityUsd ?? 0) - Number(a.liquidityUsd ?? 0))
      .slice(0, input.limit);

    const caveats = [
      'This is the token at that exact address. A different token may use the same name or symbol, on this chain ' +
        'or another one.',
    ];
    if (parsed.length > 0 && parsed.every((pool) => pool.thin)) {
      caveats.push(
        'Every pool found is thin, so any price here can be moved by a small trade and should not be treated as a ' +
          'market value.',
      );
    }
    if (parsed.length === 0) caveats.push('No pools were found, so this token has no price to report.');

    return {
      chain: input.chain,
      address: input.address,
      found: true,
      name: typeof attributes.name === 'string' ? attributes.name : null,
      symbol: typeof attributes.symbol === 'string' ? attributes.symbol : null,
      decimals: typeof attributes.decimals === 'number' ? attributes.decimals : null,
      totalSupply: text(attributes.total_supply),
      pools: parsed,
      caveats,
      provenance: token.provenance,
    };
  },
});

const snapshot = defineCapability({
  id: 'market.snapshot',
  name: 'Read one exact pool',
  description:
    'The current price, liquidity and 24-hour volume of one exact pool address on one chain. ' +
    'Use when the pool is already known; use market.resolve_exact to find one from a token address.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ chain: ChainName, poolAddress: ExactAddress }),
  output: z.object({
    chain: z.string(),
    pool: Pool,
    caveats: z.array(z.string()),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 30_000,
  readiness: () => marketReadable(),
  async run(input) {
    const read = await readGecko({ operation: 'pool', network: NETWORKS[input.chain]!, address: input.poolAddress });
    const pool = poolFrom(read.data);
    if (!pool) throw new Error('That indexer answered with something that is not a pool.');

    const caveats: string[] = [];
    if (pool.thin) {
      caveats.push(
        'This pool is thin. A price from it can be moved by a small trade, and is not evidence of what the token ' +
          'is worth generally.',
      );
    }
    return { chain: input.chain, pool, caveats, provenance: read.provenance };
  },
});

const history = defineCapability({
  id: 'market.ohlcv',
  name: 'Read a pool’s recent price history',
  description:
    'Open, high, low, close and volume for one exact pool, by minute, hour or day. ' +
    'Use it for how a price has moved, not for what it is right now.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    chain: ChainName,
    poolAddress: ExactAddress,
    timeframe: z.enum(['minute', 'hour', 'day']).default('hour'),
    limit: z.number().int().min(1).max(100).default(24),
  }),
  output: z.object({
    chain: z.string(),
    poolAddress: z.string(),
    timeframe: z.string(),
    candles: z.array(
      z.object({
        at: z.string(),
        open: z.string(),
        high: z.string(),
        low: z.string(),
        close: z.string(),
        volume: z.string(),
      }),
    ),
    note: z.string(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 30_000,
  readiness: () => marketReadable(),
  async run(input) {
    const read = await readGecko({
      operation: 'ohlcv',
      network: NETWORKS[input.chain]!,
      address: input.poolAddress,
      timeframe: input.timeframe,
      limit: input.limit,
    });
    const list = (read.data as { attributes?: { ohlcv_list?: unknown[] } } | null)?.attributes?.ohlcv_list ?? [];

    return {
      chain: input.chain,
      poolAddress: input.poolAddress,
      timeframe: input.timeframe,
      candles: (Array.isArray(list) ? list : [])
        .filter((row): row is unknown[] => Array.isArray(row) && row.length >= 6)
        .map((row) => ({
          at: new Date(Number(row[0]) * 1000).toISOString(),
          open: String(row[1]),
          high: String(row[2]),
          low: String(row[3]),
          close: String(row[4]),
          volume: String(row[5]),
        })),
      note: 'This is one pool’s history, not the token’s price everywhere. A thin pool’s candles can be moved by a single trade.',
      provenance: read.provenance,
    };
  },
});

const newPools = defineCapability({
  id: 'market.new_pools',
  name: 'List pools created recently on a chain',
  description:
    'Pools that have just been created on a chain, newest first. ' +
    'Useful for seeing what is being launched — and it is where newly launched scams appear, so nothing here is ' +
    'a recommendation and every one of these is unvetted.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ chain: ChainName, limit: z.number().int().min(1).max(20).default(10) }),
  output: z.object({
    chain: z.string(),
    pools: z.array(Pool),
    caveats: z.array(z.string()),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 30_000,
  readiness: () => marketReadable(),
  async run(input) {
    const read = await readGecko({ operation: 'new_pools', network: NETWORKS[input.chain]! });
    const list = Array.isArray(read.data) ? read.data : [];
    const pools = list
      .map((entry) => poolFrom(entry))
      .filter((pool): pool is z.infer<typeof Pool> => pool !== null)
      .slice(0, input.limit);

    return {
      chain: input.chain,
      pools,
      caveats: [
        'A new pool is not a discovery. Most of these are worth nothing, some are deliberate traps, and none has ' +
          'been checked by anybody.',
        'Ask token.inspect_risk about any address here before repeating anything about it.',
      ],
      provenance: read.provenance,
    };
  },
});

const trending = defineCapability({
  id: 'market.trending',
  name: 'List pools with unusual current activity',
  description:
    'Pools the indexer currently ranks as trending, across chains. ' +
    'This is one indexer’s ranking of activity, not a judgement about any token, and attention is not quality.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ limit: z.number().int().min(1).max(20).default(10) }),
  output: z.object({
    pools: z.array(Pool),
    caveats: z.array(z.string()),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 30_000,
  readiness: () => marketReadable(),
  async run(input) {
    const read = await readGecko({ operation: 'trending' });
    const list = Array.isArray(read.data) ? read.data : [];
    return {
      pools: list
        .map((entry) => poolFrom(entry))
        .filter((pool): pool is z.infer<typeof Pool> => pool !== null)
        .slice(0, input.limit),
      caveats: [
        'Trending is one indexer’s measure of activity. It says something is being traded, not that it is worth ' +
          'trading.',
        'Attention is often manufactured. Nothing here has been checked.',
      ],
      provenance: read.provenance,
    };
  },
});

export function registerMarketCapabilities(): void {
  registerCapability(resolveExact);
  registerCapability(snapshot);
  registerCapability(history);
  registerCapability(newPools);
  registerCapability(trending);
}
