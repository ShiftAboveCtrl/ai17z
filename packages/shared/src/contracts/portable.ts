import { z } from 'zod';
import { PersonaDraft } from './persona';
import { PolicyConfig } from './policy';

/**
 * An agent, written down so it can be moved.
 *
 * One format for three things -- duplicating an agent, exporting one, and
 * sharing a preset -- because three formats for the same idea is three things
 * to keep in step and two of them will drift. A preset is simply this document
 * with fewer sections filled in.
 *
 * The line that matters runs between configuration and runtime state.
 * Configuration is what somebody decided: a persona, a policy, which model role
 * does what, where documentation comes from. Runtime state is what happened: a
 * session, a browser profile, memories, relationships, what it has said. The
 * first is portable and the second is not, and it is not a matter of degree --
 * a shared preset carrying somebody's browser profile is a shared login.
 *
 * So the shape itself has nowhere to put a secret. There is no field for an API
 * key, a cookie, a token or a master key, and `exportedFieldsAreSafe` in the
 * tests walks the whole document looking for one. A future field that could
 * carry one has to be added deliberately, and that test fails when it is.
 */

/** Bumped when a change would make an older importer read this wrongly. */
export const PORTABLE_AGENT_VERSION = 1;

/**
 * Where a knowledge source's content lives, without the content.
 *
 * A PATH is meaningless on another machine and is exported anyway, because the
 * alternative -- dropping it -- loses the fact that the agent had documentation
 * at all. The importer says the path does not exist here rather than pretending
 * the source was never configured. A URL travels perfectly well, being the same
 * page wherever it is read from.
 */
export const PortableKnowledgeSource = z.object({
  name: z.string().max(200),
  kind: z.enum(['UPLOAD', 'PATH', 'TEXT', 'URL']),
  location: z.string().max(2_000).nullable().default(null),
  include: z.array(z.string().max(200)).max(50).default([]),
  enabled: z.boolean().default(true),
});
export type PortableKnowledgeSource = z.infer<typeof PortableKnowledgeSource>;

/**
 * Which model does what, by role, without which credential.
 *
 * The provider is named so an importer can say "this wants an Anthropic model
 * and you have none configured", and the credential is not, because a
 * credential belongs to an installation rather than to an agent.
 */
export const PortableModelRole = z.object({
  role: z.string().max(40),
  provider: z.string().max(40),
  model: z.string().max(200),
  parameters: z.record(z.unknown()).default({}),
});
export type PortableModelRole = z.infer<typeof PortableModelRole>;

export const PortableTool = z.object({
  key: z.string().max(120),
  enabled: z.boolean(),
  /**
   * Configuration that is not a secret: an allowlist of hosts, a limit.
   *
   * Anything key-shaped is stripped on export rather than trusted not to be
   * there, because a tool's config is a free-form document and somebody will
   * eventually put a token in one.
   */
  config: z.record(z.unknown()).default({}),
});
export type PortableTool = z.infer<typeof PortableTool>;

export const PortableAgent = z
  .object({
    /** The format, so an importer can refuse what it cannot read. */
    format: z.literal('ai17z-agent'),
    version: z.number().int().min(1),
    /** Written by whichever build exported it, for a human reading the file. */
    exportedBy: z.string().max(80).default(''),
    exportedAt: z.string().default(''),

    name: z.string().min(1).max(200),
    description: z.string().max(2_000).default(''),

    /** Everything about how it speaks and what it is. */
    persona: PersonaDraft,
    /** Everything about what it may do. */
    policy: PolicyConfig,

    /** How often it may act, and when it may not. */
    cadence: z.record(z.unknown()).nullable().default(null),
    /** Whether it posts of its own accord, and how often. */
    posting: z
      .object({
        enabled: z.boolean().default(false),
        intervalSeconds: z.number().int().default(21_600),
        jitterPercent: z.number().int().default(25),
      })
      .nullable()
      .default(null),

    models: z.array(PortableModelRole).max(20).default([]),
    tools: z.array(PortableTool).max(50).default([]),
    knowledge: z.array(PortableKnowledgeSource).max(50).default([]),

    /**
     * What the agent was allowed to do through an account, as capability names.
     *
     * Never an account, never a session. Importing these grants nothing on its
     * own: they describe an intended permission profile and are applied only
     * when somebody connects an account themselves.
     */
    capabilities: z.array(z.string().max(40)).max(20).default([]),
  })
  // Strict, so an unknown field is a refusal rather than something that rides
  // along into an installation nobody inspected.
  .strict();
export type PortableAgent = z.infer<typeof PortableAgent>;

/**
 * Names that must never appear as keys in an exported document.
 *
 * A denylist as a second line rather than the first: the shape above has no
 * field for any of these, so the only way one arrives is through a free-form
 * record, and those are the ones worth checking.
 */
export const NEVER_EXPORTED = [
  'apiKey',
  'api_key',
  'sealedApiKey',
  'sealed_api_key',
  'secret',
  'password',
  'token',
  'cookie',
  'cookies',
  'session',
  'masterKey',
  'master_key',
  'authorization',
  'credential',
  'credentials',
] as const;

/** Strips anything key-shaped out of a free-form configuration document. */
export function withoutSecrets(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    const lower = key.toLowerCase();
    if (NEVER_EXPORTED.some((banned) => lower.includes(banned.toLowerCase().replace(/_/g, '')) || lower === banned)) {
      continue;
    }
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value)
        ? withoutSecrets(value as Record<string, unknown>)
        : value;
  }
  return out;
}
