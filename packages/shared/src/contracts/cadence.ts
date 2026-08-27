import { z } from 'zod';

/**
 * Quiet hours. Shared by polling and acting so an account that is asleep is
 * asleep for both, rather than silently continuing to read.
 */
export const QuietHours = z.object({
  enabled: z.boolean().default(false),
  timezone: z.string().max(64).default('UTC'),
  /** Inclusive local hour the account wakes up. */
  startHour: z.number().int().min(0).max(23).default(8),
  /** Inclusive local hour it stops. Overnight windows are allowed. */
  endHour: z.number().int().min(0).max(23).default(23),
});
export type QuietHours = z.infer<typeof QuietHours>;

export const PollingCadence = z.object({
  enabled: z.boolean().default(true),
  /** Base gap between polls of this account. */
  intervalSeconds: z.number().int().min(15).max(86_400).default(120),
  /**
   * Random spread applied to every interval. A fixed heartbeat is both a poor
   * citizen on the remote service and a distinctive pattern; this is about being
   * unremarkable, not about hiding.
   */
  jitterPercent: z.number().int().min(0).max(50).default(20),
  /** Events fetched per poll. */
  batchLimit: z.number().int().min(1).max(100).default(10),
  /**
   * Doubles the interval each time a poll finds nothing, up to the ceiling, and
   * resets the moment something arrives. A quiet account costs almost nothing.
   */
  backoffWhenIdle: z.boolean().default(true),
  maxIntervalSeconds: z.number().int().min(15).max(86_400).default(1_800),
});
export type PollingCadence = z.infer<typeof PollingCadence>;

export const ActingCadence = z.object({
  /**
   * Ceilings for this account across every agent using it. Agent policy has its
   * own limits; the tighter of the two applies and the explanation names which.
   * 0 means the account sets no ceiling of its own.
   */
  maxActionsPerHour: z.number().int().min(0).max(10_000).default(0),
  maxActionsPerDay: z.number().int().min(0).max(100_000).default(0),
  minSecondsBetweenActions: z.number().int().min(0).max(86_400).default(0),
});
export type ActingCadence = z.infer<typeof ActingCadence>;

export const CadenceConfig = z.object({
  polling: PollingCadence.default({}),
  acting: ActingCadence.default({}),
  quietHours: QuietHours.default({}),
});
export type CadenceConfig = z.infer<typeof CadenceConfig>;

export const defaultCadence = (): CadenceConfig => CadenceConfig.parse({});

/** What the engine decided, and why, in words a person can act on. */
export const CadenceVerdict = z.object({
  allowed: z.boolean(),
  reason: z.string(),
  message: z.string(),
  /** Set when the answer is "not yet" rather than "no". */
  retryAfterMs: z.number().int().min(0).nullable().default(null),
  /** Which limit bound: 'account' or 'agent'. */
  boundBy: z.enum(['account', 'agent', 'none']).default('none'),
});
export type CadenceVerdict = z.infer<typeof CadenceVerdict>;
