/**
 * Stable JSON: object keys sorted, arrays left in order because order is data,
 * `undefined` members dropped as `JSON.stringify` drops them.
 *
 * What a checksum or a digest is taken over, so the same content produces the
 * same bytes whichever order a serialiser happened to emit fields in. One
 * implementation: an agent package's checksum and a published voice's digest
 * both rest on it, and two copies that agree today are two that drift.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
