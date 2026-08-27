import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CAPABILITIES,
  Capability,
  Disposition,
  Familiarity,
  ModelRole,
  PersonaDraft,
  PipelineDraft,
  PolicyConfig,
  SetModelConfigInput,
} from '@xbam/shared/contracts';
import { ConflictError, ForbiddenError, NotFoundError } from '@xbam/shared';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  capabilities as capabilitiesRepo,
  relationships as relationshipsRepo,
  ops,
  pipelines as pipelinesRepo,
  providers as providersRepo,
  type UserRow,
} from '@xbam/database';
import { validateGraph } from '@xbam/runtime';
import { handler, params, parseBody, requireUser } from '../http';

async function ownedAgent(agentId: string, user: UserRow) {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent) throw new NotFoundError('Agent');
  if (agent.ownerId !== user.id) throw new ForbiddenError('That agent belongs to another owner.');
  return agent;
}

export async function agentConfigRoutes(app: FastifyInstance): Promise<void> {
  // ── Persona ───────────────────────────────────────────────────────────────
  app.get(
    '/api/agents/:id/persona/versions',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      return { items: await agentsRepo.listPersonaVersions(agent.id) };
    }),
  );

  app.put(
    '/api/agents/:id/persona',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const draft = parseBody(PersonaDraft, request);
      const version = await agentsRepo.savePersonaVersion(agent.id, draft, user.id);
      await ops.audit({
        actorUserId: user.id,
        action: 'persona.saved',
        entityType: 'agent',
        entityId: agent.id,
        data: { version: version.version },
      });
      return version;
    }),
  );

  // ── Policy ────────────────────────────────────────────────────────────────
  app.get(
    '/api/agents/:id/policy/versions',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      return { items: await agentsRepo.listPolicyVersions(agent.id) };
    }),
  );

  app.put(
    '/api/agents/:id/policy',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(z.object({ config: PolicyConfig, changeNote: z.string().max(500).default('') }), request);
      const version = await agentsRepo.savePolicyVersion(agent.id, body.config, body.changeNote, user.id);
      await ops.audit({
        actorUserId: user.id,
        action: 'policy.saved',
        entityType: 'agent',
        entityId: agent.id,
        data: { version: version.version, automation: body.config.automation.mode },
      });
      return version;
    }),
  );

  // ── Models ────────────────────────────────────────────────────────────────
  app.get(
    '/api/agents/:id/models',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      return { items: await providersRepo.listModelConfigs(agent.id) };
    }),
  );

  app.put(
    '/api/agents/:id/models',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const input = parseBody(SetModelConfigInput, request);
      const credential = await providersRepo.getProvider(input.providerCredentialId);
      if (!credential || credential.ownerId !== user.id) throw new NotFoundError('Provider credential');
      await providersRepo.setModelConfig({
        agentId: agent.id,
        role: input.role,
        providerCredentialId: input.providerCredentialId,
        model: input.model,
        parameters: input.parameters,
      });
      return { items: await providersRepo.listModelConfigs(agent.id) };
    }),
  );

  app.delete(
    '/api/agents/:id/models/:role',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const role = ModelRole.parse(params(request).role);
      await providersRepo.deleteModelConfig(agent.id, role);
      return { items: await providersRepo.listModelConfigs(agent.id) };
    }),
  );

  // ── Pipeline ──────────────────────────────────────────────────────────────
  app.get(
    '/api/agents/:id/pipeline',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      return {
        active: await pipelinesRepo.getActivePipeline(agent.id),
        versions: await pipelinesRepo.listPipelineVersions(agent.id),
      };
    }),
  );

  /** Checks a graph without saving it, so the editor can warn before you commit. */
  app.post(
    '/api/agents/:id/pipeline/validate',
    handler(async (request) => {
      const user = await requireUser(request);
      await ownedAgent(params(request).id!, user);
      return validateGraph(parseBody(PipelineDraft, request));
    }),
  );

  app.put(
    '/api/agents/:id/pipeline',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const draft = parseBody(PipelineDraft, request);

      // A graph that cannot run must never become the active version: it would
      // fail at the moment a real event arrives, not now.
      const validation = validateGraph(draft);
      if (!validation.ok) {
        throw new ConflictError('This pipeline cannot run as drawn.', {
          problems: validation.problems.filter((p) => p.severity === 'error'),
        });
      }
      return pipelinesRepo.savePipelineVersion(agent.id, draft, user.id);
    }),
  );

  // ── Accounts ──────────────────────────────────────────────────────────────
  app.post(
    '/api/agents/:id/accounts',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(
        z.object({
          accountId: z.string().uuid(),
          triggerEventTypes: z.array(z.string()).min(1).default(['MENTION']),
          actionType: z.string().default('REPLY'),
          enabled: z.boolean().default(true),
          capabilities: z.array(Capability).optional(),
        }),
        request,
      );
      const account = await accountsRepo.getAccount(body.accountId);
      if (!account || account.ownerId !== user.id) throw new NotFoundError('Account');
      await accountsRepo.linkAgentAccount({ agentId: agent.id, ...body });
      // Linking grants the defaults on its own; an explicit set overrides them.
      if (body.capabilities) {
        await capabilitiesRepo.setGrants(agent.id, body.accountId, body.capabilities, user.id);
      }
      return {
        items: await accountsRepo.listAgentAccounts(agent.id),
        capabilities: Object.fromEntries(await capabilitiesRepo.grantsForAgent(agent.id)),
      };
    }),
  );

  // What this agent may do through each linked account. Separate from the link
  // itself because it answers a different question: not what the agent does in
  // response to an event, but what it is allowed to do at all.
  app.get(
    '/api/agents/:id/capabilities',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      return {
        vocabulary: CAPABILITIES,
        grants: Object.fromEntries(await capabilitiesRepo.grantsForAgent(agent.id)),
      };
    }),
  );

  app.put(
    '/api/agents/:id/accounts/:accountId/capabilities',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const accountId = params(request).accountId!;
      const account = await accountsRepo.getAccount(accountId);
      if (!account || account.ownerId !== user.id) throw new NotFoundError('Account');
      const body = parseBody(z.object({ capabilities: z.array(Capability) }), request);

      const granted = await capabilitiesRepo.setGrants(agent.id, accountId, body.capabilities, user.id);
      await ops.audit({
        actorUserId: user.id,
        action: 'agent.capabilities.set',
        entityType: 'agent',
        entityId: agent.id,
        data: { accountId, capabilities: granted },
      });
      return { accountId, capabilities: granted };
    }),
  );

  app.delete(
    '/api/agents/:id/accounts/:accountId',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      await accountsRepo.unlinkAgentAccount(agent.id, params(request).accountId!);
      return { items: await accountsRepo.listAgentAccounts(agent.id) };
    }),
  );

  // ── Relationships ─────────────────────────────────────────────────────────
  //
  // What the agent knows about the people it talks to. Only what happened
  // between them: nothing here is inferred about anybody beyond the
  // conversations they chose to have.
  app.get(
    '/api/agents/:id/relationships',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const q = request.query as { familiarity?: string; search?: string; limit?: string };
      return {
        counts: await relationshipsRepo.counts(agent.id),
        items: await relationshipsRepo.listForAgent(agent.id, {
          familiarity: q.familiarity as never,
          search: q.search,
          limit: Math.min(Number(q.limit ?? 50) || 50, 200),
        }),
      };
    }),
  );

  app.get(
    '/api/agents/:id/relationships/:relationshipId',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const relationship = await relationshipsRepo.get(params(request).relationshipId!);
      if (!relationship || relationship.agentId !== agent.id) throw new NotFoundError('Relationship');
      return { relationship, callbacks: await relationshipsRepo.listCallbacks(relationship.id) };
    }),
  );

  app.patch(
    '/api/agents/:id/relationships/:relationshipId',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const relationship = await relationshipsRepo.get(params(request).relationshipId!);
      if (!relationship || relationship.agentId !== agent.id) throw new NotFoundError('Relationship');

      const body = parseBody(
        z.object({
          summary: z.string().max(2_000).optional(),
          ownerNote: z.string().max(2_000).optional(),
          topics: z.array(z.string().max(60)).max(12).optional(),
          disposition: Disposition.optional(),
          familiarity: Familiarity.optional(),
          familiarityPinned: z.boolean().optional(),
        }),
        request,
      );
      const updated = await relationshipsRepo.update(relationship.id, body);
      await ops.audit({
        actorUserId: user.id,
        action: 'relationship.updated',
        entityType: 'agent',
        entityId: agent.id,
        data: { handle: relationship.handle, ...body },
      });
      return updated;
    }),
  );

  app.delete(
    '/api/agents/:id/relationships/:relationshipId/callbacks/:callbackId',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const relationship = await relationshipsRepo.get(params(request).relationshipId!);
      if (!relationship || relationship.agentId !== agent.id) throw new NotFoundError('Relationship');
      // Retired rather than deleted: the exchange it came from still happened.
      await relationshipsRepo.retireCallback(params(request).callbackId!);
      return { retired: true };
    }),
  );

  // ── Tools ─────────────────────────────────────────────────────────────────
  app.get(
    '/api/agents/:id/tools',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      return { items: await ops.listAgentTools(agent.id) };
    }),
  );

  app.put(
    '/api/agents/:id/tools/:key',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(
        z.object({ enabled: z.boolean(), config: z.record(z.unknown()).default({}) }),
        request,
      );
      await ops.setAgentTool({ agentId: agent.id, toolKey: params(request).key!, enabled: body.enabled, config: body.config });
      return { items: await ops.listAgentTools(agent.id) };
    }),
  );
}
