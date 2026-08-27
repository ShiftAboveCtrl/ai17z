import { z } from 'zod';

/**
 * The ways AI17Z can notice that something happened.
 *
 * Each is independent. The point of having several is that none of them is
 * trusted to be complete: X notifications drop things, search misses things,
 * and a thread can collect replies that produce no notification at all.
 */
export const RADAR_SOURCE_KINDS = [
  /** The platform's own notifications surface. One source, not the truth. */
  'notifications',
  /** Searching for the account's handle, to catch mentions notifications lost. */
  'mention_search',
  /** Searching for replies addressed to the account. */
  'reply_search',
  /** Walking the agent's own recent posts and reading what is underneath them. */
  'own_threads',
  /** Watching a specific account. Watching is not permission to reply to it. */
  'tracked_account',
  /** Watching a keyword, phrase, ticker, or custom query. */
  'tracked_keyword',
] as const;
export const RadarSourceKind = z.enum(RADAR_SOURCE_KINDS);
export type RadarSourceKind = (typeof RADAR_SOURCE_KINDS)[number];

/** Kinds that need a target; the rest watch the account itself. */
export const RADAR_KINDS_NEEDING_TARGET: readonly RadarSourceKind[] = ['tracked_account', 'tracked_keyword'];

export const RADAR_STATUSES = ['UNKNOWN', 'HEALTHY', 'DEGRADED', 'FAILING', 'DISABLED'] as const;
export const RadarStatus = z.enum(RADAR_STATUSES);
export type RadarStatus = (typeof RADAR_STATUSES)[number];

export const RadarSourceConfig = z.object({
  /** Base gap between polls of this source. */
  intervalSeconds: z.number().int().min(20).max(86_400).default(180),
  /** Results pulled per poll. */
  limit: z.number().int().min(1).max(100).default(20),
  /**
   * Whether candidates from this source may create jobs, or only inform context.
   * Watching an account is not permission to reply to it (§8).
   */
  mayTrigger: z.boolean().default(true),
  /** Higher runs sooner when several sources are due at once. */
  priority: z.number().int().min(0).max(100).default(50),
});
export type RadarSourceConfig = z.infer<typeof RadarSourceConfig>;

/**
 * One thing a monitor noticed.
 *
 * Deliberately not an event: a candidate is what a single source saw. The
 * reconciler decides whether several candidates are the same post, and only then
 * does an event exist.
 */
export const RadarCandidate = z.object({
  /**
   * The post's own identity on the remote side — a status id for X. This is what
   * makes the same post seen through three monitors one event rather than three.
   */
  remoteId: z.string().min(1).max(300),
  remoteUrl: z.string().max(2_000).nullable().default(null),
  authorHandle: z.string().max(300).nullable().default(null),
  authorId: z.string().max(300).nullable().default(null),
  authorDisplayName: z.string().max(300).nullable().default(null),
  text: z.string().max(50_000).default(''),
  /** The post this one replies to, when the source could see it. */
  parentRemoteId: z.string().max(300).nullable().default(null),
  conversationRemoteId: z.string().max(300).nullable().default(null),
  occurredAt: z.string().nullable().default(null),
  /** What kind of thing this looked like where it was found. */
  eventType: z.string().max(50).default('MENTION'),
  raw: z.record(z.unknown()).default({}),
});
export type RadarCandidate = z.infer<typeof RadarCandidate>;

/** What one poll of one source produced. */
export const RadarPollResult = z.object({
  candidates: z.array(RadarCandidate).default([]),
  /** New high-water mark, when the source has one. */
  cursor: z.string().max(300).nullable().default(null),
  /** Set when the source could not be read. */
  error: z.string().nullable().default(null),
});
export type RadarPollResult = z.infer<typeof RadarPollResult>;

/** Health of one source, for the UI. */
export const RadarSourceHealth = z.object({
  id: z.string().uuid(),
  kind: RadarSourceKind,
  target: z.string().nullable(),
  label: z.string(),
  enabled: z.boolean(),
  status: RadarStatus,
  lastPollAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastResultAt: z.string().nullable(),
  lastError: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  nextPollAt: z.string().nullable(),
});
export type RadarSourceHealth = z.infer<typeof RadarSourceHealth>;
