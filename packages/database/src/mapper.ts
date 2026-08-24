/**
 * Row mapping. Postgres gives us snake_case columns and Date objects; the
 * contracts in @xbam/shared use camelCase and ISO strings. One documented
 * conversion here beats hand-written mappers in every repository.
 *
 * The cast is deliberate: the SQL in each repository is the type contract, and
 * the API layer re-validates anything that crosses the network boundary.
 */

const camelCache = new Map<string, string>();

function toCamel(key: string): string {
  const cached = camelCache.get(key);
  if (cached) return cached;
  const camel = key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  camelCache.set(key, camel);
  return camel;
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}

export function mapRow<T>(row: Record<string, unknown> | null | undefined): T | null {
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[toCamel(key)] = normalizeValue(value);
  return out as T;
}

export function mapRows<T>(rows: Record<string, unknown>[]): T[] {
  return rows.map((row) => mapRow<T>(row) as T);
}

/** Postgres `count(*)` comes back as a number thanks to the int8 type parser. */
export function countOf(rows: Record<string, unknown>[]): number {
  const value = rows[0]?.count;
  return typeof value === 'number' ? value : Number(value ?? 0);
}
