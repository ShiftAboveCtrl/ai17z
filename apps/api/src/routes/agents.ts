import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreateAgentInput,
  PersonaDraft,
  PipelineDraft,
  PolicyConfig,
  SELF_DIAGNOSTICS_TOOL,
  SetModelConfigInput,
  UpdateAgentInput,
} from '@xbam/shared/contracts';
import { ForbiddenError, NotFoundError, slugify } from '@xbam/shared';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  ops,
  pipelines as pipelinesRepo,
  providers as providersRepo,
} from '@xbam/database';
import { duplicateAgent, ensureAgentPipeline } from '@xbam/runtime';
import { handler, params, parseBody, requireUser } from '../http';
import type { UserRow } from '@xbam/database';

/** Ownership check. Multi-user is not enabled yet, but the boundary exists now. */
async function ownedAgent(agentId: string, user: UserRow) {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent) throw new NotFoundError('Agent');
  if (agent.ownerId !== user.id) throw new ForbiddenError('That agent belongs to another owner.');
  return agent;
}

const CreateAgentBody = CreateAgentInput.extend({
  persona: PersonaDraft.partial().optional(),
  policy: PolicyConfig.partial().optional(),
});

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/agents',
    handler(async (request) => {
      const user = await requireUser(request);
      const list = await agentsRepo.listAgents(user.id);
      const withStats = await Promise.all(
        list.map(async (agent) => ({
          ...agent,
          stats: await agentsRepo.getAgentStats(agent.id),
          accounts: await accountsRepo.listAgentAccounts(agent.id),
        })),
      );
      return { items: withStats };
    }),
  );

  app.post(
    '/api/agents',
    handler(async (request) => {
      const user = await requireUser(request);
      const input = parseBody(CreateAgentBody, request);
      const persona = PersonaDraft.parse({
        displayName: input.name,
        ...(input.persona ?? {}),
      });
      // An agent that cannot describe its own runtime can only guess when
      // somebody asks why it is quiet, and a model guessing about
      // infrastructure invents a confident wrong answer. So a new agent is
      // permitted to read its own status -- but only when its owner supplied no
      // policy, because a policy somebody wrote is a decision and is stored
      // exactly as given.
      const supplied = PolicyConfig.parse(input.policy ?? {});
      const policy = input.policy
        ? supplied
        : { ...supplied, tools: { ...supplied.tools, allowed: [...supplied.tools.allowed, SELF_DIAGNOSTICS_TOOL] } };
      const agent = await agentsRepo.createAgent({
        ownerId: user.id,
        name: input.name,
        slug: input.slug ?? slugify(input.name),
        description: input.description,
        avatarUrl: input.avatarUrl,
        avatarMode: input.avatarMode,
        persona,
        policy,
        createdBy: user.id,
      });
      await ensureAgentPipeline(agent.id);
      await ops.audit({ actorUserId: user.id, action: 'agent.created', entityType: 'agent', entityId: agent.id });
      return agent;
    }),
  );

  app.get(
    '/api/agents/:id',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const [persona, policy, pipeline, models, accountLinks, stats, memoryCounts, tools] = await Promise.all([
        agentsRepo.getActivePersona(agent.id),
        agentsRepo.getActivePolicy(agent.id),
        pipelinesRepo.getActivePipeline(agent.id),
        providersRepo.listModelConfigs(agent.id),
        accountsRepo.listAgentAccounts(agent.id),
        agentsRepo.getAgentStats(agent.id),
        agentsRepo.countMemoriesByScope(agent.id),
        ops.listAgentTools(agent.id),
      ]);
      return {
        agent,
        persona,
        policy: policy ? { id: policy.id, version: policy.version, config: PolicyConfig.parse(policy.config) } : null,
        pipeline,
        models,
        accounts: accountLinks,
        stats,
        memoryCounts,
        tools,
      };
    }),
  );

  app.patch(
    '/api/agents/:id',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const patch = parseBody(UpdateAgentInput, request);
      const updated = await agentsRepo.updateAgent(agent.id, patch);
      await ops.audit({
        actorUserId: user.id,
        action: 'agent.updated',
        entityType: 'agent',
        entityId: agent.id,
        data: { fields: Object.keys(patch) },
      });
      return updated;
    }),
  );

  app.delete(
    '/api/agents/:id',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      await agentsRepo.deleteAgent(agent.id);
      await ops.audit({ actorUserId: user.id, action: 'agent.deleted', entityType: 'agent', entityId: agent.id });
      return { deleted: true };
    }),
  );

  /**
   * Duplicating an agent copies its configuration, never its memory or history.
   *
   * Goes out through the portable document and back in, rather than copying
   * rows: copying inside an installation is where every secret is closest to
   * hand, so it is made to pass through the same narrow shape as an export,
   * which has nowhere to put one.
   *
   * The scope is optional and defaults to everything, so anything that called
   * this before behaves exactly as it did.
   */
  app.post(
    '/api/agents/:id/duplicate',
    handler(async (request) => {
      const user = await requireUser(request);
      const source = await ownedAgent(params(request).id!, user);
      const body = parseBody(
        z.object({
          name: z.string().trim().min(1).max(120).optional(),
          scope: z.enum(['PERSONA_ONLY', 'PERSONA_AND_MODELS', 'EVERYTHING']).default('EVERYTHING'),
        }),
        request,
      );

      const report = await duplicateAgent({
        agentId: source.id,
        ownerId: user.id,
        name: body.name ?? `${source.name} copy`,
        scope: body.scope,
        createdBy: user.id,
      });

      const copy = await agentsRepo.getAgent(report.agentId);
      await ensureAgentPipeline(report.agentId);
      // The agent itself, as before, with what could not be carried alongside.
      return { ...copy, notes: report.notes };
    }),
  );
}