import { z } from 'zod';

/**
 * What Studio's token page and risk watches read about a token's vesting
 * streams. This is a contract, not an endpoint: nothing in this repository
 * serves it yet, and Studio reads the chain itself and is built against the
 * decoding rules in `docs/architecture/TOKEN_UNLOCKS.md`, not against an
 * installation's answer.
 *
 * Absent is never zero. `null` means "not read". `status: 'NONE_SEEN'` means
 * the accounts that were read held no stream, which is not the same as the
 * token having none: only the largest token accounts are looked at, and only
 * Streamflow is decoded.
 *
 * No stream address, sender or recipient is carried. Dates and amounts only.
 */
export const TOKEN_UNLOCKS_PATH = '/api/v1/installation/token-unlocks';
export const TOKEN_UNLOCKS_PROTOCOL = 1;
/** One read looks at most this many stream accounts, to stay inside the RPC budget. */
export const TOKEN_UNLOCKS_MAX_STREAMS = 20;
/** A read is good for an hour. */
export const TOKEN_UNLOCKS_CACHE_MS = 60 * 60_000;

const Time = z.string().datetime({ offset: true });
const Units = z.string().regex(/^\d+$/, 'An exact integer in base units.');

export const TokenUnlockStream = z.object({
  /** LOCKED: end time ahead. ENDED: end time passed. CANCELED: the stream was cancelled. */
  state: z.enum(['LOCKED', 'ENDED', 'CANCELED']),
  startAt: Time.nullable(),
  endAt: Time,
  cliffAt: Time.nullable(),
  /** What the stream's escrow still holds, in base units. */
  heldAmount: Units,
  /** Per cent of supply held, two places, rounded down. */
  sharePct: z.number().min(0).max(100).nullable(),
  /** False when the period or amounts did not describe a schedule this reader can follow. */
  scheduleReadable: z.boolean(),
  nextReleaseAt: Time.nullable(),
  nextReleaseAmount: Units.nullable(),
}).strict();
export type TokenUnlockStream = z.infer<typeof TokenUnlockStream>;

export const TokenUnlocksFound = z.object({
  protocol: z.literal(TOKEN_UNLOCKS_PROTOCOL),
  chain: z.literal('solana'),
  address: z.string().min(32).max(44),
  status: z.enum(['FOUND', 'NONE_SEEN']),
  decimals: z.number().int().min(0).max(30).nullable(),
  supply: Units.nullable(),
  /** Held by streams whose end time is still ahead. Null when nothing was seen to hold. */
  totalLockedAmount: Units.nullable(),
  supplyPctLocked: z.number().min(0).max(100).nullable(),
  nextUnlockAt: Time.nullable(),
  nextUnlockAmount: Units.nullable(),
  unlockingNext7DaysAmount: Units.nullable(),
  /** A stream releases by the second or minute, so no single next date applies. */
  releasingNow: z.boolean(),
  lastUnlockAt: Time.nullable(),
  /** True when no unfinished stream was seen. Studio prints "no scheduled release date on record". */
  noScheduledRelease: z.boolean(),
  endedStreams: z.number().int().min(0),
  /** Self-owned token accounts whose stream was not decoded. Not counted in any total. */
  unrecognizedLockAccounts: z.number().int().min(0),
  /** Candidates left unread by the ceiling or deadline. Above zero, totals are a lower bound. */
  notRead: z.number().int().min(0),
  accountsRead: z.number().int().min(0).max(20),
  streams: z.array(TokenUnlockStream).max(TOKEN_UNLOCKS_MAX_STREAMS),
  /** Always false: Jupiter Lock, Team Finance, Sablier and the rest are not decoded. */
  otherLockersRead: z.literal(false),
  source: z.literal('streamflow'),
  slot: z.number().int().nonnegative().nullable(),
  readAt: Time,
  statement: z.string().max(1200),
}).strict();
export type TokenUnlocksFound = z.infer<typeof TokenUnlocksFound>;

/** A read that failed is never a payload with zeros in it. */
export const TokenUnlocksUnavailable = z.object({
  protocol: z.literal(TOKEN_UNLOCKS_PROTOCOL),
  chain: z.literal('solana'),
  address: z.string().min(32).max(44),
  status: z.literal('UNAVAILABLE'),
  reason: z.string().max(300),
}).strict();
export type TokenUnlocksUnavailable = z.infer<typeof TokenUnlocksUnavailable>;

export const TokenUnlocksPayload = z.discriminatedUnion('status', [
  TokenUnlocksFound.extend({ status: z.literal('FOUND') }),
  TokenUnlocksFound.extend({ status: z.literal('NONE_SEEN') }),
  TokenUnlocksUnavailable,
]);
export type TokenUnlocksPayload = z.infer<typeof TokenUnlocksPayload>;
