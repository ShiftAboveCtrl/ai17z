import { query } from '@xbam/database';
import type { EvidenceMoveWindow } from '@xbam/shared/contracts';
import { MOVE_SIZE_BANDS, safeShortAddress, type MoveFigure, type MoveReport } from '@xbam/prompts';
import { GECKO_FAMILY, ask, type GeckoQuery, type GeckoResult, type MarketPairs, type MarketQuery } from '@xbam/upstream';
import { marketChainNames, pairFrom, tradeFrom } from './marketIntelCapabilities';

/**
 * What changed over a window, read and not explained.
 *
 * Every figure is "then, now, change", each with its own source and time. A
 * "then" is either an earlier reading this installation stored for the same
 * pool from the same source, or plain arithmetic on the source's own longer
 * window (said so on the line). When neither exists there is no "then" and no
 * change: a missing earlier reading is never a zero and never 0%.
 *
 * The pool is the one nearest the median price among the mint's pools, never the
 * deepest, for the reason `poolMarketReader.ts` gives: one broken deep pair can
 * report anything. Nothing here is a model call and nothing here says why.
 */

type Pair = NonNullable<ReturnType<typeof pairFrom>>;
type Trade = NonNullable<ReturnType<typeof tradeFrom>>;

export const WINDOW_MS: Record<EvidenceMoveWindow, number> = { '5m': 300_000, '1h': 3_600_000, '6h': 21_600_000, '24h': 86_400_000 };
const WINDOW_KEY = { '5m': 'm5', '1h': 'h1', '6h': 'h6', '24h': 'h24' } as const;
/** The next longer window the source reports, and how many of the shorter one it holds. */
const LONGER: Record<EvidenceMoveWindow, { window: 'h1' | 'h6' | 'h24'; ratio: number; label: string } | null> = {
  '5m': { window: 'h1', ratio: 12, label: '1h' }, '1h': { window: 'h6', ratio: 6, label: '6h' },
  '6h': { window: 'h24', ratio: 4, label: '24h' }, '24h': null,
};
/** A stored reading is a "then" only when it is about a window old: within these multiples of it. */
const EARLIER_MIN = 0.8;
const EARLIER_MAX = 1.25;
/** Readings are current for the same five minutes the single card allows. */
export const MOVE_MAX_AGE_MS = 5 * 60_000;
const TRADES_ASKED = 100;
/** A dex name is shown only when it is a plain id; anything else is omitted rather than echoed. */
const PLAIN_ID = /^[a-z0-9_-]{1,24}$/i;
/** A name that would read as a story is never printed, whatever the source called its dex. */
const STORY_WORDS = /pump|dump|whale|manip|moon|rug/i;

export interface EarlierRead {
  readAt: string; poolAddress: string; source: string;
  liquidityUsd: number | null; volume: Record<'m5' | 'h1' | 'h6' | 'h24', number | null>;
}

