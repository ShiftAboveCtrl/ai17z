/**
 * What an account remembers between polls, kept in its settings.
 *
 * All under `settings.bluesky`, so it survives a restart and every process sees
 * the same thing. Read here so the adapter and the code that writes them agree on
 * the names. Nothing is marked read on Bluesky: that would change what the owner
 * sees in their own app.
 *
 * - `notificationsSeenThrough`: an ISO time. Everything at or after it that is an
 *   event has been ingested, with nothing unread between it and the newest.
 * - `notificationsResume`: `{ cursor, throughAt }`. A poll read part of a burst
 *   and stopped; `cursor` is where the next one carries on, and `throughAt` is the
 *   newest event of that burst, which becomes the mark only when the burst has
 *   been read to its end. The mark itself does not move until then.
 * - `notificationsVersion`: a counter bumped by every write of the two above. A
 *   poll notes the version it started from and its write applies only if that is
 *   still the version, so a poll that overlapped a newer one writes nothing.
 * - `sessionGeneration`: a counter bumped whenever a session must stop being used
 *   (disconnect, a new password), checked by every process before it reuses the
 *   session it holds.
 */
export const WATERMARK_KEY = 'notificationsSeenThrough';
export const RESUME_KEY = 'notificationsResume';
export const SESSION_GENERATION_KEY = 'sessionGeneration';
export const VERSION_KEY = 'notificationsVersion';

type Settings = Record<string, unknown> | null | undefined;

function blueskySettings(settings: Settings): Record<string, unknown> {
  const value = settings?.bluesky;
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const asTime = (value: unknown): string | null =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;

export function notificationsSeenThrough(settings: Settings): string | null {
  // A value that is not a time is no mark, which reads a single page rather than refusing.
  return asTime(blueskySettings(settings)[WATERMARK_KEY]);
}

export interface NotificationResume {
  cursor: string;
  /** Null when the burst so far held no event. */
  throughAt: string | null;
}

export function notificationsResume(settings: Settings): NotificationResume | null {
  const raw = blueskySettings(settings)[RESUME_KEY];
  if (raw === null || typeof raw !== 'object') return null;
  const { cursor, throughAt } = raw as { cursor?: unknown; throughAt?: unknown };
  if (typeof cursor !== 'string' || !cursor) return null;
  return { cursor, throughAt: asTime(throughAt) };
}

/** The version of the notification state, 0 before anything has been written. */
export function notificationsVersionOf(settings: Settings): number {
  const value = blueskySettings(settings)[VERSION_KEY];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

export function sessionGenerationOf(settings: Settings): number {
  const value = blueskySettings(settings)[SESSION_GENERATION_KEY];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}
