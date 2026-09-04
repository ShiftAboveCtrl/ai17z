import { z } from 'zod';
import { IdentityKind } from './enums';

/**
 * A persona is versioned data, never source code. Everything the model is told
 * about who it is comes from here plus the policy layer.
 */
/**
 * How long each persona field may be, in one place.
 *
 * The schema below is built from these and the interface reads the same object,
 * so a counter cannot disagree with the rule that rejects the save. Before this
 * the numbers were literals inside the schema, and the only way for a person to
 * discover a limit was to write past it, press save, and be told the request
 * did not match the expected shape.
 */
export const PERSONA_LIMITS = {
  displayName: 120,
  biography: 20_000,
  personality: 4_000,
  tone: 1_000,
  styleGuidelines: 8_000,
  styleExample: 2_000,
  topic: 120,
  languagePolicy: 500,
  prohibitedBehavior: 500,
  customInstructions: 8_000,
  changeNote: 500,
} as const;

export const PersonaDraft = z.object({
  identityKind: IdentityKind.default('FICTIONAL'),
  /** Name the agent uses when speaking. May differ from the agent record name. */
  displayName: z.string().trim().min(1).max(PERSONA_LIMITS.displayName),
  biography: z.string().max(PERSONA_LIMITS.biography).default(''),
  personality: z.string().max(PERSONA_LIMITS.personality).default(''),
  tone: z.string().max(PERSONA_LIMITS.tone).default(''),
  styleGuidelines: z.string().max(PERSONA_LIMITS.styleGuidelines).default(''),
  /** Short verbatim samples of the voice. Injected as the STYLE layer. */
  styleExamples: z.array(z.string().max(PERSONA_LIMITS.styleExample)).max(500).default([]),
  topics: z.array(z.string().max(PERSONA_LIMITS.topic)).max(100).default([]),
  /**
   * Free-text language instruction, e.g. "Always reply in Simplified Chinese".
   * Empty means: mirror the language of the incoming message.
   */
  languagePolicy: z.string().max(PERSONA_LIMITS.languagePolicy).default(''),
  responseLength: z.enum(['TERSE', 'SHORT', 'MEDIUM', 'LONG', 'ADAPTIVE']).default('SHORT'),
  prohibitedBehaviors: z.array(z.string().max(PERSONA_LIMITS.prohibitedBehavior)).max(100).default([]),
  customInstructions: z.string().max(PERSONA_LIMITS.customInstructions).default(''),
  changeNote: z.string().max(PERSONA_LIMITS.changeNote).default(''),
});
export type PersonaDraft = z.infer<typeof PersonaDraft>;

export const PersonaVersion = PersonaDraft.extend({
  id: z.string().uuid(),
  personaId: z.string().uuid(),
  agentId: z.string().uuid(),
  version: z.number().int().positive(),
  createdAt: z.string(),
});
export type PersonaVersion = z.infer<typeof PersonaVersion>;
