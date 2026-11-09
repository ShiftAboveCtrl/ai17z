/**
 * Where the last poll of an account's notifications stopped.
 *
 * Kept in the account's settings (`bluesky.notificationsSeenThrough`, an ISO
 * time) so it survives a restart, and read here so the adapter and the code that
 * advances it agree on the name. Nothing is marked read on Bluesky: that would
 * change what the owner sees in their own app.
 */
export const WATERMARK_KEY = 'notificationsSeenThrough';

export function notificationsSeenThrough(settings: Record<string, unknown> | null | undefined): string | null {
  const bluesky = settings?.bluesky as Record<string, unknown> | undefined;
  const value = bluesky?.[WATERMARK_KEY];
  if (typeof value !== 'string') return null;
  // A value that is not a time is no mark, which reads a single page rather than refusing.
  return Number.isFinite(Date.parse(value)) ? value : null;
}
