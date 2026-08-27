import { z } from 'zod';

/**
 * How the agent stands on something.
 *
 * Five coarse values rather than a numeric scale. A stance is a thing a person
 * could state out loud, and "0.63 positive" is not; the confidence field
 * carries strength separately, where it belongs.
 */
export const STANCE_POSITIONS = ['POSITIVE', 'NEGATIVE', 'MIXED', 'NEUTRAL', 'UNCERTAIN'] as const;
export const StancePosition = z.enum(STANCE_POSITIONS);
export type StancePosition = (typeof STANCE_POSITIONS)[number];

export const STANCE_STATUSES = ['ACTIVE', 'SUPERSEDED', 'RETIRED'] as const;
export const StanceStatus = z.enum(STANCE_STATUSES);
export type StanceStatus = (typeof STANCE_STATUSES)[number];

/** What to do when a candidate reply contradicts a position already held. */
export const STANCE_CONFLICT_POLICIES = [
  /** Rewrite the reply so it does not contradict what was said before. */
  'REWRITE',
  /** Stop and ask a person. The safe default for a firmly held position. */
  'REVIEW',
  /** Let it through and record that the position moved. */
  'ALLOW_AND_REVISE',
  /** Do not check at all. */
  'IGNORE',
] as const;
export const StanceConflictPolicy = z.enum(STANCE_CONFLICT_POLICIES);
export type StanceConflictPolicy = (typeof STANCE_CONFLICT_POLICIES)[number];

export const StancePolicy = z.object({
  enabled: z.boolean().default(true),
  /**
   * Below this, a contradiction is a developing view rather than a conflict.
   * An agent that has said something once, hedged, should be free to move.
   */
  conflictThreshold: z.number().min(0).max(1).default(0.6),
  onConflict: StanceConflictPolicy.default('REVIEW'),
  /** Record new positions from what the agent says, rather than only by hand. */
  learnFromOwnPosts: z.boolean().default(true),
  /** Detect and store predictions and promises. */
  trackPredictions: z.boolean().default(true),
  trackCommitments: z.boolean().default(true),
});
export type StancePolicy = z.infer<typeof StancePolicy>;

export const StanceEvidence = z.object({
  id: z.string().uuid(),
  kind: z.enum(['said', 'observed', 'told_by_owner', 'imported']),
  excerpt: z.string(),
  remoteUrl: z.string().nullable(),
  createdAt: z.string(),
});
export type StanceEvidence = z.infer<typeof StanceEvidence>;

export const Stance = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  subject: z.string(),
  subjectKey: z.string(),
  position: StancePosition,
  summary: z.string(),
  confidence: z.number(),
  status: StanceStatus,
  supersededBy: z.string().uuid().nullable(),
  pinned: z.boolean(),
  createdAt: z.string(),
  lastReinforcedAt: z.string(),
});
export type Stance = z.infer<typeof Stance>;

/** What the prompt is told about positions relevant to this conversation. */
export const StanceContext = z.object({
  relevant: z
    .array(
      z.object({
        subject: z.string(),
        position: StancePosition,
        summary: z.string(),
        confidence: z.number(),
        heldSince: z.string(),
      }),
    )
    .default([]),
  /** Positions the agent has publicly changed, so it can acknowledge doing so. */
  revised: z
    .array(z.object({ subject: z.string(), from: z.string(), to: z.string(), changedAt: z.string() }))
    .default([]),
});
export type StanceContext = z.infer<typeof StanceContext>;

/**
 * Normalises a subject for lookup.
 *
 * Deliberately blunt: strips punctuation, articles and casing so "Project Q",
 * "project q" and "the Project Q token" all land on the same row. Getting this
 * wrong in the lenient direction merges two subjects, which is visible and
 * fixable; getting it wrong in the strict direction silently creates a second
 * contradictory stance, which is the thing being prevented.
 */
export function subjectKey(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(the|a|an|of|for|on|about)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whether two positions are actually incompatible. */
export function positionsConflict(held: StancePosition, candidate: StancePosition): boolean {
  if (held === candidate) return false;
  // Only a straight reversal counts. Moving from firm to hedged, or from
  // nothing to something, is a view developing rather than contradicting itself.
  const opposites: Record<string, string> = { POSITIVE: 'NEGATIVE', NEGATIVE: 'POSITIVE' };
  return opposites[held] === candidate;
}
