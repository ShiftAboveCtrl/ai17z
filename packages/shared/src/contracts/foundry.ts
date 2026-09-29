import { z } from 'zod';

/**
 * Agent Foundry: setting an agent up from research, as a proposal a person
 * reviews, against the settings the rest of AI17Z already has.
 *
 * Nothing here is a second persona, policy or belief store. A proposal item
 * names a setting that exists, says what it is now and what research suggests
 * it should be, cites the evidence, and waits. Applying it writes through the
 * same repositories the Advanced screens use, as a new version, with an audit
 * row, so every Foundry change is undoable the way every other change is.
 */

/** What the owner asked for, in their words and in the fields read from them. */
export const FoundryBrief = z
  .object({
    /** The owner's own words. Kept verbatim; never becomes a prompt of its own. */
    text: z.string().trim().max(4_000).default(''),
    /** The account the persona is modelled on, without the @. */
    handle: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_]{1,15}$/, 'A handle is letters, numbers and underscores, up to fifteen.')
      .nullable()
      .default(null),
    /** Subjects the agent should know properly, such as a project. */
    projects: z.array(z.string().trim().min(1).max(60)).max(6).default([]),
    /** Addresses the owner already knows are authoritative. */
    urls: z.array(z.string().trim().url().max(500)).max(12).default([]),
    /**
     * Whether the agent represents the person or is only modelled on them.
     *
     * MODELED_AFTER is the default and the safe one: the agent writes the way
     * they do and never claims to be them. AUTHORIZED_AS is the owner saying the
     * account and the voice are theirs to speak for.
     */
    relationship: z.enum(['MODELED_AFTER', 'AUTHORIZED_AS']).default('MODELED_AFTER'),
    /** How much the agent may do on its own. Conservative unless asked. */
    autonomy: z.enum(['CONSERVATIVE', 'SELECTIVE', 'ACTIVE']).default('CONSERVATIVE'),
    /** Whether optional public mirrors (TwStalker, Sotwe) may be asked. */
    useMirrors: z.boolean().default(true),
  })
  .strict();
export type FoundryBrief = z.infer<typeof FoundryBrief>;

/** The sections a proposal is reviewed in, in the order they are shown. */
export const FOUNDRY_SECTIONS = [
  'IDENTITY',
  'STYLE',
  'MUST_NEVER',
  'INSTRUCTIONS',
  'TOPICS',
  'BELIEFS',
  'KNOWLEDGE',
  'PERSONA_SOURCES',
  'RADAR',
  'CAPABILITIES',
  'AUTONOMY',
  'LANGUAGE',
  'LEARNING',
  'TESTS',
] as const;
export const FoundrySection = z.enum(FOUNDRY_SECTIONS);
export type FoundrySection = (typeof FOUNDRY_SECTIONS)[number];

export const FOUNDRY_SECTION_LABELS: Record<FoundrySection, string> = {
  IDENTITY: 'Identity',
  STYLE: 'Style guidelines',
  MUST_NEVER: 'Must never',
  INSTRUCTIONS: 'Additional instructions',
  TOPICS: 'Interests and topics',
  BELIEFS: 'Beliefs and stances',
  KNOWLEDGE: 'Knowledge sources',
  PERSONA_SOURCES: 'Persona sources',
  RADAR: 'Social Radar',
  CAPABILITIES: 'Capabilities and Plugins',
  AUTONOMY: 'Autonomy and cadence',
  LANGUAGE: 'Language',
  LEARNING: 'Learning',
  TESTS: 'Response Lab tests',
};

export const FOUNDRY_ITEM_STATUSES = ['PROPOSED', 'ACCEPTED', 'EDITED', 'REJECTED', 'APPLIED', 'SUPERSEDED'] as const;
export type FoundryItemStatus = (typeof FOUNDRY_ITEM_STATUSES)[number];

/**
 * What improving an existing agent found, per setting.
 *
 * An existing agent's owner made choices; this says how each compares with
 * the research, and never changes one without a person accepting it.
 */
export const FOUNDRY_ASSESSMENTS = ['ALREADY_CORRECT', 'MISSING', 'WEAK', 'STALE', 'CONTRADICTORY', 'UNSUPPORTED', 'NEW'] as const;
export type FoundryAssessment = (typeof FOUNDRY_ASSESSMENTS)[number];

/** A Foundry run's stages, each committed before the next starts. */
export const FOUNDRY_STAGES = [
  'UNDERSTANDING',
  'FINDING_SOURCES',
  'READING_X',
  'SECONDARY_SOURCES',
  'DEDUPLICATING',
  'VOICE',
  'TOPICS',
  'BELIEFS',
  'KNOWLEDGE',
  'SAFETY',
  'TESTS',
  'READY',
] as const;
export type FoundryStage = (typeof FOUNDRY_STAGES)[number];

