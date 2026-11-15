/** Only typed numeric/boolean readings enter this layout. No upstream prose is echoed. */
export interface CardReading {
  label: string;
  value: number | boolean | null;
  unit: 'USD' | '%' | 'hours' | 'authority';
  source: string;
  fetchedAt: string | null;
  observedAt: string | null;
  maxAgeMs: number;
}

/** Whether a reading is current and well formed enough to print as a value. */
export function readingAvailable(r: CardReading, now = Date.now()): boolean {
  const fetched = Date.parse(r.fetchedAt ?? '');
  const observed = Date.parse(r.observedAt ?? '');
  const current = [fetched, observed].every(t => Number.isFinite(t) && now - t <= r.maxAgeMs && t <= now + 30_000);
  const valid = typeof r.value === 'boolean' || (typeof r.value === 'number' && Number.isFinite(r.value) && r.value >= 0);
  return current && valid;
}

/** The line that carries a check page address. Its prefix is how the send check finds it again. */
export const CHECK_LINK_PREFIX = 'Full check: ';

/** The one way a reading becomes text, for a single card and for a comparison. */
function readingText(r: CardReading, now: number): string {
  if (!readingAvailable(r, now)) return 'unavailable';
  return typeof r.value === 'boolean' ? (r.value ? 'disabled' : 'enabled') : `${r.value} ${r.unit}`;
}

function fetchedText(r: CardReading): string {
  const fetched = Date.parse(r.fetchedAt ?? '');
  return Number.isFinite(fetched) ? new Date(fetched).toISOString() : 'unavailable';
}

/** The lines that carry the two check page addresses of a comparison. Their prefixes are how the send check finds them again. */
export const COMPARE_LINK_PREFIXES = ['Check A: ', 'Check B: '] as const;

export interface CompareSide {
  /** A shortened form of the address the asker gave. A full address would be one the model must not write. */
  short: string;
  readings: CardReading[];
}

