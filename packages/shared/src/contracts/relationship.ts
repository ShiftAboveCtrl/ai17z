import { z } from 'zod';

/**
 * How well the agent knows somebody.
 *
 * Bounded and small on purpose. This exists so a conversation can continue
 * naturally — not as a score for deciding whose message is worth more, and not
 * as a measure of anybody's value.
 */
export const FAMILIARITY_LEVELS = ['NEW', 'KNOWN', 'FAMILIAR', 'REGULAR'] as const;
export const Familiarity = z.enum(FAMILIARITY_LEVELS);
export type Familiarity = (typeof FAMILIARITY_LEVELS)[number];

/** An explicit instruction from the owner about how to treat somebody. */
export const DISPOSITIONS = ['NEUTRAL', 'FRIENDLY', 'CAUTIOUS', 'BLOCKED'] as const;
export const Disposition = z.enum(DISPOSITIONS);
export type Disposition = (typeof DISPOSITIONS)[number];

/**
 * Thresholds for familiarity.
 *
 * Exchanges rather than messages: somebody who sent five messages the agent
 * never answered is not familiar, they are persistent. And time matters — three
 * conversations over three months is a different relationship from three in an
 * afternoon.
 */
export const FAMILIARITY_RULES = {
  KNOWN: { exchanges: 2 },
  FAMILIAR: { exchanges: 5, spanDays: 2 },
  REGULAR: { exchanges: 12, spanDays: 7 },
} as const;

export const RelationshipVoice = z.object({
  /**
   * How the agent's expression shifts per familiarity level. The persona stays
   * primary; these adjust expression inside what it already allows.
   */
  strangerExplains: z.boolean().default(true),
  regularsGetBrevity: z.boolean().default(true),
  callbacksAllowedFrom: Familiarity.default('FAMILIAR'),
  /** Never mirror hostility, whoever it comes from. */
  mirrorHostility: z.boolean().default(false),
});
export type RelationshipVoice = z.infer<typeof RelationshipVoice>;

export const RelationshipCallback = z.object({
  id: z.string().uuid(),
  label: z.string(),
  detail: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  useCount: z.number().int(),
  retired: z.boolean(),
});
export type RelationshipCallback = z.infer<typeof RelationshipCallback>;

export const RelationshipProfile = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  channel: z.string(),
  remoteUserId: z.string().nullable(),
  handle: z.string(),
  displayName: z.string(),
  firstInteractionAt: z.string(),
  lastInteractionAt: z.string(),
  interactionCount: z.number().int(),
  inboundCount: z.number().int(),
  outboundCount: z.number().int(),
  familiarity: Familiarity,
  familiarityPinned: z.boolean(),
  topics: z.array(z.string()),
  summary: z.string(),
  typicalTone: z.string().nullable(),
  ownerNote: z.string(),
  disposition: Disposition,
});
export type RelationshipProfile = z.infer<typeof RelationshipProfile>;

/**
 * What the prompt is told about the person being replied to.
 *
 * Deliberately a small, readable shape: a few sentences a person could have
 * written. Handing a model a table of counts produces replies that sound like
 * they came from a CRM.
 */
export const RelationshipContext = z.object({
  known: z.boolean(),
  handle: z.string(),
  familiarity: Familiarity,
  /** "You have spoken 6 times, most recently 2 days ago." */
  historyLine: z.string(),
  topics: z.array(z.string()).default([]),
  summary: z.string().nullable().default(null),
  ownerNote: z.string().nullable().default(null),
  disposition: Disposition.default('NEUTRAL'),
  /** A shared reference the agent may use, when one is due. */
  callback: z
    .object({ label: z.string(), detail: z.string() })
    .nullable()
    .default(null),
});
export type RelationshipContext = z.infer<typeof RelationshipContext>;

/** Derives familiarity from what has actually happened. */
export function deriveFamiliarity(input: {
  inboundCount: number;
  outboundCount: number;
  firstInteractionAt: string | Date;
  lastInteractionAt: string | Date;
}): Familiarity {
  // An exchange is a message the agent answered. Counting inbound alone would
  // make anybody who mentions the agent repeatedly look like a regular.
  const exchanges = Math.min(input.inboundCount, input.outboundCount);
  const first = new Date(input.firstInteractionAt).getTime();
  const last = new Date(input.lastInteractionAt).getTime();
  const spanDays = Math.max(0, (last - first) / 86_400_000);

  if (exchanges >= FAMILIARITY_RULES.REGULAR.exchanges && spanDays >= FAMILIARITY_RULES.REGULAR.spanDays) {
    return 'REGULAR';
  }
  if (exchanges >= FAMILIARITY_RULES.FAMILIAR.exchanges && spanDays >= FAMILIARITY_RULES.FAMILIAR.spanDays) {
    return 'FAMILIAR';
  }
  if (exchanges >= FAMILIARITY_RULES.KNOWN.exchanges) return 'KNOWN';
  return 'NEW';
}
