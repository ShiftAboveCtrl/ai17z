import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CAPABILITIES,
  Capability,
  Disposition,
  Familiarity,
  StancePosition,
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
  stances as stancesRepo,
  voice as voiceRepo,
  content as contentRepo,
  ops,
  pipelines as pipelinesRepo,
  providers as providersRepo,
  type UserRow,
} from '@xbam/database';
import { compileForJob, fingerprintFor, refreshFingerprint, validateGraph } from '@xbam/runtime';
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

  // ── Beliefs ───────────────────────────────────────────────────────────────
  //
  // What the agent thinks and what that rests on. A position with no evidence
  // is an assertion, so evidence is always one click away.
  app.get(
    '/api/agents/:id/stances',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      return {
        items: await stancesRepo.listActive(agent.id),
        predictions: await stancesRepo.listPredictions(agent.id, 'OPEN', 20),
        commitments: await stancesRepo.listCommitments(agent.id, 'OPEN', 20),
      };
    }),
  );

  app.get(
    '/api/agents/:id/stances/:stanceId',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const stance = await stancesRepo.get(params(request).stanceId!);
      if (!stance || stance.agentId !== agent.id) throw new NotFoundError('Stance');
      return {
        stance,
        evidence: await stancesRepo.listEvidence(stance.id),
        history: await stancesRepo.history(agent.id, stance.subject),
      };
    }),
  );

  app.post(
    '/api/agents/:id/stances',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(
        z.object({
          subject: z.string().trim().min(1).max(200),
          position: StancePosition,
          summary: z.string().trim().min(1).max(2_000),
          confidence: z.number().min(0).max(1).default(0.8),
        }),
        request,
      );
      // Written by a person, so pinned: nothing the agent says revises it.
      const stance = await stancesRepo.assert({
        agentId: agent.id,
        ...body,
        pinned: true,
        evidence: { kind: 'told_by_owner', excerpt: body.summary },
      });
      await ops.audit({
        actorUserId: user.id,
        action: 'stance.set',
        entityType: 'agent',
        entityId: agent.id,
        data: { subject: body.subject, position: body.position },
      });
      return stance;
    }),
  );

  app.patch(
    '/api/agents/:id/stances/:stanceId',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const stance = await stancesRepo.get(params(request).stanceId!);
      if (!stance || stance.agentId !== agent.id) throw new NotFoundError('Stance');
      const body = parseBody(
        z.object({
          summary: z.string().max(2_000).optional(),
          position: StancePosition.optional(),
          confidence: z.number().min(0).max(1).optional(),
          pinned: z.boolean().optional(),
          status: z.enum(['ACTIVE', 'RETIRED']).optional(),
        }),
        request,
      );
      return stancesRepo.update(stance.id, body);
    }),
  );

  // Judging a prediction is a person's call; nothing decides one automatically.
  app.post(
    '/api/agents/:id/predictions/:predictionId',
    handler(async (request) => {
      const user = await requireUser(request);
      await ownedAgent(params(request).id!, user);
      const body = parseBody(
        z.object({ outcome: z.enum(['CORRECT', 'WRONG', 'UNRESOLVABLE']), note: z.string().max(1_000).default('') }),
        request,
      );
      await stancesRepo.resolvePrediction(params(request).predictionId!, body.outcome, body.note);
      return { resolved: true };
    }),
  );

  app.post(
    '/api/agents/:id/commitments/:commitmentId',
    handler(async (request) => {
      const user = await requireUser(request);
      await ownedAgent(params(request).id!, user);
      const body = parseBody(z.object({ status: z.enum(['DONE', 'DROPPED']) }), request);
      await stancesRepo.resolveCommitment(params(request).commitmentId!, body.status);
      return { resolved: true };
    }),
  );

  // ── Voice ─────────────────────────────────────────────────────────────────
  //
  // The measured fingerprint, and what it was measured from. Numbers rather
  // than adjectives, because a label is what the model reinterprets every time.
  app.get(
    '/api/agents/:id/voice',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const stored = await voiceRepo.getFingerprint(agent.id);
      const recent = await voiceRepo.recentOutput(agent.id, 10, 21);
      return {
        fingerprint: stored?.fingerprint ?? (await fingerprintFor(agent.id)),
        pinned: stored?.pinned ?? false,
        derivedAt: stored?.derivedAt ?? null,
        sources: stored?.sources ?? [],
        recentOutput: recent,
      };
    }),
  );

  app.post(
    '/api/agents/:id/voice/derive',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(z.object({ force: z.boolean().default(false) }), request);
      const fingerprint = await refreshFingerprint(agent.id, body.force);
      await ops.audit({
        actorUserId: user.id,
        action: 'voice.derived',
        entityType: 'agent',
        entityId: agent.id,
        data: { samples: fingerprint.sampleCount },
      });
      return { fingerprint };
    }),
  );

  app.patch(
    '/api/agents/:id/voice',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(z.object({ pinned: z.boolean() }), request);
      await voiceRepo.setPinned(agent.id, body.pinned);
      return { pinned: body.pinned };
    }),
  );

  // Scores a piece of text against the agent's voice without publishing it.
  // Useful for seeing what the gate would do before trusting it with a reply.
  app.post(
    '/api/agents/:id/voice/score',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(z.object({ text: z.string().min(1).max(10_000) }), request);
      const policy = await agentsRepo.getActivePolicy(agent.id);
      const parsed = PolicyConfig.parse(policy?.config ?? {});

      const compiled = await compileForJob({
        agentId: agent.id,
        jobId: null,
        draft: body.text,
        policy: parsed,
        recipientHandle: null,
        // Scoring is a preview, so it never spends a model call.
        allowModelCall: false,
        maxCalls: 1,
      });
      return { text: compiled.text, report: compiled.report, applied: compiled.applied };
    }),
  );

  // ── Content ───────────────────────────────────────────────────────────────
  //
  // Ideas come from things that happened. An agent with an empty backlog posts
  // nothing, which is the correct outcome rather than a gap to be filled.
  app.get(
    '/api/agents/:id/ideas',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const q = request.query as { status?: string };
      return {
        counts: await contentRepo.counts(agent.id),
        items: await contentRepo.listIdeas(agent.id, q.status, 60),
      };
    }),
  );

  app.post(
    '/api/agents/:id/ideas',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(
        z.object({
          summary: z.string().trim().min(5).max(500),
          detail: z.string().max(2_000).default(''),
          kind: z.string().max(40).default('observation'),
          score: z.number().int().min(0).max(100).default(70),
        }),
        request,
      );
      return contentRepo.addIdea({ agentId: agent.id, ...body, source: 'you' });
    }),
  );

  app.patch(
    '/api/agents/:id/ideas/:ideaId',
    handler(async (request) => {
      const user = await requireUser(request);
      await ownedAgent(params(request).id!, user);
      const body = parseBody(z.object({ status: z.enum(['unused', 'used', 'discarded']) }), request);
      await contentRepo.resolveIdea(params(request).ideaId!, body.status);
      return { status: body.status };
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