/** The first and last characters only, so the asker can tell which column is which. */
export function shortAddress(address: string): string {
  return address.startsWith('0x') ? `${address.slice(0, 6)}…${address.slice(-4)}` : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * Two tokens, the same fields, one column each, in the order the asker named
 * them. Nothing here scores, orders or compares a value: a side whose read
 * failed says "unavailable" for that side and the other still renders.
 */
export function renderEvidenceCompare(sides: readonly [CompareSide, CompareSide], now = Date.now(), links: readonly [string | null, string | null] = [null, null]): string {
  const [a, b] = sides;
  const labels: string[] = [];
  for (const side of sides) for (const r of side.readings) if (!labels.includes(r.label)) labels.push(r.label);
  const at = (side: CompareSide, label: string) => {
    const reading = side.readings.find(r => r.label === label);
    return reading ? readingText(reading, now) : 'unavailable';
  };
  const reads = (side: CompareSide, name: 'A' | 'B') => {
    const pairs = [...new Set(side.readings.map(r => `${r.source}; fetched ${fetchedText(r)}`))];
    return `${name} read: ${pairs.length ? pairs.join(', ') : 'unavailable'}`;
  };
  const missing = (['A', 'B'] as const).filter((_, i) => !sides[i]!.readings.some(r => readingAvailable(r, now)));
  return ['Token evidence, side by side', `A: ${a.short}`, `B: ${b.short}`,
    ...labels.map(label => `${label}: A ${at(a, label)} | B ${at(b, label)}`),
    reads(a, 'A'), reads(b, 'B'),
    ...missing.map(name => `evidence not found for ${name}`),
    'no ranking, not a verdict, reads can be wrong',
    ...links.flatMap((link, i) => link ? [`${COMPARE_LINK_PREFIXES[i]}${link}`] : [])].join('\n');
}

export function renderEvidenceCard(readings: CardReading[], offer: string, now = Date.now(), link = ''): string {
  let found = false;
  const lines = readings.map(r => {
    found ||= readingAvailable(r, now);
    return `${r.label}: ${readingText(r, now)} [${r.source}; fetched ${fetchedText(r)}]`;
  });
  return ['Token evidence', ...lines, ...(!found ? ['evidence not found'] : []), 'not a verdict, reads can be wrong',
    ...(offer ? [offer] : []), ...(link ? [`${CHECK_LINK_PREFIX}${link}`] : [])].join('\n');
}

/* ------------------------------------------------------------ what changed */

/** One measured figure, then and now. `then` null means there was no earlier reading, and then no change is shown. */
export interface MoveFigure {
  label: string;
  unit: 'USD' | 'trades';
  then: number | null;
  now: number | null;
  /** Where the "then" came from, in words: an earlier reading of ours, or arithmetic on the source's own fields. */
  thenFrom: string | null;
  /** Percent change, computed from then and now only. Null whenever either is absent or "then" is zero. */
  changePct: number | null;
  source: string;
  nowAt: string | null;
}

export interface MoveReport {
  window: '5m' | '1h' | '6h' | '24h';
  chain: string;
  /** The mint the asker named, shortened for display. */
  short: string;
  /** The pool the figures come from: the one nearest the median price, never the deepest. Null when no pool was found. */
  pool: { short: string; dex: string | null; pools: number; liquidityUsd: number | null } | null;
  figures: MoveFigure[];
  sizeBands: { small: number; mid: number; large: number; unsized: number; swaps: number; coversWindow: boolean; source: string; fetchedAt: string } | null;
  newPools: { count: number; untimed: number; pools: number; items: { short: string; dex: string | null; createdAt: string }[]; source: string; fetchedAt: string } | null;
  /** The newest time any reading in this report was fetched. A reading past its age is not sent. */
  fetchedAt: string | null;
}

/** Words a movement reply never prints, even inside a shortened address (many Solana mints end in "pump"). */
const MOVE_BANNED = /pump|dump|because|whale|manipulat|driven|expected|will/i;
/** A short form of an address that cannot spell a banned word: the usual four and four, else shorter ends. */
export function safeShortAddress(address: string): string {
  const head = address.startsWith('0x') ? 6 : 4;
  for (const [a, b] of [[head, 4], [head, 3], [head, 2], [head, 1]] as const) {
    const short = `${address.slice(0, a)}…${address.slice(-b)}`;
    if (!MOVE_BANNED.test(short)) return short;
  }
  return `${address.slice(0, 2)}…`;
}

/** The one footer sentence. A cause is never offered, whatever the readings are. */
export const MOVE_CAUSE_LINE = 'caused by: unknown, readings only';
/** Every size band edge in USD, written once so the template and the builder agree. */
export const MOVE_SIZE_BANDS = { smallBelow: 100, largeFrom: 1000 } as const;
/** Pools thinner than this make a percent noisy. */
export const MOVE_THIN_POOL_USD = 10_000;

function amount(n: number): string {
  const text = String(Number(n.toPrecision(4)));
  return text.includes('e') ? n.toFixed(12).replace(/0+$/, '').replace(/\.$/, '') : text;
}
function figureValue(f: MoveFigure, n: number | null): string {
  return n === null ? 'unavailable' : `${amount(n)} ${f.unit}`;
}

export function renderEvidenceMove(report: MoveReport): string {
  const depth = report.pool?.liquidityUsd ?? null;
  const lines = [`Measured changes, ${report.window} window, ${report.short} on ${report.chain}`];
  if (!report.pool) {
    lines.push('evidence not found: no market pool was read for this mint');
  } else {
    const where = `${report.pool.short}${report.pool.dex ? ` (${report.pool.dex})` : ''}`;
    lines.push(`Pool: ${report.pool.pools > 1 ? `median of ${report.pool.pools} pools,` : 'only pool read,'} ${where}, liquidity now ${depth === null ? 'unavailable' : `${amount(depth)} USD`}`);
  }
  for (const f of report.figures) {
    const then = f.then === null ? 'no earlier reading' : figureValue(f, f.then);
    const change = f.changePct === null ? 'change omitted' : `change ${f.changePct >= 0 ? '+' : ''}${f.changePct.toFixed(1)}%`;
    const withDepth = f.changePct !== null && depth !== null ? ` | pool depth ${amount(depth)} USD` : '';
    const from = f.then !== null && f.thenFrom ? `; then ${f.thenFrom}` : '';
    lines.push(`${f.label}: then ${then} | now ${figureValue(f, f.now)} | ${change}${withDepth} [${f.source}; fetched ${f.nowAt ?? 'unavailable'}${from}]`);
  }
  if (report.sizeBands) {
    const b = report.sizeBands;
    lines.push(`Swap sizes, latest ${b.swaps} in the window: under ${MOVE_SIZE_BANDS.smallBelow} USD ${b.small}, up to ${MOVE_SIZE_BANDS.largeFrom} USD ${b.mid}, ${MOVE_SIZE_BANDS.largeFrom} USD and over ${b.large}, size not reported ${b.unsized}${b.coversWindow ? '' : ' (the latest swaps did not reach back the whole window)'} [${b.source}; fetched ${b.fetchedAt}]`);
  } else if (report.pool) lines.push('Swap sizes: unavailable');
  if (report.newPools) {
    const n = report.newPools;
    const found = n.count === 0 ? `none among ${n.pools} pools read` : `${n.count} created in the window: ${n.items.map(i => `${i.short}${i.dex ? ` (${i.dex})` : ''} at ${i.createdAt}`).join(', ')}`;
    lines.push(`New pools for this mint: ${found}${n.untimed ? `; ${n.untimed} with no creation time` : ''} [${n.source}; fetched ${n.fetchedAt}]`);
  }
  if (report.pool && depth !== null && depth < MOVE_THIN_POOL_USD) lines.push('thin pool: a small trade moves these percents a long way');
  lines.push('history: only the reads this installation made, so a short history leaves "then" empty');
  lines.push(MOVE_CAUSE_LINE);
  lines.push('not a verdict, reads can be wrong');
  return lines.join('\n');
}