/** What each stage is called on screen, as the thing being done. */
export const FOUNDRY_STAGE_LABELS: Record<FoundryStage, string> = {
  UNDERSTANDING: 'Understanding the request',
  FINDING_SOURCES: 'Finding primary sources',
  READING_X: 'Reading posts and replies on X',
  SECONDARY_SOURCES: 'Using secondary reconstruction sources',
  DEDUPLICATING: 'Deduplicating and confirming evidence',
  VOICE: 'Building the voice profile',
  TOPICS: 'Building the topic profile',
  BELIEFS: 'Extracting possible beliefs',
  KNOWLEDGE: 'Building the knowledge proposal',
  SAFETY: 'Writing safety rules',
  TESTS: 'Creating behavioural tests',
  READY: 'Ready for review',
};

/** One piece of evidence an item rests on, as the owner inspects it. */
export const FoundryEvidence = z.object({
  objectId: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  excerpt: z.string().max(600),
  family: z.string().nullable().default(null),
  tier: z.string().nullable().default(null),
  publishedAt: z.string().nullable().default(null),
});
export type FoundryEvidence = z.infer<typeof FoundryEvidence>;

/** A proposed change to one existing setting. */
export const FoundryItem = z.object({
  section: FoundrySection,
  /** Stable within a run: the same item proposed twice is one item. */
  key: z.string().min(1).max(200),
  title: z.string().max(300),
  /** What the setting is now. Null when there is nothing there. */
  current: z.unknown().nullable(),
  /** What research suggests. */
  proposed: z.unknown(),
  /** Why, in a sentence the owner reads. Never "AI optimised it". */
  rationale: z.string().max(1_200),
  confidence: z.number().min(0).max(1),
  evidence: z.array(FoundryEvidence).max(12).default([]),
  counterEvidence: z.array(FoundryEvidence).max(12).default([]),
  assessment: z.enum(FOUNDRY_ASSESSMENTS).default('NEW'),
});
export type FoundryItem = z.infer<typeof FoundryItem>;

/**
 * Reads the fields a brief implies from the owner's own sentence.
 *
 * Deterministic: a handle is an @word, an address is an address, "selective"
 * and "conservative" mean what they say. Projects are the capitalised names
 * the sentence asks the agent to understand. Anything it cannot read is left
 * for the owner to fill in on the plan screen, which is the point of showing a
 * plan before anything runs.
 */
export function readBrief(text: string): Partial<FoundryBrief> {
  const out: Partial<FoundryBrief> = { text: text.trim().slice(0, 4_000) };
  const handle = text.match(/@([A-Za-z0-9_]{1,15})\b/);
  if (handle) out.handle = handle[1]!;
  const urls = [...text.matchAll(/https?:\/\/[^\s<>"')]+/g)].map((m) => m[0]!.replace(/[.,;]+$/, ''));
  if (urls.length > 0) out.urls = [...new Set(urls)].slice(0, 12);
  if (/\b(autonomous|on its own|fully automatic|active)\b/i.test(text)) out.autonomy = 'ACTIVE';
  if (/\b(selective|selectively)\b/i.test(text)) out.autonomy = 'SELECTIVE';
  if (/\b(conservative|careful|cautious|review everything|ask me first)\b/i.test(text)) out.autonomy = 'CONSERVATIVE';
  if (/\b(it is me|is me|my own account|speak for me|as me|i authori[sz]e)\b/i.test(text)) out.relationship = 'AUTHORIZED_AS';

  // "understand Pons and Robinhood Chain", "know everything about Pons".
  const projects = new Set<string>();
  for (const m of text.matchAll(/\b(?:understand|know(?: everything)? about|expert (?:on|in)|about|teach it)\s+((?:[A-Z][\w.-]*(?:\s+(?:and\s+)?)?){1,6})/g)) {
    // A name ends where its sentence does: "Robinhood Chain. Keep it selective".
    const clause = m[1]!.split(/[.!?;:]/)[0]!;
    for (const name of clause.split(/\s+and\s+|,/)) {
      const clean = name.trim().replace(/[.,;:]+$/, '');
      if (/^[A-Z]/.test(clean) && clean.length >= 2 && !/^(It|The|My|This|That|X)$/.test(clean)) projects.add(clean);
    }
  }
  if (projects.size > 0) out.projects = [...projects].slice(0, 6);
  return out;
}
