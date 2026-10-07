import { GECKO_FAMILY, ask, type GeckoQuery, type GeckoResult } from '@xbam/upstream';
import { TRADE_VENUES, WALLET_NETWORKS, type AssetRef, type MarketSnapshot, type TradeVenue, type WalletNetwork } from '@xbam/shared/contracts';
import { registerMarketReader, type MarketReader } from './marketData';

/**
 * Reading a public AMM pool, with no credential and nothing that can execute.
 *
 * This is the first real `MarketReader` in the repository, and it exists
 * because the venues named before it (Pons, Pump, Robinhood) all need an
 * adapter, an endpoint and an authorisation that are deliberately not here. A
 * paper trade with no readable venue is a form that always answers NO_MARKET,
 * which proves nothing about the pipeline it is supposed to be exercising.
 *
 * Nothing here reaches a wallet, a signer or a transaction. It asks a public
 * indexer what a pool looks like, which is the same thing a person does by
 * opening a web page, and it spends from the quota that upstream already
 * measured for itself.
 *
 * ### Why the deepest pool is the wrong pool
 *
 * The obvious implementation takes the token's deepest pool and reads its
 * price. Measured on 2026-10-07, the deepest pool holding WETH on Ethereum was
 * `crvUSD / WETH / CRV` at 827,039,486 USD of reserve, against the WETH/USDC
 * cluster at about 96,000,000. It is a three-asset Curve pool, and what the
 * indexer reports for it is a two-asset projection of a three-asset invariant:
 * a price that is not what a pair trade would fill at. The same trap in its
 * blunter form is already recorded for DexScreener, where the deepest UNI pair
 * reported 5,178,076 USD a token against a real 5.18.
 *
 * So the pools are read as a population. The median USD price across them is
 * what a token is worth, and the pool actually quoted is the one whose own
 * price sits closest to that median. One pool cannot move a median, and the
 * answer is still an exact single pool rather than an average of several,
 * which matters because a trade fills somewhere rather than everywhere.
 *
 * ### A pool with no fee is not priceable
 *
 * `pool_fee_percentage` is absent for exactly the pools whose pair price is a
 * projection: null on the Curve tri-crypto pool, "0.05" on the Uniswap V3
 * pool. Refusing a pool that will not say what it charges therefore does two
 * jobs, and it follows the rule the rest of this codebase already follows:
 * absent is not zero. Treating it as zero would simulate a fill better than
 * any real one, which is the one direction a simulation must never err.
 */

export const POOL_READER_ID = 'pool.geckoterminal';
export const POOL_READER_VERSION = '1';

/** The venues this reads. Pons and Pump stay distinct and stay unread here. */
export const POOL_VENUES = ['AMM_POOL_EVM', 'AMM_POOL_SOLANA'] as const satisfies readonly TradeVenue[];

/**
 * Their network ids, which are not ours.
 *
 * Only the networks both sides name. A network the indexer does not carry is
 * not quietly mapped to something that looks similar: a wrong network id
 * returns somebody else's pool rather than an error.
 */
const GECKO_NETWORKS: Partial<Record<WalletNetwork, string>> = {
  ethereum: 'eth',
  bnb: 'bsc',
  solana: 'solana',
};

/**
 * How many pools have to agree before a median means anything.
 *
 * Two is enough to notice a disagreement and not enough to resolve one, so the
 * floor is three. Below it the answer is that this reader cannot price the
 * asset, rather than a single pool's number presented as a market.
 */
export const MIN_POOLS_FOR_A_MEDIAN = 3;

/** One pool, reduced to the few things a snapshot needs. */
interface PoolView {
  address: string;
  dex: string | null;
  /** The subject's own price in USD, as the indexer stated it. */
  priceUsd: number;
  /** The counterparty token's address on the same chain. */
  counterpartyAddress: string;
  /** Subject base units are priced in the counterparty, decimal string. */
  priceInCounterparty: string;
  reserveUsd: string | null;
  quoteTokenPriceUsd: string | null;
}

