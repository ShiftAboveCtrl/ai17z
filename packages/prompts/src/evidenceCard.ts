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

export function renderEvidenceCard(readings: CardReading[], offer: string, now = Date.now(), link = '', deployer: DeployerHistory | null = null): string {
  let found = false;
  const lines = readings.map(r => {
    const fetched = Date.parse(r.fetchedAt ?? '');
    const available = readingAvailable(r, now);
    found ||= available;
    const value = !available ? 'unavailable' : typeof r.value === 'boolean'
      ? r.value ? 'disabled' : 'enabled'
      : `${r.value} ${r.unit}`;
    return `${r.label}: ${value} [${r.source}; fetched ${Number.isFinite(fetched) ? new Date(fetched).toISOString() : 'unavailable'}]`;
  });
  return ['Token evidence', ...lines, ...(deployer ? renderDeployerLines(deployer, now) : []), ...(!found ? ['evidence not found'] : []), 'not a verdict, reads can be wrong',
    ...(offer ? [offer] : []), ...(link ? [`${CHECK_LINK_PREFIX}${link}`] : [])].join('\n');
}
