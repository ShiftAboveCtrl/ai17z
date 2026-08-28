import { z } from 'zod';

/**
 * How the agent writes, as measurable quantities.
 *
 * The point is provider independence. "Tone: dry" is a label a model interprets
 * differently every time and differently between providers; "median reply 54
 * characters, questions 8%, fragments common" is a target that can be measured
 * against and does not drift when the model behind it changes.
 *
 * Everything here is derived from actual samples and carries its provenance,
 * because a fingerprint asserted rather than measured is just a label again.
 */
export const VoiceFingerprint = z.object({
  /** Number of samples this was derived from. Under ~20 it is not much. */
  sampleCount: z.number().int().min(0).default(0),

  // ── Length ────────────────────────────────────────────────────────────────
  medianChars: z.number().int().min(0).default(0),
  p90Chars: z.number().int().min(0).default(0),
  medianSentences: z.number().min(0).default(1),
  medianWordsPerSentence: z.number().min(0).default(0),

  // ── Habits, as proportions of samples ─────────────────────────────────────
  questionRate: z.number().min(0).max(1).default(0),
  exclamationRate: z.number().min(0).max(1).default(0),
  emojiRate: z.number().min(0).max(1).default(0),
  hashtagRate: z.number().min(0).max(1).default(0),
  linkRate: z.number().min(0).max(1).default(0),
  /** Sentences without a finite verb: "Not surprising." "Fair point." */
  fragmentRate: z.number().min(0).max(1).default(0),
  contractionRate: z.number().min(0).max(1).default(0),
  firstPersonRate: z.number().min(0).max(1).default(0),
  /** Proportion of samples that open with a capital letter. */
  capitalisedRate: z.number().min(0).max(1).default(1),
  ellipsisRate: z.number().min(0).max(1).default(0),
  dashRate: z.number().min(0).max(1).default(0),
  multiLineRate: z.number().min(0).max(1).default(0),

  /** Words this agent uses noticeably more than ordinary prose would. */
  characteristicWords: z.array(z.string()).max(40).default([]),
  /** How replies typically begin. Not phrases to reuse; shapes to match. */
  typicalOpeners: z.array(z.string()).max(12).default([]),

  derivedAt: z.string().nullable().default(null),
  /** Where the samples came from, so a bad fingerprint can be traced. */
  sources: z.array(z.string()).max(20).default([]),
});
export type VoiceFingerprint = z.infer<typeof VoiceFingerprint>;

export const emptyFingerprint = (): VoiceFingerprint => VoiceFingerprint.parse({});

/** One dimension's verdict, in words as well as numbers. */
export const VoiceDimension = z.object({
  name: z.string(),
  score: z.number().min(0).max(100),
  detail: z.string(),
});
export type VoiceDimension = z.infer<typeof VoiceDimension>;

export const VoiceMatch = z.object({
  /** 0–100. A heuristic, not a measurement of anything real. */
  score: z.number().min(0).max(100),
  dimensions: z.array(VoiceDimension).default([]),
  /** True when there were too few samples for the score to mean much. */
  lowConfidence: z.boolean().default(false),
});
export type VoiceMatch = z.infer<typeof VoiceMatch>;

/**
 * What the agent should not sound like.
 *
 * Kept as named registers rather than a phrase blacklist, because the problem
 * is a way of writing rather than a list of words. Custom phrases exist too,
 * for the ones an owner is tired of seeing.
 */
export const AVOIDED_REGISTERS = [
  'corporate',
  'customer_support',
  'essay',
  'chatbot',
  'marketing',
  'therapy',
] as const;
export const AvoidedRegister = z.enum(AVOIDED_REGISTERS);
export type AvoidedRegister = (typeof AVOIDED_REGISTERS)[number];

export const VoicePolicy = z.object({
  enabled: z.boolean().default(true),
  /** At or above this, the draft is accepted as it stands. */
  acceptAt: z.number().int().min(0).max(100).default(85),
  /** Between this and acceptAt, a cheap deterministic tidy-up is applied. */
  lightRewriteAt: z.number().int().min(0).max(100).default(70),
  /** Below lightRewriteAt, a model rewrites it — the only expensive path. */
  allowModelRewrite: z.boolean().default(true),
  /** Registers to steer away from. */
  avoid: z.array(AvoidedRegister).default(['corporate', 'customer_support', 'essay', 'chatbot']),
  avoidPhrases: z.array(z.string().max(200)).max(200).default([]),
  /** Above this, the draft reads as generic assistant prose and is rewritten. */
  genericRewriteAbove: z.number().int().min(0).max(100).default(50),
  /** Above this, the draft repeats the agent too closely and is rewritten. */
  repetitionRewriteAbove: z.number().int().min(0).max(100).default(80),
  /** Phrases the agent is allowed to reuse deliberately. */
  signaturePhrases: z.array(z.string().max(200)).max(50).default([]),
  /** Hours a signature phrase must rest before it can be used again. */
  signatureRestHours: z.number().int().min(0).max(24 * 30).default(48),
});
export type VoicePolicy = z.infer<typeof VoicePolicy>;

export const GenericScore = z.object({
  score: z.number().min(0).max(100),
  reasons: z.array(z.string()).default([]),
});
export type GenericScore = z.infer<typeof GenericScore>;

export const RepetitionScore = z.object({
  score: z.number().min(0).max(100),
  reason: z.string().nullable().default(null),
  /** What it resembles, so a person can judge whether it matters. */
  matched: z.string().nullable().default(null),
  matchedAt: z.string().nullable().default(null),
});
export type RepetitionScore = z.infer<typeof RepetitionScore>;

/** Everything the quality gate weighed, and what it decided. */
export const QualityReport = z.object({
  voice: VoiceMatch,
  generic: GenericScore,
  repetition: RepetitionScore,
  /** accept | light_rewrite | model_rewrite | review | discard */
  outcome: z.string(),
  reason: z.string(),
});
export type QualityReport = z.infer<typeof QualityReport>;
