/**
 * Moving an agent: exporting it, importing it, and copying it.
 *
 * All three are the same operation with different endpoints, so they share one
 * document rather than three. Duplication is an export followed by an import
 * that never touches a file, which means the thing most likely to leak a secret
 * -- copying an agent within an installation, where every secret is right there
 * and easy to bring along -- goes through the same stripping as the thing
 * everybody worries about.
 *
 * The line runs between what somebody decided and what happened. A persona, a
 * policy, which model role does what: decided, and portable. A session, a
 * browser profile, a memory, a relationship, what it has already said: happened,
 * and not. That is not a matter of degree. A duplicated agent inheriting the
 * original's relationships would be an agent that believes it has met people it
 * has never spoken to.
 */
import type { PortableAgent, PortableTool } from '@xbam/shared/contracts';
import { PORTABLE_AGENT_VERSION, PersonaDraft, PolicyConfig, PortableAgent as PortableAgentSchema, withoutSecrets } from '@xbam/shared/contracts';
import { BadRequestError, describeVersion, nowIso, slugify } from '@xbam/shared';
import {
  agents as agentsRepo,
  knowledge as knowledgeRepo,
  ops as opsRepo,
  posting as postingRepo,
  providers as providersRepo,
} from '@xbam/database';

/**
 * Writes an agent down.
 *
 * Everything here is configuration. Nothing reads a credential, a session, a
 * memory or a relationship -- not because they are filtered afterwards, but
 * because the queries that would fetch them are not made.
 */
export async function exportAgent(agentId: string): Promise<PortableAgent> {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent) throw new BadRequestError('That agent no longer exists.');

  const [persona, policy, models, tools, knowledge, cadence, posting] = await Promise.all([
    agentsRepo.getActivePersona(agentId),
    agentsRepo.getActivePolicy(agentId),
    providersRepo.listModelConfigs(agentId),
    opsRepo.listAgentTools(agentId),
    knowledgeRepo.listSources(agentId).catch(() => []),
    // Cadence belongs to an account rather than an agent, and an export
    // carries no account -- so there is nothing here to carry. Said rather
    // than quietly omitted.
    Promise.resolve(null),
    postingRepo.getSchedule(agentId).catch(() => null),
  ]);

  if (!persona) throw new BadRequestError('That agent has no persona, so there is nothing to export.');

  return PortableAgentSchema.parse({
    format: 'ai17z-agent',
    version: PORTABLE_AGENT_VERSION,
    exportedBy: describeVersion(),
    exportedAt: nowIso(),
    name: agent.name,
    description: agent.description ?? '',
    persona: PersonaDraft.parse({ ...persona, changeNote: '' }),
    policy: PolicyConfig.parse(policy?.config ?? {}),
    cadence: cadence ? (withoutSecrets(cadence as Record<string, unknown>) as Record<string, unknown>) : null,
    posting: posting
      ? { enabled: posting.enabled, intervalSeconds: posting.intervalSeconds, jitterPercent: posting.jitterPercent }
      : null,
    // The provider is named and the credential is not: a credential belongs to
    // an installation, and naming the provider is what lets an importer say
    // "this wants an Anthropic model and you have none".
    models: models.map((row: { role: string; provider?: string | null; model: string; parameters?: unknown }) => ({
      role: row.role,
      provider: row.provider ?? 'unknown',
      model: row.model,
      parameters: (row.parameters ?? {}) as Record<string, unknown>,
    })),
    tools: tools.map(
      (tool: { key: string; enabled: boolean; config?: Record<string, unknown> | null }): PortableTool => ({
        key: tool.key,
        enabled: tool.enabled,
        // A tool's config is free-form, so somebody will eventually put a token
        // in one. Stripped rather than trusted.
        config: withoutSecrets(tool.config ?? {}),
      }),
    ),
    knowledge: knowledge.map((source: { name: string; kind: string; location: string | null; include?: string[]; enabled: boolean }) => ({
      name: source.name,
      kind: source.kind as 'UPLOAD' | 'PATH' | 'TEXT' | 'URL',
      location: source.location,
      include: source.include ?? [],
      enabled: source.enabled,
    })),
    capabilities: [],
  });
}

export interface ImportReport {
  agentId: string;
  /** What could not be carried over, said plainly rather than silently dropped. */
  notes: string[];
}

/**
 * Reads an agent in, as a new one.
 *
 * Always a new identity. Importing something that claimed an existing agent's
 * id would let a shared file overwrite an agent somebody had spent a week on,
 * which is why the document carries no id at all.
 */
