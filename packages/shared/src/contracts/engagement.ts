import { z } from 'zod';

/**
 * What social act a reply performs.
 *
 * Deciding this before generating is what stops an agent answering a joke with
 * an explanation, or treating a challenge as a request for information.
 */
export const RESPONSE_INTENTS = [
  'ANSWER',
  'ACKNOWLEDGE',
  'AGREE',
  'DISAGREE',
  'CLARIFY',
  'EXPAND',
  'JOKE',
  'CHALLENGE',
  'ASK',
  'THANK',
  'DEFLECT',
  'CALLBACK',
  'CORRECT',
  'IGNORE',
] as const;
export const ResponseIntent = z.enum(RESPONSE_INTENTS);
export type ResponseIntent = (typeof RESPONSE_INTENTS)[number];

/** What the agent decided to do about an incoming event. */
export const ENGAGEMENT_DECISIONS = ['ENGAGE', 'IGNORE', 'REVIEW'] as const;
export const EngagementDecision = z.enum(ENGAGEMENT_DECISIONS);
export type EngagementDecision = (typeof ENGAGEMENT_DECISIONS)[number];

/**
 * How selective the agent is.
 *
 * Not one strategy imposed on everybody: an agent that answers every mention
 * and one that only answers direct questions are both legitimate, and which is
 * right depends on what the agent is for.
 */
export const ENGAGEMENT_STRATEGIES = [
  /** Anything that mentions the agent gets an answer. */
  'ALWAYS_REPLY',
  /** Weigh it up. The default. */
  'SELECTIVE',
  /** Only things that actually ask something. */
  'QUESTIONS_ONLY',
  /** Weigh it up, but never stay silent without asking a person first. */
  'NEVER_AUTO_IGNORE',
] as const;
export const EngagementStrategy = z.enum(ENGAGEMENT_STRATEGIES);
export type EngagementStrategy = (typeof ENGAGEMENT_STRATEGIES)[number];

export const EngagementPolicy = z.object({
  strategy: EngagementStrategy.default('SELECTIVE'),
  /** Below this a mention is not worth answering. 0–100. */
  minimumReplyValue: z.number().int().min(0).max(100).default(35),
  /** A post that tags many accounts at once is rarely addressed to any of them. */
  ignoreMassTags: z.boolean().default(true),
  massTagThreshold: z.number().int().min(2).max(50).default(5),
  /** Do not answer the same person more than this many times in an hour. */
  maxRepliesPerPersonPerHour: z.number().int().min(1).max(50).default(3),
  /** Answer somebody the agent has already replied to in this thread. */
  allowThreadFollowUps: z.boolean().default(true),
  maxThreadDepth: z.number().int().min(1).max(50).default(6),
});
export type EngagementPolicy = z.infer<typeof EngagementPolicy>;

/** One thing that pushed the score up or down, in words. */
export const ValueFactor = z.object({
  label: z.string(),
  delta: z.number().int(),
});
export type ValueFactor = z.infer<typeof ValueFactor>;

/**
 * Why the agent did or did not reply.
 *
 * The reasons matter more than the number. "Reply value 18" tells nobody
 * anything; "mass tag with no direct question" tells them whether the decision
 * was right.
 */
export const EngagementVerdict = z.object({
  decision: EngagementDecision,
  value: z.number().int().min(0).max(100),
  reason: z.string(),
  factors: z.array(ValueFactor).default([]),
});
export type EngagementVerdict = z.infer<typeof EngagementVerdict>;

/** How an incoming message reads. A context signal, not a judgement. */
export const CONVERSATION_TEMPERATURES = [
  'technical',
  'casual',
  'friendly',
  'joking',
  'sarcastic',
  'hostile',
  'curious',
  'serious',
  'confused',
] as const;
export const ConversationTemperature = z.enum(CONVERSATION_TEMPERATURES);
export type ConversationTemperature = (typeof CONVERSATION_TEMPERATURES)[number];

/**
 * How much the agent takes on the tone it is met with.
 *
 * Hostility is near zero by default and deliberately so: matching hostility is
 * how an agent ends up in a fight on its owner's behalf.
 */
export const ToneMirroring = z.object({
  technical: z.number().min(0).max(1).default(0.8),
  casual: z.number().min(0).max(1).default(0.7),
  humour: z.number().min(0).max(1).default(0.45),
  hostility: z.number().min(0).max(1).default(0.05),
});
export type ToneMirroring = z.infer<typeof ToneMirroring>;

export const IntentDecision = z.object({
  intent: ResponseIntent,
  /** A sentence saying why, shown in the trace. */
  reason: z.string(),
  temperature: ConversationTemperature,
});
export type IntentDecision = z.infer<typeof IntentDecision>;
