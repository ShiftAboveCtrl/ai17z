import { z } from 'zod';

/**
 * Easy Mode: the eleven decisions somebody actually has to make.
 *
 * This is not a second configuration system. It is a small vocabulary that
 * projects onto the same versioned persona, policy, and cadence documents the
 * advanced screens edit, and reads back off them. There is one runtime, one set
 * of config objects, and one source of truth; Easy Mode is a view.
 *
 * Two properties follow, and both are tested:
 *
 *   - configure in Easy Mode, open Advanced, and you see what it configured
 *   - configure in Advanced, open Easy, and it either shows the equivalent
 *     answers or says plainly which settings it cannot represent
 *
 * The second is the one that keeps it honest. Easy Mode never silently
 * overwrites a deliberate advanced choice to make itself fit.
 */

/** Who gets an answer. */
export const EasyAudience = z.enum([
  /** Anything that mentions or replies to the agent. */
  'EVERYONE',
  /** The default: everyone, minus what is obviously not addressed to anybody. */
  'EXCEPT_SPAM',
  'VERIFIED_ONLY',
  /** Only the handles the owner listed. */
  'ALLOWLIST',
]);
export type EasyAudience = z.infer<typeof EasyAudience>;

/** How much the agent weighs up whether it has anything worth saying. */
export const EasySelectivity = z.enum(['ALMOST_EVERYTHING', 'BALANCED', 'ONLY_WHEN_USEFUL']);
export type EasySelectivity = z.infer<typeof EasySelectivity>;

export const EasyPostFrequency = z.enum(['OCCASIONALLY', 'FEW_PER_DAY', 'DAILY']);
export type EasyPostFrequency = z.infer<typeof EasyPostFrequency>;

/** Automatic, or prepare and wait. Two of the five real automation modes. */
export const EasyOperation = z.enum(['AUTOMATIC', 'REVIEW_FIRST']);
export type EasyOperation = z.infer<typeof EasyOperation>;

/**
 * A starting point for a voice, not a cage.
 *
 * Each preset writes real persona fields — tone, style guidance, response
 * length — which the owner can then edit freely. Editing them does not break
 * the preset; it makes it CUSTOM, which is the honest answer.
 */
export const EasyStylePreset = z.enum([
  'CONCISE',
  'CASUAL',
  'PROFESSIONAL',
  'WITTY',
  'TECHNICAL',
  'OPINIONATED',
  'FRIENDLY',
  'CUSTOM',
]);
export type EasyStylePreset = z.infer<typeof EasyStylePreset>;

/**
 * The reply filters Easy Mode offers as switches.
 *
 * Each maps to something real. None of them is a new mechanism invented for
 * Easy Mode; they are the engagement and content policies, named in words.
 */
export const EasyFilters = z.object({
  /** Obvious spam and noise. */
  spam: z.boolean().default(true),
  /** A post tagging many accounts at once is rarely addressed to any of them. */
  massTags: z.boolean().default(true),
  /** Do not answer the same person over and over in an hour. */
  repetition: z.boolean().default(true),
  /** Handles the owner has blocked. */
  blocked: z.boolean().default(true),
  /** Only accounts X has verified. */
  verifiedOnly: z.boolean().default(false),
  /** Ignore replies that do not name the agent. */
  directMentionsOnly: z.boolean().default(false),
  /** Watch the agent's own posts for replies. */
  repliesToOwnPosts: z.boolean().default(true),
  /** Watch conversations the agent is already part of. */
  repliesInConversations: z.boolean().default(true),
});
export type EasyFilters = z.infer<typeof EasyFilters>;

export const EasyCharacter = z.object({
  name: z.string().trim().min(1).max(120),
  /** One line, shown wherever the agent is listed. */
  description: z.string().max(500).default(''),
  personality: z.string().max(4_000).default(''),
  tone: z.string().max(1_000).default(''),
  /** What this character cares about. Becomes persona topics. */
  caresAbout: z.array(z.string().max(120)).max(40).default([]),
  /** How they normally speak. Becomes the style guidance. */
  speaksLike: z.string().max(4_000).default(''),
  /** Things this character would say. Becomes style examples and voice data. */
  examples: z.array(z.string().max(2_000)).max(50).default([]),
  preset: EasyStylePreset.default('CONCISE'),
});
export type EasyCharacter = z.infer<typeof EasyCharacter>;

export const EasyReplies = z.object({
  audience: EasyAudience.default('EXCEPT_SPAM'),
  selectivity: EasySelectivity.default('BALANCED'),
  filters: EasyFilters.default({}),
  /** Only consulted when audience is ALLOWLIST. */
  allowlist: z.array(z.string().max(120)).max(500).default([]),
});
export type EasyReplies = z.infer<typeof EasyReplies>;

export const EasyPosting = z.object({
  enabled: z.boolean().default(false),
  frequency: EasyPostFrequency.default('OCCASIONALLY'),
});
export type EasyPosting = z.infer<typeof EasyPosting>;

export const EasySetup = z.object({
  character: EasyCharacter,
  replies: EasyReplies.default({}),
  posting: EasyPosting.default({}),
  operation: EasyOperation.default('REVIEW_FIRST'),
});
export type EasySetup = z.infer<typeof EasySetup>;

/**
 * What Easy Mode makes of an agent that already exists.
 *
 * `beyondEasyMode` is the important field. When an advanced screen has set
 * something Easy Mode has no word for, it is listed here in plain language and
 * the Easy screens say so rather than pretending the agent is simpler than it
 * is. Saving from Easy Mode then leaves those settings alone.
 */
export const EasyView = z.object({
  setup: EasySetup,
  /** True when every setting on the agent is expressible in Easy Mode. */
  exact: z.boolean(),
  beyondEasyMode: z.array(z.string().max(300)).default([]),
});
export type EasyView = z.infer<typeof EasyView>;
