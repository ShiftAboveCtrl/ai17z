import { z } from 'zod';

/** Studio's coin alerts for this installation's owner. Read only: nothing is sent back. */
export const STUDIO_COIN_ALERTS_PATH = '/api/v1/installation/coin-alerts';
/** A list older than this is treated as Studio being unreachable, not as news. */
export const STUDIO_COIN_ALERTS_SNAPSHOT_MS = 60 * 60_000;
/** The only sync schedule: the claim moves this far forward, on the radar tick. */
export const STUDIO_COIN_ALERTS_SYNC_MS = 10 * 60_000;
/** Entries read from one document. Anything past it is skipped with a reason. */
export const STUDIO_COIN_ALERTS_MAX_ENTRIES = 200;
/** Most mints the alert source may rotate through, before the shared ceiling below. */
export const STUDIO_COIN_ALERTS_MAX_MINTS = 25;
/** Playbook universe and alert universe together never exceed this (MAX_PLAYBOOK_ASSETS). */
export const RADAR_UNIVERSE_CEILING = 50;

/**
 * The envelope is strict; the entries are not parsed here. Each is read on its own so one
 * malformed entry is skipped with a stated reason instead of discarding the owner's list.
 */
export const StudioCoinAlertDocument = z.object({
  protocol: z.literal(1),
  generated_at: z.string().datetime({ offset: true }),
  alerts: z.array(z.unknown()),
}).strict();
export type StudioCoinAlertDocument = z.infer<typeof StudioCoinAlertDocument>;

export interface CoinAlertSkip { index: number; reason: string }
