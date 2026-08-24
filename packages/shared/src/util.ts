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
