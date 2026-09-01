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
 * What each preset actually writes into the persona.
 *
 * This is the wording the model is given, not a label for it. It lives here
 * rather than in the runtime because the setup screen shows it: if somebody
 * picks "Dry", they should be able to read the sentence that produces dry, and
 * a blurb written separately from the instruction drifts from it within a
 * release or two.
 *
 * `length` is the response-length band, which does more work than any adjective:
 * a model told to be concise and given four hundred characters will use them.
 */
export const EASY_STYLE_PRESETS: Record<
  Exclude<EasyStylePreset, 'CUSTOM'>,
  { label: string; blurb: string; tone: string; style: string; length: 'TERSE' | 'SHORT' | 'MEDIUM' }
> = {
  CONCISE: {
    label: 'Concise',
    blurb: 'Says the thing and stops.',
    tone: 'Direct and unhurried. Says the thing and stops.',
    style: 'One or two sentences. No preamble, no summary of the question, no sign-off.',
    length: 'TERSE',
  },
  CASUAL: {
    label: 'Casual',
    blurb: 'Talks the way you would to someone you know.',
    tone: 'Relaxed and conversational, the way you would talk to someone you know.',
    style: 'Short sentences, contractions, no corporate register. Plain words over precise ones.',
    length: 'SHORT',
  },
  PROFESSIONAL: {
    label: 'Professional',
    blurb: 'Measured, courteous, no slang.',
    tone: 'Measured and courteous. Confident without being emphatic.',
    style: 'Complete sentences, no slang, no exclamation marks. Answer first, qualify after.',
    length: 'SHORT',
  },
  WITTY: {
    label: 'Witty',
    blurb: 'Dry. Never explains the joke.',
    tone: 'Dry. Amused by things without announcing that it is joking.',
    style:
      'Understatement over punchlines. Never explain the joke, and never make one at the expense of the person asking.',
    length: 'TERSE',
  },
  TECHNICAL: {
    label: 'Technical',
    blurb: 'Precise, comfortable with detail.',
    tone: 'Precise. Comfortable with detail and unwilling to round it off.',
    style: 'Name things exactly. Give the number or say there is not one. No analogies where the real mechanism fits.',
    length: 'MEDIUM',
  },
  OPINIONATED: {
    label: 'Opinionated',
    blurb: 'Takes a position in the first sentence.',
    tone: 'Has a view and says it, without needing agreement.',
    style:
      'Take a position in the first sentence. Give the reason in the second. Do not hedge with "it depends" unless it genuinely does.',
    length: 'SHORT',
  },
  FRIENDLY: {
    label: 'Friendly',
    blurb: 'Warm, and interested in the person.',
    tone: 'Warm and open. Interested in the person, not only the question.',
    style: 'Answer the question, then leave a door open. No effusiveness.',
    length: 'SHORT',
  },
};


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

/**
 * How much emoji, in the words somebody would use.
 *
 * A real question, not a nicety: a model left to itself decorates every
 * sentence, and an account that does that reads as a bot to everyone who sees
 * it. Maps straight onto the enforced output policy.
 */
export const EasyEmoji = z.object({
  use: z.enum(['NONE', 'MINIMAL', 'SELECTED', 'UNRESTRICTED']).default('MINIMAL'),
  /** Only consulted when `use` is SELECTED. */
  allowed: z.array(z.string().max(16)).max(60).default([]),
  maxPerMessage: z.number().int().min(0).max(20).default(1),
  /** Roughly what share of messages may carry one at all. */
  messagesPercent: z.number().int().min(0).max(100).default(25),
});
export type EasyEmoji = z.infer<typeof EasyEmoji>;

/**
 * Which language to answer in.
 *
 * Not a nicety either. With no rule an agent mirrors whatever it is written to,
 * so an English account replies in Polish to a Polish post and in Hindi to a
 * Hindi one — correct behaviour that surprises everybody the first time they
 * see it, and is invisible unless somebody thought to look in Advanced.
 */
export const EasyLanguage = z.enum([
  /** Answer in whatever language the message was written in. */
  'MIRROR',
  'ENGLISH',
  /** Something else, written out. */
  'CUSTOM',
]);
export type EasyLanguage = z.infer<typeof EasyLanguage>;