async function askGecko(query: Partial<GeckoQuery> & { operation: GeckoQuery['operation'] }): Promise<GeckoResult> {
  const answer = await ask<GeckoQuery, GeckoResult>(GECKO_FAMILY, {
    network: '',
    address: '',
    timeframe: 'hour',
    limit: 24,
    withTokens: false,
    ...query,
  } as GeckoQuery);
  return answer.value;
}

/** A number the source sent as a string, kept as a string. */
function text(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** Their token ids look like `eth_0xabc...`; the address is the tail. */
function addressOf(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const at = id.indexOf('_');
  return at >= 0 ? id.slice(at + 1) : id;
}

/**
 * One pool from the indexer's payload, from the subject's point of view.
 *
 * The subject is the base token in some pools and the quote token in others
 * (`WETH / USDC` and `USDC / WETH` are both in one answer), so which of the
 * two reported prices is "ours" has to be decided per pool rather than
 * assumed. Reading the wrong one answers 2550 to what a dollar is worth.
 */
export function poolViewFor(entry: unknown, subjectAddress: string): PoolView | null {
  if (!entry || typeof entry !== 'object') return null;
  const row = entry as { attributes?: Record<string, unknown>; relationships?: Record<string, unknown> };
  const a = row.attributes ?? {};
  const links = row.relationships as
    | { dex?: { data?: { id?: unknown } }; base_token?: { data?: { id?: unknown } }; quote_token?: { data?: { id?: unknown } } }
    | undefined;

  const address = text(a.address);
  const base = addressOf(links?.base_token?.data?.id)?.toLowerCase() ?? null;
  const quote = addressOf(links?.quote_token?.data?.id)?.toLowerCase() ?? null;
  const wanted = subjectAddress.toLowerCase();
  if (address === null || base === null || quote === null) return null;

  const asBase = base === wanted;
  const asQuote = quote === wanted;
  // Neither side is the asset asked about, so this pool is somebody else's.
  // A pool where both sides are the same asset is nonsense and is dropped too.
  if (asBase === asQuote) return null;

  const priceUsd = text(asBase ? a.base_token_price_usd : a.quote_token_price_usd);
  const priceInCounterparty = text(asBase ? a.base_token_price_quote_token : a.quote_token_price_base_token);
  if (priceUsd === null || priceInCounterparty === null) return null;

  const usd = Number(priceUsd);
  // A price that is not a positive finite number cannot be a market, and
  // cannot sit in a median without moving it somewhere meaningless.
  if (!Number.isFinite(usd) || usd <= 0) return null;
  if (!/^[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$/.test(priceInCounterparty)) return null;

  return {
    address,
    dex: typeof links?.dex?.data?.id === 'string' ? links.dex.data.id : null,
    priceUsd: usd,
    counterpartyAddress: asBase ? quote : base,
    priceInCounterparty,
    reserveUsd: text(a.reserve_in_usd),
    // Whichever side the counterparty is on, this is its USD price, which is
    // what turns a reserve in dollars into one in the counterparty's units.
    quoteTokenPriceUsd: text(asBase ? a.quote_token_price_usd : a.base_token_price_usd),
  };
}

/**
 * The pools that represent the population, nearest the middle first.
 *
 * The median of an even-sized population is the lower of the two middles here
 * rather than their mean, because the result has to be a pool that exists.
 *
 * An ordering rather than one pool, because whether a pool can be quoted is
 * not known until it has been asked what it charges, and that is a request of
 * its own. Found by running the live test twice: the median landed on a pool
 * reporting no fee, and refusing the fee was refusing the whole asset rather
 * than that one pool. A pool that will not say what it charges is disqualified;
 * the next-nearest to the middle is then the representative one.
 */
export function poolsByDistanceFromMedian(pools: readonly PoolView[]): PoolView[] {
  if (pools.length === 0) return [];
  const sorted = [...pools].sort((a, b) => a.priceUsd - b.priceUsd);
  const median = sorted[Math.floor((sorted.length - 1) / 2)]!.priceUsd;
  return sorted
    .map((pool) => ({ pool, away: Math.abs(pool.priceUsd - median) }))
    // Ties broken by depth, so two pools equally near the middle are
    // separated by something rather than by whatever order they arrived in.
    .sort((a, b) => a.away - b.away || Number(b.pool.reserveUsd ?? 0) - Number(a.pool.reserveUsd ?? 0))
    .map((entry) => entry.pool);
}

/** The single representative pool, where only the choice is wanted. */
export function medianPool(pools: readonly PoolView[]): PoolView | null {
  return poolsByDistanceFromMedian(pools)[0] ?? null;
}

/**
 * How many pools are asked what they charge before giving up.
 *
 * Each one is a request. Three is enough to get past a cluster of fee-less
 * pools in the middle of a population and few enough that a token nothing can
 * quote costs four requests rather than twenty.
 */
export const MAX_FEE_CANDIDATES = 3;

/**
 * A decimal string times ten to a power, truncated, as an integer string.
 *
 * Done on the digits rather than through a float: `2550.331760764` at eighteen
 * decimals is past what a double can hold exactly, and a price that is one
 * base unit wrong is a price somebody can be arbitraged on. Truncation rather
 * than rounding, in the direction that does not flatter the trade.
 */
export function scaleToBaseUnits(decimal: string, decimals: number): string | null {
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(decimal.trim());
  if (!match) return null;
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  // Pad or cut the fraction to exactly the number of decimals wanted, so the
  // result is the integer the digits already spell.
  const scaled = `${whole}${fraction.padEnd(decimals, '0').slice(0, decimals)}`.replace(/^0+(?=[0-9])/, '');
  return /^[0-9]+$/.test(scaled) ? scaled : null;
}

/** `0.05` per cent as hundredths of a basis point, truncated. */
export function feePercentToMicroBps(percent: string): number | null {
  const value = Number(percent);
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  return Math.trunc(value * 10_000);
}

/**
 * Reserve in dollars turned into counterparty base units.
 *
 * Both numbers come from the same response, which is what makes the division
 * defensible: it is the indexer's own view of its own pool, not two sources
 * being mixed. Absent either of them, depth is absent, and the risk gate
 * already refuses a trade whose depth nobody could see.
 */
export function liquidityInCounterparty(reserveUsd: string | null, counterpartyUsd: string | null, decimals: number): string | null {
  if (reserveUsd === null || counterpartyUsd === null) return null;
  const reserve = Number(reserveUsd);
  const unit = Number(counterpartyUsd);
  if (!Number.isFinite(reserve) || !Number.isFinite(unit) || unit <= 0 || reserve < 0) return null;
  const whole = reserve / unit;
  if (!Number.isFinite(whole)) return null;
  // Through a fixed-point string rather than straight to BigInt, because the
  // quotient is a float and `BigInt` refuses one that is not an integer.
  return scaleToBaseUnits(whole.toFixed(Math.min(decimals, 18)), decimals);
}

/** What the indexer says a token is, exactly. Never guessed. */
export interface PoolTokenFacts {
  decimals: number;
  symbol?: string;
}

/**
 * The tokens that came with a pool list, by lower-cased address.
 *
 * Read out of `included` rather than asked for one at a time, because the
 * measured budget is four requests in ten seconds and it refuses rather than
 * waits: a pool list plus two token lookups plus a fee does not fit inside it.
 */
export function tokensFromIncluded(included: unknown): Map<string, PoolTokenFacts> {
  const out = new Map<string, PoolTokenFacts>();
  if (!Array.isArray(included)) return out;
  for (const entry of included) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as { type?: unknown; attributes?: Record<string, unknown> };
    if (row.type !== 'token') continue;
    const attributes = row.attributes ?? {};
    const address = typeof attributes.address === 'string' ? attributes.address.toLowerCase() : null;
    const decimals = attributes.decimals;
    if (address === null) continue;
    if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) continue;
    const symbol = typeof attributes.symbol === 'string' && attributes.symbol.trim() !== '' ? attributes.symbol.trim().slice(0, 32) : undefined;
    out.set(address, symbol === undefined ? { decimals } : { decimals, symbol });
  }
  return out;
}

