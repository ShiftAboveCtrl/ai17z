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

/** One earlier launch by the same address. Absent liquidity is null, never zero. */
export interface DeployerMint {
  mint: string;
  liquidityNowUsd: number | null;
  liquidityAtCreationUsd: number | null;
  source: string;
  readAt: string | null;
}

/**
 * What was read about the address that created the card's mint.
 *
 * `address` is the fee payer of the mint's creation transaction, read from the
 * chain. `otherLaunches` is an index's count and is only set when the index
 * names the same address. Every field is a reading with its source and time;
 * none is a judgement of the address.
 */
export interface DeployerHistory {
  address: string | null;
  createdAt: string | null;
  source: string;
  fetchedAt: string | null;
  otherLaunches: number | null;
  launchesSource: string;
  launchesFetchedAt: string | null;
  launchesObservedAt: string | null;
  launchesMaxAgeMs: number;
  earlier: DeployerMint[];
}

/** Printed at most this many, in the order given. No ordering by any score. */
export const MAX_EARLIER_LAUNCHES = 5;

const iso = (value: string | null) => {
  const t = Date.parse(value ?? '');
  return Number.isFinite(t) ? new Date(t).toISOString() : 'unavailable';
};
const usd = (value: number | null) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `${value} USD` : 'unavailable';

/** Lines for the deployer section. Fixed template and neutral words, so a rewrite has nothing to improve. */
export function renderDeployerLines(history: DeployerHistory, now = Date.now()): string[] {
  const lines: string[] = [];
  lines.push(history.address
    ? `Deployer (creation fee payer): ${history.address} [${history.source}; created ${iso(history.createdAt)}; fetched ${iso(history.fetchedAt)}]`
    : 'Deployer (creation fee payer): unavailable');
  const fetched = Date.parse(history.launchesFetchedAt ?? '');
  const observed = Date.parse(history.launchesObservedAt ?? '');
  const current = [fetched, observed].every(t => Number.isFinite(t) && now - t <= history.launchesMaxAgeMs && t <= now + 30_000);
  const count = history.otherLaunches;
  lines.push(history.address && current && typeof count === 'number' && Number.isInteger(count) && count >= 0
    ? `Launches by this address, index count: ${count} [${history.launchesSource}; fetched ${iso(history.launchesFetchedAt)}]`
    : 'Launches by this address, index count: unavailable');
  for (const earlier of history.earlier.slice(0, MAX_EARLIER_LAUNCHES)) {
    lines.push(`Earlier launch ${earlier.mint}: liquidity now ${usd(earlier.liquidityNowUsd)}, at creation ${usd(earlier.liquidityAtCreationUsd)} [${earlier.source}; read ${iso(earlier.readAt)}]`);
  }
  return lines;
}

/**
 * What the mint account's own bytes say about Token-2022 extensions.
 *
 * Three outcomes, and they are different things to tell somebody:
 * `not_applicable` (the original Token program has no extensions), `unread`
 * (the account could not be fetched or its bytes could not be decoded, which says
 * nothing about whether a fee exists) and `read`. Under `read`, a null field
 * means that extension is not on the mint. It is never a failed read.
 */
export type MintExtensions =
  | { status: 'unread'; source: string; fetchedAt: string | null; maxAgeMs: number }
  | { status: 'not_applicable'; source: string; fetchedAt: string | null; maxAgeMs: number }
  | {
      status: 'read'; source: string; fetchedAt: string | null; maxAgeMs: number;
      /** The fee in effect at the slot the account was read, in basis points, with the cap as an exact base-unit integer. */
      transferFee: { bps: number; maxFee: string } | null;
      /** An address only when one is set. An extension with the authority unset is no delegate. */
      permanentDelegate: string | null;
      transferHookProgram: string | null;
      defaultAccountState: 'initialized' | 'frozen' | null;
      /** Extension type ids present that this does not decode. Said, never skipped silently. */
      otherTypeIds: number[];
    };

/** Basis points as a percentage without a double: 500 is "5", 25 is "0.25", 1 is "0.01". */
export function bpsAsPercent(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = String(bps % 100).padStart(2, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

/**
 * Lines for the Token-2022 section. Fixed template and neutral words. A stale or
 * malformed reading is one `extensions unread` line, so no old fee is ever
 * printed as current and no missing one is printed as zero.
 */
export function renderMintExtensionLines(ext: MintExtensions, now = Date.now()): string[] {
  const fetched = Date.parse(ext.fetchedAt ?? '');
  const current = Number.isFinite(fetched) && now - fetched <= ext.maxAgeMs && fetched <= now + 30_000;
  const from = `[${ext.source}; fetched ${iso(ext.fetchedAt)}]`;
  if (!current || ext.status === 'unread') return ['Token-2022: extensions unread'];
  if (ext.status === 'not_applicable') return [`Token-2022: not applicable (SPL Token) ${from}`];
  const fee = ext.transferFee;
  const ids = ext.otherTypeIds.length ? ` (type ids ${ext.otherTypeIds.join(', ')})` : '';
  return [
    `Token-2022: extensions read ${from}`,
    fee ? `transfer fee: ${fee.bps} bps (${bpsAsPercent(fee.bps)}%)` : 'transfer fee: none',
    ...(fee ? [`transfer fee cap: ${fee.maxFee} base units`] : []),
    `permanent delegate: ${ext.permanentDelegate ?? 'none'}`,
    `transfer hook: ${ext.transferHookProgram ?? 'none'}`,
    ...(ext.defaultAccountState ? [`default account state: ${ext.defaultAccountState}`] : []),
    ...(ext.otherTypeIds.length ? [`additional unparsed extensions present${ids}`] : []),
  ];
}

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

export function renderEvidenceCard(readings: CardReading[], offer: string, now = Date.now(), link = '', deployer: DeployerHistory | null = null, extensions: MintExtensions | null = null): string {
  let found = false;
  const lines = readings.map(r => {
    found ||= readingAvailable(r, now);
    return `${r.label}: ${readingText(r, now)} [${r.source}; fetched ${fetchedText(r)}]`;
  });
  return ['Token evidence', ...lines, ...(deployer ? renderDeployerLines(deployer, now) : []),
    ...(extensions ? renderMintExtensionLines(extensions, now) : []),
    ...(!found ? ['evidence not found'] : []), 'not a verdict, reads can be wrong',
    ...(offer ? [offer] : []), ...(link ? [`${CHECK_LINK_PREFIX}${link}`] : [])].join('\n');
}
