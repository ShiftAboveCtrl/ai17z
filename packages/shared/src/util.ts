export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const nowIso = (): string => new Date().toISOString();

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Exponential backoff with full jitter, capped. Used for every retry in XBAM. */
export function backoffMs(attempt: number, baseMs = 2_000, capMs = 5 * 60_000): number {
  const exponential = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential / 2 + Math.random() * (exponential / 2));
}

/**
 * Removes characters that cannot be stored, or that should not be repeated.
 *
 * A NUL byte is the sharp one: Postgres text simply cannot hold `0x00`, so a
 * mention containing one threw `invalid byte sequence for encoding "UTF8"`
 * straight out of the driver -- an unclassified database error at ingest, from
 * a post somebody can write on purpose.
 *
 * The rest are removed because they survive a round trip and come out as
 * something else on somebody's client: other C0 controls, the zero-width
 * family, and the bidirectional overrides that let text render in an order it
 * is not written in.
 *
 * Tabs and newlines are kept. They are formatting somebody chose.
 */
export function sanitizeText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '');
}

export function truncate(text: string, max: number, suffix = '...'): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

/** Keeps the newest content when a budget is exceeded, matching how conversation tails matter most. */
export function truncateTail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

export function uniqueBy<T, K>(items: readonly T[], key: (item: T) => K): T[] {
  const seen = new Set<K>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

const STOPWORDS = new Set([
  'the','a','an','and','or','but','if','then','than','so','to','of','in','on','at','for','with','is','are','was','were',
  'be','been','it','this','that','these','those','i','you','he','she','we','they','my','your','his','her','our','their',
  'do','does','did','not','no','yes','what','which','who','whom','how','when','where','why','can','could','would','should',
]);

/** Cheap keyword extraction used by deterministic memory retrieval. */
export function keywords(text: string, limit = 12): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([t]) => t);
}

export function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled case in ${context}: ${JSON.stringify(value)}`);
}

/**
 * A JSON string whose object keys are in a fixed order, for comparing two
 * values by content.
 *
 * `JSON.stringify` preserves insertion order, so two objects that say exactly
 * the same thing compare unequal when their keys were built in a different
 * order. A configuration document that has been through Postgres comes back in
 * whatever order the column produced, which is not the order the code that
 * built it used: an emoji block written as `{ use, allowed, maxPerMessage }`
 * read back as `{ use, maxPerMessage, allowed }` and every save looked like an
 * edit.
 *
 * Array order is preserved, because in a list order is content.
 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    // undefined is absent rather than present-and-empty, exactly as
    // JSON.stringify treats it, so an optional field left unset compares equal
    // to one never written.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

/** Whether two values say the same thing, whatever order their keys are in. */
export function sameContent(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}
