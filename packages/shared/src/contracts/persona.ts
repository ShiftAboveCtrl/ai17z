import { z } from 'zod';
import { IdentityKind } from './enums';

/**
 * A persona is versioned data, never source code. Everything the model is told
 * about who it is comes from here plus the policy layer.
 */
export const PersonaDraft = z.object({
  identityKind: IdentityKind.default('FICTIONAL'),
  /** Name the agent uses when speaking. May differ from the agent record name. */
  displayName: z.string().trim().min(1).max(120),
  biography: z.string().max(20_000).default(''),
  personality: z.string().max(4_000).default(''),
  tone: z.string().max(1_000).default(''),
  styleGuidelines: z.string().max(8_000).default(''),
  /** Short verbatim samples of the voice. Injected as the STYLE layer. */
  styleExamples: z.array(z.string().max(2_000)).max(500).default([]),
  topics: z.array(z.string().max(120)).max(100).default([]),
  /**
   * Free-text language instruction, e.g. "Always reply in Simplified Chinese".
   * Empty means: mirror the language of the incoming message.
   */
  languagePolicy: z.string().max(500).default(''),
  responseLength: z.enum(['TERSE', 'SHORT', 'MEDIUM', 'LONG', 'ADAPTIVE']).default('SHORT'),
  prohibitedBehaviors: z.array(z.string().max(500)).max(100).default([]),
  customInstructions: z.string().max(8_000).default(''),
  changeNote: z.string().max(500).default(''),
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
