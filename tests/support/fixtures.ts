import { DEFAULT_POLICY, PersonaDraft, PolicyConfig } from '@xbam/shared/contracts';
import { agents, providers, prompts as promptsRepo, users } from '@xbam/database';
import { DEFAULT_TEMPLATES } from '@xbam/prompts';
import { ensureAgentPipeline } from '@xbam/runtime';
import { syncToolCatalogue } from '@xbam/tools';
import { uniqueSuffix } from './db';

export interface Fixture {
  ownerId: string;
  /** The address this owner signs in with, for tests that go through the API. */
  ownerEmail: string;
  agentId: string;
  providerId: string;
}

/** Seeds the catalogue data the runtime expects to exist. */
export async function seedCatalogue(): Promise<void> {
  for (const template of DEFAULT_TEMPLATES) await promptsRepo.upsertTemplate(template);
  await syncToolCatalogue();
}

export async function createFixture(overrides: {
  policy?: Partial<PolicyConfig>;
  persona?: Partial<PersonaDraft>;
  model?: string;
} = {}): Promise<Fixture> {
  const suffix = uniqueSuffix();
  const owner = await users.createOwner({
    email: `owner-${suffix}@example.test`,
    password: 'test-password-1234',
    displayName: 'Test owner',
  });

  const provider = await providers.createProvider({
    ownerId: owner.id,
    provider: 'mock',
    label: `mock-${suffix}`,
    availableModels: ['mock-echo'],
    defaultModel: 'mock-echo',
  });

  const policy = PolicyConfig.parse({
    ...DEFAULT_POLICY,
    automation: { mode: 'AUTONOMOUS', dryRunDefault: false },
    rate: { ...DEFAULT_POLICY.rate, minSecondsBetweenActions: 0, maxActionsPerHour: 0, maxActionsPerDay: 0 },
    // Tests about the queue, the graph and the policy gates use short fixture
    // text that the engagement heuristic would rightly decline to answer.
    // Those tests are not about whether a mention is worth a reply, so the
    // fixture agent answers everything and engagement has its own tests.
    engagement: { ...DEFAULT_POLICY.engagement, strategy: 'ALWAYS_REPLY' as const },
    ...overrides.policy,
  });

  const agent = await agents.createAgent({
    ownerId: owner.id,
    name: `Agent ${suffix}`,
    slug: `agent-${suffix}`,
    persona: PersonaDraft.parse({ displayName: `Agent ${suffix}`, ...overrides.persona }),
    policy,
    createdBy: owner.id,
  });
  await ensureAgentPipeline(agent.id);

  await providers.setModelConfig({
    agentId: agent.id,
    role: 'primary',
    providerCredentialId: provider.id,
    model: overrides.model ?? 'mock-echo',
    parameters: {},
  });

  return {
    ownerId: owner.id,
    ownerEmail: owner.email, agentId: agent.id, providerId: provider.id };
}
