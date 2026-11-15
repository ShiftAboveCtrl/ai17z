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

/**
 * `extra` is a block that belongs under the card's closing words and above the owner line and link,
 * which today is only the holder map. Empty for every card that does not ask for one, so those are
 * byte for byte what they were.
 */
export function renderEvidenceCard(readings: CardReading[], offer: string, now = Date.now(), link = '', extra: readonly string[] = []): string {
  let found = false;
  const lines = readings.map(r => {
    found ||= readingAvailable(r, now);
    return `${r.label}: ${readingText(r, now)} [${r.source}; fetched ${fetchedText(r)}]`;
  });
  return ['Token evidence', ...lines, ...(!found ? ['evidence not found'] : []), 'not a verdict, reads can be wrong',
    ...extra, ...(offer ? [offer] : []), ...(link ? [`${CHECK_LINK_PREFIX}${link}`] : [])].join('\n');
}
