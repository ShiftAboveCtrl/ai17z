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

export function renderEvidenceCard(readings: CardReading[], offer: string, now = Date.now()): string {
  let found = false;
  const lines = readings.map(r => {
    const fetched = Date.parse(r.fetchedAt ?? '');
    const observed = Date.parse(r.observedAt ?? '');
    const current = [fetched, observed].every(t => Number.isFinite(t) && now - t <= r.maxAgeMs && t <= now + 30_000);
    const valid = typeof r.value === 'boolean' || (typeof r.value === 'number' && Number.isFinite(r.value) && r.value >= 0);
    const available = current && valid;
    found ||= available;
    const value = !available ? 'unavailable' : typeof r.value === 'boolean'
      ? r.value ? 'disabled' : 'enabled'
      : `${r.value} ${r.unit}`;
    return `${r.label}: ${value} [${r.source}; fetched ${Number.isFinite(fetched) ? new Date(fetched).toISOString() : 'unavailable'}]`;
  });
  return ['Token evidence', ...lines, ...(!found ? ['evidence not found'] : []), 'not a verdict, reads can be wrong', ...(offer ? [offer] : [])].join('\n');
}