export interface MoveInputs {
  window: EvidenceMoveWindow; chain: string; address: string;
  pairs: Pair[]; pairsSource: string; pairsFetchedAt: string;
  /** Null when the swap read failed or was not allowed: sizes then say unavailable. */
  trades: Trade[] | null; tradesSource: string | null; tradesFetchedAt: string | null;
  earlier: EarlierRead | null;
  now: Date;
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function dexLabel(dex: string | null): string | null {
  return dex && PLAIN_ID.test(dex) && !STORY_WORDS.test(dex) ? dex : null;
}

/** The pool nearest the median price among pools that price this mint as their base. Ties go to the deeper pool. */
export function medianPriced(pools: readonly Pair[]): Pair | null {
  const priced = pools.filter(p => typeof p.priceUsd === 'number' && p.priceUsd > 0);
  if (priced.length === 0) return null;
  const sorted = [...priced].sort((a, b) => a.priceUsd! - b.priceUsd!);
  const median = sorted[Math.floor((sorted.length - 1) / 2)]!.priceUsd!;
  return sorted.map(pool => ({ pool, away: Math.abs(pool.priceUsd! - median) }))
    .sort((a, b) => a.away - b.away || (b.pool.liquidityUsd ?? -1) - (a.pool.liquidityUsd ?? -1))[0]!.pool;
}

function change(then: number | null, now: number | null): number | null {
  return then !== null && now !== null && Number.isFinite(then) && Number.isFinite(now) && then > 0 ? ((now - then) / then) * 100 : null;
}

/** Average of the windows before this one, from the source's own longer window: (long - this) / (ratio - 1). Null when either is absent. */
function baseline(window: EvidenceMoveWindow, pair: Pair, pick: (w: Pair['windows']['h1']) => number | null): { value: number; label: string } | null {
  const longer = LONGER[window];
  if (!longer) return null;
  const now = pick(pair.windows[WINDOW_KEY[window]]);
  const long = pick(pair.windows[longer.window]);
  if (now === null || long === null || long < now) return null;
  return { value: (long - now) / (longer.ratio - 1), label: `the average of the earlier windows, from the source's ${longer.label} and ${window} figures` };
}

export function buildMoveReport(input: MoveInputs): MoveReport {
  const { window, chain, address } = input;
  const names = { short: safeShortAddress(address) };
  const mine = input.pairs.filter(p => p.supported && (sameAddress(p.baseToken.address, address) || sameAddress(p.quoteToken.address, address)));
  const asBase = mine.filter(p => sameAddress(p.baseToken.address, address));
  const pool = medianPriced(asBase);
  const startMs = input.now.getTime() - WINDOW_MS[window];

  const newItems = mine.flatMap(p => {
    const created = Date.parse(p.pairCreatedAt ?? '');
    return Number.isFinite(created) && created >= startMs && created <= input.now.getTime() + 30_000
      ? [{ short: safeShortAddress(p.pairAddress), dex: dexLabel(p.dex), createdAt: new Date(created).toISOString() }] : [];
  });
  const newPools: MoveReport['newPools'] = mine.length === 0 ? null : {
    count: newItems.length, untimed: mine.filter(p => !Number.isFinite(Date.parse(p.pairCreatedAt ?? ''))).length,
    pools: mine.length, items: newItems.slice(0, 3), source: input.pairsSource, fetchedAt: input.pairsFetchedAt,
  };

  if (!pool) {
    return { window, chain, ...names, pool: null, figures: [], sizeBands: null, newPools, fetchedAt: mine.length ? input.pairsFetchedAt : null };
  }

  const key = WINDOW_KEY[window];
  const w = pool.windows[key];
  const earlier = input.earlier && input.earlier.poolAddress === pool.pairAddress && input.earlier.source === input.pairsSource ? input.earlier : null;
  const figures: MoveFigure[] = [];

  // Price: the source's own change figure over the window gives the earlier price; no stored reading is needed.
  const pct = w.priceChangePct;
  const priceThen = pct !== null && pct > -100 && pool.priceUsd !== null ? pool.priceUsd / (1 + pct / 100) : null;
  figures.push({ label: 'Price', unit: 'USD', then: priceThen, now: pool.priceUsd,
    thenFrom: priceThen === null ? null : `derived from the source's own ${window} change figure`,
    changePct: priceThen === null ? null : pct, source: input.pairsSource, nowAt: input.pairsFetchedAt });

  const volBase = earlier?.volume[key] != null ? null : baseline(window, pool, x => x.volumeUsd);
  const volThen = earlier?.volume[key] ?? volBase?.value ?? null;
  figures.push({ label: `Volume ${window}`, unit: 'USD', then: volThen, now: w.volumeUsd,
    thenFrom: earlier?.volume[key] != null ? `an earlier reading at ${earlier.readAt}` : volBase?.label ?? null,
    changePct: change(volThen, w.volumeUsd), source: input.pairsSource, nowAt: input.pairsFetchedAt });

  const count = (x: Pair['windows']['h1']) => (x.buys !== null && x.sells !== null ? x.buys + x.sells : null);
  const tradesBase = baseline(window, pool, count);
  const tradesNow = count(w);
  figures.push({ label: `Trades ${window}`, unit: 'trades', then: tradesBase?.value ?? null, now: tradesNow,
    thenFrom: tradesBase?.label ?? null, changePct: change(tradesBase?.value ?? null, tradesNow), source: input.pairsSource, nowAt: input.pairsFetchedAt });

  const liqThen = earlier?.liquidityUsd ?? null;
  figures.push({ label: 'Liquidity', unit: 'USD', then: liqThen, now: pool.liquidityUsd,
    thenFrom: liqThen === null || !earlier ? null : `an earlier reading at ${earlier.readAt}`,
    changePct: change(liqThen, pool.liquidityUsd), source: input.pairsSource, nowAt: input.pairsFetchedAt });

  let sizeBands: MoveReport['sizeBands'] = null;
  if (input.trades && input.tradesSource && input.tradesFetchedAt) {
    const inWindow = input.trades.filter(t => Date.parse(t.at) >= startMs);
    const oldest = input.trades.reduce((min, t) => Math.min(min, Date.parse(t.at)), Infinity);
    const bands = { small: 0, mid: 0, large: 0, unsized: 0 };
    for (const t of inWindow) {
      if (t.volumeUsd === null) bands.unsized += 1;
      else if (t.volumeUsd < MOVE_SIZE_BANDS.smallBelow) bands.small += 1;
      else if (t.volumeUsd < MOVE_SIZE_BANDS.largeFrom) bands.mid += 1;
      else bands.large += 1;
    }
    sizeBands = { ...bands, swaps: inWindow.length, source: input.tradesSource, fetchedAt: input.tradesFetchedAt,
      coversWindow: input.trades.length < TRADES_ASKED || oldest <= startMs };
  }

  return { window, chain, ...names, fetchedAt: input.pairsFetchedAt, newPools, sizeBands, figures,
    pool: { short: safeShortAddress(pool.pairAddress), dex: dexLabel(pool.dex), pools: asBase.filter(p => p.priceUsd !== null && p.priceUsd > 0).length, liquidityUsd: pool.liquidityUsd } };
}

/** Whether the readings behind a report are all still inside their age. A report with none is never current. */
export function moveCurrent(report: MoveReport, now = Date.now()): boolean {
  const stamps = [report.fetchedAt, report.sizeBands?.fetchedAt ?? null].filter((t): t is string => t !== null);
  return stamps.length > 0 && stamps.every(t => { const at = Date.parse(t); return Number.isFinite(at) && now - at <= MOVE_MAX_AGE_MS && at <= now + 30_000; });
}

async function earlierRead(chain: string, address: string, window: EvidenceMoveWindow, now: Date): Promise<EarlierRead | null> {
  const span = WINDOW_MS[window];
  const rows = await query(`SELECT read_at, pool_address, source, liquidity_usd, volume_m5, volume_h1, volume_h6, volume_h24
    FROM mint_window_reads WHERE chain=$1 AND address=$2 AND read_at BETWEEN $3 AND $4
    ORDER BY abs(extract(epoch FROM ($5::timestamptz - read_at)) * 1000 - $6::float8) LIMIT 1`,
  [chain, address, new Date(now.getTime() - span * EARLIER_MAX), new Date(now.getTime() - span * EARLIER_MIN), now, span]);
  const row = rows[0];
  if (!row) return null;
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return { readAt: new Date(row.read_at as string).toISOString(), poolAddress: row.pool_address as string, source: row.source as string,
    liquidityUsd: n(row.liquidity_usd), volume: { m5: n(row.volume_m5), h1: n(row.volume_h1), h6: n(row.volume_h6), h24: n(row.volume_h24) } };
}

export interface MoveRead {
  report: MoveReport | null;
  /** Upstream requests made, which is what the asker and mint caps count. */
  reads: number;
  /** A sentence when no report could be made. */
  failure: string | null;
}

/**
 * Reads the pools of one exact mint and, when allowed, the latest swaps through
 * the chosen pool, then stores what was read so a later ask can say "then".
 * Two requests at most. `tradesAllowed` is the owner's permission for the swap
 * read; without it the sizes say unavailable and the rest still renders.
 */
export async function readMintWindow(input: { chain: string; address: string; window: EvidenceMoveWindow; tradesAllowed: boolean; now?: Date }): Promise<MoveRead> {
  const names = marketChainNames(input.chain);
  if (!names) return { report: null, reads: 0, failure: 'Market windows are not read for this chain, so there is nothing to compare.' };
  const now = input.now ?? new Date();
  let reads = 1;
  let pairs: Pair[];
  let pairsSource: string;
  let pairsFetchedAt: string;
  try {
    const answer = await ask<MarketQuery, MarketPairs>('market_pairs', { kind: 'token', address: input.address });
    pairs = answer.value.pairs.map(pairFrom).filter((p): p is Pair => p !== null && p.chain === input.chain);
    pairsSource = answer.provenance.upstreamId;
    pairsFetchedAt = answer.provenance.fetchedAt;
  } catch {
    return { report: null, reads, failure: 'The pair index did not answer. This is not a verdict, no reading was made.' };
  }
  const pool = medianPriced(pairs.filter(p => sameAddress(p.baseToken.address, input.address)));
  let trades: Trade[] | null = null;
  let tradesSource: string | null = null;
  let tradesFetchedAt: string | null = null;
  if (pool && input.tradesAllowed) {
    reads += 1;
    try {
      const answer = await ask<GeckoQuery, GeckoResult>(GECKO_FAMILY, { operation: 'trades', network: names.gecko, address: pool.pairAddress,
        timeframe: 'hour', limit: TRADES_ASKED, withTokens: false });
      // The source answers with up to 300 swaps, newest first by its own order; take the newest hundred by time.
      trades = (Array.isArray(answer.value.data) ? answer.value.data : []).map(tradeFrom).filter((t): t is Trade => t !== null)
        .sort((a, b) => b.at.localeCompare(a.at)).slice(0, TRADES_ASKED);
      tradesSource = answer.provenance.upstreamId;
      tradesFetchedAt = answer.provenance.fetchedAt;
    } catch {
      trades = null;
    }
  }
  const earlier = await earlierRead(input.chain, input.address, input.window, now);
  const report = buildMoveReport({ window: input.window, chain: input.chain, address: input.address, pairs, pairsSource, pairsFetchedAt,
    trades, tradesSource, tradesFetchedAt, earlier, now });
  if (pool) {
    const v = pool.windows;
    await query(`INSERT INTO mint_window_reads(chain,address,pool_address,source,read_at,price_usd,liquidity_usd,volume_m5,volume_h1,volume_h6,volume_h24)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [input.chain, input.address, pool.pairAddress, pairsSource, pairsFetchedAt,
      pool.priceUsd, pool.liquidityUsd, v.m5.volumeUsd, v.h1.volumeUsd, v.h6.volumeUsd, v.h24.volumeUsd]);
  }
  return { report, reads, failure: null };
}