/** The fee one pool charges, read from the pool itself. */
async function poolFee(network: string, poolAddress: string): Promise<number | null> {
  const answer = await askGecko({ operation: 'pool', network, address: poolAddress });
  const percent = text((answer.data as { attributes?: Record<string, unknown> } | null)?.attributes?.pool_fee_percentage);
  return percent === null ? null : feePercentToMicroBps(percent);
}

/**
 * Read one asset on one pool venue.
 *
 * Three requests at most, and the distinction the contract asks for is kept
 * throughout: `null` when the indexer answered and there is no pool worth
 * quoting, and a thrown sentence when the read itself did not happen. A
 * refusal from the indexer is the second of those, never the first, because
 * "we could not ask" recorded as "the token does not trade" is how a reader
 * becomes a reason to do something.
 */
export async function readPoolMarket(asset: AssetRef, venue: TradeVenue, quote?: AssetRef): Promise<MarketSnapshot | null> {
  const definition = TRADE_VENUES[venue];
  if (asset.kind === 'BROKER_INSTRUMENT') {
    throw new Error('A broker instrument does not trade in a public pool, so this reader cannot price it.');
  }
  if (asset.kind === 'NATIVE') {
    // The wrapped contract that stands for a native coin is a financially
    // actionable address, and this reader will not supply one from memory.
    throw new Error(
      'A native coin has no contract address of its own, and this reader will not guess which wrapped contract stands for it. Name the wrapped contract instead.',
    );
  }
  const network = GECKO_NETWORKS[asset.network];
  if (network === undefined) {
    throw new Error(`The market indexer does not carry ${WALLET_NETWORKS[asset.network].label}, so nothing there can be read.`);
  }
  if (!(definition.networks as readonly string[]).includes(asset.network)) {
    throw new Error(`${definition.label} does not execute on ${WALLET_NETWORKS[asset.network].label}.`);
  }

  // The tokens travel with the pools, in one request. See `tokensFromIncluded`.
  const answer = await askGecko({ operation: 'token_pools', network, address: asset.address, withTokens: true });
  if (!Array.isArray(answer.data)) {
    throw new Error('The market indexer answered with something that was not a list of pools.');
  }
  const tokens = tokensFromIncluded(answer.included);

  const seen = answer.data.map((entry) => poolViewFor(entry, asset.address)).filter((p): p is PoolView => p !== null);

  /*
   * Priced in what was asked for, or not priced.
   *
   * Without this the median across every pool holding the asset chose the
   * representative pool regardless of its other side, and measured live that
   * was a WETH/WBTC pool: a true price, in Bitcoin, for a trade meant to be in
   * a dollar stablecoin. Narrowing first and taking the median inside the
   * narrowed population keeps both properties, because the cross-check only
   * means anything between pools quoting the same thing anyway.
   */
  let all = seen;
  if (quote !== undefined) {
    if (quote.kind !== 'ONCHAIN') {
      throw new Error('A pool prices one contract in another, so the asset it is priced in has to be a contract too.');
    }
    if (quote.network !== asset.network) {
      throw new Error('A pool holds two assets on one chain, so these two cannot be a pair.');
    }
    const wanted = quote.address.toLowerCase();
    all = seen.filter((p) => p.counterpartyAddress === wanted);
  }

  if (all.length === 0) return null;
  /*
   * How many pools have to agree depends on what is being chosen between.
   *
   * Unpinned, the median is choosing a counterparty as well as a price, and
   * that is the choice the deepest-pool trap lives in, so it needs a
   * population: three. Pinned, the counterparty is already decided and the
   * remaining job is a sanity check between pools quoting the same thing, for
   * which one pool is a thin answer but an honest one. What stops a thin pool
   * being traded on is the mandate's own minimum depth, which the risk gate
   * applies to every snapshot and which this reader fills in truthfully.
   */
  if (quote === undefined && all.length < MIN_POOLS_FOR_A_MEDIAN) {
    // An answer, not a failure: the indexer told us what it has, and what it
    // has is too little to choose a counterparty from. Said rather than priced.
    return null;
  }

  /*
   * The nearest pool to the middle that will say what it charges.
   *
   * A pool that will not cannot be simulated without flattering the fill, so
   * it is disqualified rather than quoted with a zero. Walking outwards keeps
   * the representative choice while letting a fee-less pool sitting at the
   * median not cost the asset its price.
   */
  let chosen: PoolView | null = null;
  let fee: number | null = null;
  for (const candidate of poolsByDistanceFromMedian(all).slice(0, MAX_FEE_CANDIDATES)) {
    const charged = await poolFee(network, candidate.address);
    if (charged !== null) {
      chosen = candidate;
      fee = charged;
      break;
    }
  }
  if (chosen === null || fee === null) return null;

  /*
   * The subject's own decimals, checked rather than trusted.
   *
   * `AssetRef` carries `decimals` because an amount has to be shown to a
   * person, and its own comment says an adapter is still expected to check it
   * against the chain. Nothing did. A subject off by a factor of a million
   * mis-sizes `minOut` for every trade against it while every number in sight
   * looks plausible, and the caller supplying it is the party least able to
   * know. One extra request, cached for a minute by the upstream.
   */
  const subject = tokens.get(asset.address.toLowerCase());
  if (subject === undefined) {
    throw new Error(`The indexer did not say how many decimals ${asset.address} has, so no amount in its units can be worked out.`);
  }
  if (subject.decimals !== asset.decimals) {
    throw new Error(
      `${asset.address} has ${subject.decimals} decimals on ${WALLET_NETWORKS[asset.network].label} and was given as ${asset.decimals}, so every amount in this trade would be the wrong size.`,
    );
  }

  const counterparty = tokens.get(chosen.counterpartyAddress);
  if (counterparty === undefined) {
    throw new Error(`The indexer did not say how many decimals ${chosen.counterpartyAddress} has, so a price in its units cannot be worked out.`);
  }
  const priceBaseUnits = scaleToBaseUnits(chosen.priceInCounterparty, counterparty.decimals);
  if (priceBaseUnits === null || priceBaseUnits === '0') {
    // Below one base unit of the counterparty there is no price to quote: the
    // smallest expressible amount is zero, and a zero price is not a market.
    return null;
  }

  const snapshot: MarketSnapshot = {
    venue,
    network: asset.network,
    asset,
    quoteAsset: {
      kind: 'ONCHAIN',
      network: asset.network,
      address: chosen.counterpartyAddress,
      decimals: counterparty.decimals,
      ...(counterparty.symbol === undefined ? {} : { symbol: counterparty.symbol }),
    },
    // The indexer reports no block or slot for a pool, and inventing one would
    // make a snapshot look checkable when it is not. The contract allows null
    // for exactly this, and `freshnessOf` is what a caller has instead.
    atBlock: null,
    observedAt: new Date().toISOString(),
    priceBaseUnits,
    liquidityBase: liquidityInCounterparty(chosen.reserveUsd, chosen.quoteTokenPriceUsd, counterparty.decimals),
    feeMicroBps: fee,
    phase: definition.phase,
    // Which pool, on which dex, out of how many. A snapshot that cannot say
    // where it came from is one nobody can check afterwards.
    source: `${POOL_READER_ID} ${chosen.dex ?? 'unknown dex'} ${chosen.address} median of ${all.length}`.slice(0, 120),
  };
  return snapshot;
}

export const poolMarketReader: MarketReader = {
  id: POOL_READER_ID,
  version: POOL_READER_VERSION,
  venues: POOL_VENUES,
  read: readPoolMarket,
};

/**
 * Installed where a process starts rather than when this module is imported,
 * so a test can put its own reader on these venues without having to undo one
 * that arrived by being mentioned.
 */
export function registerPoolMarketReader(): void {
  registerMarketReader(poolMarketReader);
}