export const EasySetup = z.object({
  character: EasyCharacter,
  emoji: EasyEmoji.default({}),
  language: EasyLanguage.default('MIRROR'),
  /** Only read when `language` is CUSTOM. */
  languageDetail: z.string().max(200).default(''),
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

/**
 * The questions a character needs answered before it is worth running.
 *
 * One list, three ways in: typed by hand, filled by a model from a description,
 * or brought back on a filled-in template. All three land here, so a character
 * built by any of them is the same shape and the same depth — and so the
 * template a person hands to another assistant is generated from this list
 * rather than written twice and drifting.
 *
 * `weight` is how much a missing answer hurts. It drives the completeness score
 * so somebody can see they have described a voice but not what it cares about.
 */
export const CHARACTER_QUESTIONS = [
  {
    key: 'name',
    weight: 3,
    ask: 'What is this character called?',
    why: 'The name it speaks under.',
  },
  {
    key: 'description',
    weight: 2,
    ask: 'In one line, who are they?',
    why: 'Shown wherever the agent is listed.',
  },
  {
    key: 'personality',
    weight: 3,
    ask: 'What are they like? Temperament, what amuses them, what irritates them.',
    why: 'The single biggest influence on how a reply reads.',
  },
  {
    key: 'tone',
    weight: 2,
    ask: 'How do they sound? Warm, dry, blunt, formal.',
    why: 'Sets the register of every sentence.',
  },
  {
    key: 'caresAbout',
    weight: 3,
    ask: 'What do they actually care about? Five to ten subjects.',
    why: 'Decides what is worth replying to and what is noise.',
  },
  {
    key: 'speaksLike',
    weight: 3,
    ask: 'How do they construct a sentence? Length, punctuation, slang, whether they hedge.',
    why: 'The mechanics of the voice, as opposed to its mood.',
  },
  {
    key: 'examples',
    weight: 4,
    ask: 'Write five things they would actually say. Real sentences, not descriptions.',
    why: 'Worth more than every other answer combined. A model imitates examples; it only approximates adjectives.',
  },
  {
    key: 'opinions',
    weight: 2,
    ask: 'What do they believe that others argue with? Two or three positions.',
    why: 'An agent with no positions hedges everything and reads as a press release.',
  },
  {
    key: 'avoids',
    weight: 2,
    ask: 'What would they never say or do?',
    why: 'Becomes the prohibited-behaviour list, which is enforced.',
  },
  {
    key: 'audience',
    weight: 1,
    ask: 'Who are they talking to?',
    why: 'Changes how much is assumed and how much is explained.',
  },
] as const;

export type CharacterQuestionKey = (typeof CHARACTER_QUESTIONS)[number]['key'];

/** What a model, a template, or a person fills in. */
export const CharacterAnswers = z.object({
  name: z.string().max(120).default(''),
  description: z.string().max(500).default(''),
  personality: z.string().max(4_000).default(''),
  tone: z.string().max(1_000).default(''),
  caresAbout: z.array(z.string().max(120)).max(40).default([]),
  speaksLike: z.string().max(4_000).default(''),
  examples: z.array(z.string().max(2_000)).max(50).default([]),
  opinions: z.array(z.string().max(500)).max(20).default([]),
  avoids: z.array(z.string().max(500)).max(20).default([]),
  audience: z.string().max(500).default(''),
});
export type CharacterAnswers = z.infer<typeof CharacterAnswers>;

/** How complete a set of answers is, and what is still missing. */
export const CharacterCompleteness = z.object({
  /** 0-100, weighted by how much each answer matters. */
  score: z.number().int().min(0).max(100),
  missing: z.array(z.object({ key: z.string(), ask: z.string(), why: z.string() })).default([]),
});
export type CharacterCompleteness = z.infer<typeof CharacterCompleteness>;

/** Where a set of answers came from. Recorded, because provenance matters. */
export const CharacterSource = z.enum(['TYPED', 'DESCRIBED', 'TEMPLATE', 'LEARNED']);
export type CharacterSource = z.infer<typeof CharacterSource>;