export async function importAgent(input: {
  ownerId: string;
  document: unknown;
  /** Overrides the name in the document, for a copy alongside the original. */
  name?: string;
  createdBy?: string | null;
}): Promise<ImportReport> {
  const parsed = PortableAgentSchema.safeParse(input.document);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new BadRequestError(
      `This is not an agent file this version can read: ${first?.path.join('.') || 'the document'} ${first?.message ?? 'is wrong'}.`,
    );
  }
  const doc = parsed.data;

  if (doc.version > PORTABLE_AGENT_VERSION) {
    throw new BadRequestError(
      `This agent was exported by a newer AI17Z (format version ${doc.version}; this one reads ${PORTABLE_AGENT_VERSION}). Update before importing it.`,
    );
  }

  const notes: string[] = [];
  const name = input.name?.trim() || doc.name;

  const agent = await agentsRepo.createAgent({
    ownerId: input.ownerId,
    name,
    slug: `${slugify(name)}-${Date.now().toString(36)}`,
    description: doc.description,
    persona: doc.persona,
    policy: doc.policy,
    createdBy: input.createdBy ?? null,
  });

  // Models are matched to whatever this installation already has. A named
  // provider nobody has configured is reported rather than invented, and never
  // silently mapped onto a different one -- an agent quietly answering through
  // a model its owner did not choose is worse than one that does not answer.
  const credentials = await providersRepo.listProviders(input.ownerId);
  for (const role of doc.models) {
    const match = credentials.find((c: { provider: string; enabled: boolean }) => c.provider === role.provider && c.enabled);
    if (!match) {
      notes.push(`No ${role.provider} provider is configured here, so the ${role.role} model was not set.`);
      continue;
    }
    await providersRepo
      .setModelConfig({
        agentId: agent.id,
        role: role.role as never,
        providerCredentialId: match.id,
        model: role.model,
        parameters: role.parameters as never,
      })
      .catch(() => notes.push(`The ${role.role} model could not be set.`));
  }

  for (const tool of doc.tools) {
    await opsRepo
      .setAgentTool({ agentId: agent.id, toolKey: tool.key, enabled: tool.enabled, config: tool.config })
      .catch(() => notes.push(`The tool "${tool.key}" is not available in this installation.`));
  }

  for (const source of doc.knowledge) {
    if (source.kind === 'PATH' && source.location) {
      notes.push(`The documentation folder "${source.location}" is a path on another machine. Point it somewhere here before it can be read.`);
    }
    await knowledgeRepo
      .createSource({
        agentId: agent.id,
        name: source.name,
        kind: source.kind,
        location: source.location,
        include: source.include,
      })
      .catch(() => notes.push(`The knowledge source "${source.name}" could not be added.`));
  }

  if (doc.posting) {
    await postingRepo
      .setSchedule({
        agentId: agent.id,
        accountId: null,
        enabled: false,
        intervalSeconds: doc.posting.intervalSeconds,
      })
      .catch(() => undefined);
    if (doc.posting.enabled) {
      // Never on arrival. An imported agent that begins posting before anybody
      // has looked at it is the worst possible first impression, and the owner
      // has not yet connected an account for it to post through anyway.
      notes.push('Posting was on in the file and is off here. Turn it on once you have connected an account.');
    }
  }

  if (doc.capabilities.length > 0) {
    notes.push('Permissions describe what this agent was allowed to do elsewhere. Connect an account to grant them here.');
  }

  notes.push('No account, session or browser profile was imported. Connect an account when you are ready.');

  return { agentId: agent.id, notes };
}

/** What a duplicate carries, in the words the confirmation uses. */
export type DuplicateScope = 'PERSONA_ONLY' | 'PERSONA_AND_MODELS' | 'EVERYTHING';

/**
 * Copies an agent within one installation.
 *
 * Through the same document as an export, deliberately. Copying inside an
 * installation is where every secret is closest to hand and a direct row copy
 * would bring the lot; going out through the portable shape means a duplicate
 * cannot carry anything an export could not.
 */
export async function duplicateAgent(input: {
  agentId: string;
  ownerId: string;
  name: string;
  scope: DuplicateScope;
  createdBy?: string | null;
}): Promise<ImportReport> {
  const document = await exportAgent(input.agentId);

  const narrowed: PortableAgent =
    input.scope === 'EVERYTHING'
      ? document
      : input.scope === 'PERSONA_AND_MODELS'
        ? { ...document, tools: [], knowledge: [], posting: null, cadence: null }
        : { ...document, models: [], tools: [], knowledge: [], posting: null, cadence: null };

  const report = await importAgent({
    ownerId: input.ownerId,
    document: narrowed,
    name: input.name,
    createdBy: input.createdBy ?? null,
  });

  return {
    ...report,
    notes: [
      ...report.notes,
      'Memories, relationships and everything it has said stay with the original. A copy has not met anybody yet.',
    ],
  };
}

/** What each choice will and will not bring, for the confirmation screen. */
export function describeDuplicateScope(scope: DuplicateScope): { copies: string[]; leaves: string[] } {
  const always = [
    'The connected account and its browser session',
    'Memories, relationships and stances',
    'Everything it has already said',
  ];
  switch (scope) {
    case 'PERSONA_ONLY':
      return {
        copies: ['Its name, biography, personality and examples', 'Its policies'],
        leaves: ['Which models it uses', 'Tools and documentation', ...always],
      };
    case 'PERSONA_AND_MODELS':
      return {
        copies: ['Its name, biography, personality and examples', 'Its policies', 'Which model does what'],
        leaves: ['Tools and documentation', ...always],
      };
    case 'EVERYTHING':
      return {
        copies: [
          'Its name, biography, personality and examples',
          'Its policies',
          'Which model does what',
          'Tool settings and documentation sources',
          'Its posting schedule, switched off',
        ],
        leaves: always,
      };
  }
}
