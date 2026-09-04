import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CAPABILITIES,
  Capability,
  DEFAULT_TRIGGER_EVENT_TYPES,
  Disposition,
  Familiarity,
  StancePosition,
  ModelRole,
  PersonaDraft,
  PipelineDraft,
  PolicyConfig,
  SetModelConfigInput,
  IN_FLIGHT_JOB_STATUSES,
} from '@xbam/shared/contracts';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@xbam/shared';
import {
  collectDiagnostics,
  liveStatus,
  preflightEnabling,
  toolReadiness,
  tryMessage,
  withToolAllowed,
} from '@xbam/runtime';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  capabilities as capabilitiesRepo,
  posting as postingRepo,
  relationships as relationshipsRepo,
  stances as stancesRepo,
  voice as voiceRepo,
  content as contentRepo,
  evaluation as evaluationRepo,
  ops,
  pipelines as pipelinesRepo,
  providers as providersRepo,
  type UserRow,
  learned as learnedRepo,
  memories as memoriesRepo,
  query,
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
      // `?autosave=1` says this came from typing rather than from somebody
      // pressing save, so consecutive ones collapse into a single version
      // instead of leaving forty behind for one afternoon of editing.
      const autosave = (request.query as { autosave?: string } | undefined)?.autosave === '1';
      const version = await agentsRepo.savePersonaVersion(agent.id, draft, user.id, { autosave });
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
          triggerEventTypes: z.array(z.string()).min(1).default([...DEFAULT_TRIGGER_EVENT_TYPES]),
          actionType: z.string().default('REPLY'),
          enabled: z.boolean().default(true),
          capabilities: z.array(Capability).optional(),
        }),
        request,
      );
      const account = await accountsRepo.getAccount(body.accountId);
      if (!account || account.ownerId !== user.id) throw new NotFoundError('Account');
      await accountsRepo.linkAgentAccount({ agentId: agent.id, ...body });

      // A posting schedule with no account is a schedule that never fires.
      //
      // Easy Mode writes the schedule from the answers, and if the account is
      // connected later -- which is the ordinary order when somebody skips
      // "Connect X" and comes back to it -- the schedule keeps the null it was
      // written with. The scheduler then comes due forever, finds no account,
      // and records "No account is connected for this agent to post through"
      // in a column nobody reads. It looks exactly like an agent with nothing
      // to say.
      //
      // Binding here rather than in `linkAgentAccount` because this is the
      // agent-facing route: the repository function is also used by importers
      // and fixtures that have no opinion about posting.
      const schedule = await postingRepo.getSchedule(agent.id);
      if (schedule && !schedule.accountId) {
        await postingRepo.setSchedule({
          agentId: agent.id,
          accountId: body.accountId,
          enabled: schedule.enabled,
          intervalSeconds: schedule.intervalSeconds,
        });
        if (schedule.enabled) await capabilitiesRepo.grant(agent.id, body.accountId, 'POST');
      }
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
        // Everything still live: OPEN is waiting for its moment, DUE is being
        // followed up on right now. Showing only OPEN hid the ones in flight.
        commitments: [
          ...(await stancesRepo.listCommitments(agent.id, 'OPEN', 20)),
          ...(await stancesRepo.listCommitments(agent.id, 'DUE', 20)),
        ],
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
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(
        z.object({ outcome: z.enum(['CORRECT', 'WRONG', 'UNRESOLVABLE']), note: z.string().max(1_000).default('') }),
        request,
      );
      const resolved = await stancesRepo.resolvePrediction(agent.id, params(request).predictionId!, body.outcome, body.note);
      if (!resolved) throw new NotFoundError('Prediction');
      return { resolved: true };
    }),
  );

  app.post(
    '/api/agents/:id/commitments/:commitmentId',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(z.object({ status: z.enum(['COMPLETED', 'CANCELLED']) }), request);
      const resolved = await stancesRepo.resolveCommitment(agent.id, params(request).commitmentId!, body.status);
      if (!resolved) throw new NotFoundError('Commitment');
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
      // The schedule travels with the backlog because they answer one question
      // together. "Why has it not posted?" is either "posting is off", "it is
      // not due yet", or "there was nothing worth saying" -- and the last one
      // is only credible next to the list it looked at.
      const [counts, items, schedule] = await Promise.all([
        contentRepo.counts(agent.id),
        contentRepo.listIdeas(agent.id, q.status, 60),
        postingRepo.getSchedule(agent.id),
      ]);
      return { counts, items, schedule };
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

  // Trying the agent out without anybody seeing it.
  //
  // There is no job and no action on this path, which is the safety rather than
  // a flag on one: every remote call in this system is made by an action
  // belonging to a job, so the code that reaches X is not reachable from here.
  app.post(
    '/api/agents/:id/playground',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(
        z.object({
          message: z.string().trim().min(1).max(2_000),
          fromHandle: z.string().max(80).nullable().optional(),
          persona: z.record(z.unknown()).nullable().optional(),
          role: z.string().max(40).optional(),
        }),
        request,
      );

      return tryMessage({
        agentId: agent.id,
        message: body.message,
        fromHandle: body.fromHandle ?? null,
        persona: (body.persona ?? null) as never,
        ...(body.role ? { role: body.role as never } : {}),
      });
    }),
  );

  // Everything the agent has learned, and where each piece came from.
  //
  // Read across memory, relationships, stances, entities and commitments rather
  // than from a store of its own: each is already written by the part of the
  // runtime that owns it, and a parallel copy would drift.
  app.get(
    '/api/agents/:id/learned',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      return { items: await learnedRepo.whatItLearned(agent.id) };
    }),
  );

  // Forgetting one thing.
  //
  // Delegated to each store's own delete rather than a generic one: a stance
  // and a memory are not the same row and must not be removed by the same
  // statement, and every one of these is already scoped by agent in its SQL.
  app.delete(
    '/api/agents/:id/learned/:kind/:itemId',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const kind = String(params(request).kind ?? '').toUpperCase();
      const itemId = params(request).itemId!;

      const removed = await (async () => {
        switch (kind) {
          case 'MEMORY': {
            const memory = await memoriesRepo.getMemory(itemId);
            if (!memory || memory.agentId !== agent.id) return false;
            await memoriesRepo.deleteMemory(memory.id);
            return true;
          }
          case 'COMMITMENT':
            return stancesRepo.resolveCommitment(agent.id, itemId, 'CANCELLED');
          case 'STANCE': {
            const stance = await stancesRepo.get(itemId);
            if (!stance || stance.agentId !== agent.id) return false;
            await stancesRepo.update(stance.id, { status: 'RETIRED' });
            return true;
          }
          default:
            throw new BadRequestError(
              // "a entity" reads as a bug in the sentence itself, which is a
              // poor advertisement for a message about correctness.
              `There is no way to forget ${/^[AEIOU]/.test(kind) ? 'an' : 'a'} ${kind.toLowerCase()} on its own. ` +
                'Relationships and entities are ' +
                'records of what happened rather than opinions, and are removed with the conversation they came from.',
            );
        }
      })();

      if (!removed) throw new NotFoundError('That');
      await ops.audit({ actorUserId: user.id, action: 'learned.forgotten', entityType: kind.toLowerCase(), entityId: itemId });
      return { forgotten: true };
    }),
  );

  // Everything an owner might want to see about what their agent is about to
  // say, in the four states it passes through.
  //
  // Drafts and posts are read from jobs and actions rather than kept in a
  // second table: a post already goes through the ten pipeline steps as a
  // SCHEDULED_TRIGGER, so the record of it is the job, and a queue with its own
  // copy would be a second thing to keep in step.
  app.get(
    '/api/agents/:id/content',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);

      const [counts, ideas, schedule, drafts, posted] = await Promise.all([
        contentRepo.counts(agent.id),
        contentRepo.listIdeas(agent.id, 'unused', 60),
        postingRepo.getSchedule(agent.id),
        query<{ id: string; status: string; text: string | null; created_at: string; idea: string | null }>(
          `SELECT j.id, j.status,
                  coalesce(j.validated_output, j.generated_output) AS text,
                  j.created_at,
                  e.payload ->> 'ideaSummary' AS idea
             FROM jobs j JOIN events e ON e.id = j.event_id
            WHERE j.agent_id = $1 AND j.action_type = 'POST'
              AND j.status IN ('WAITING_FOR_APPROVAL', 'REVIEW_REQUIRED')
            ORDER BY j.created_at DESC LIMIT 40`,
          [agent.id],
        ),
        query<{ id: string; text: string | null; url: string | null; executed_at: string | null }>(
          `SELECT a.id, a.payload ->> 'text' AS text, a.remote_action_url AS url, a.executed_at
             FROM actions a
            WHERE a.agent_id = $1 AND a.type = 'POST' AND a.status = 'EXECUTED' AND a.dry_run = false
            ORDER BY a.executed_at DESC NULLS LAST LIMIT 40`,
          [agent.id],
        ),
      ]);

      return { counts, ideas, schedule, drafts, posted };
    }),
  );

  app.patch(
    '/api/agents/:id/ideas/:ideaId',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(z.object({ status: z.enum(['unused', 'used', 'discarded']) }), request);
      const changed = await contentRepo.resolveIdea(agent.id, params(request).ideaId!, body.status);
      if (!changed) throw new NotFoundError('Idea');
      return { status: body.status };
    }),
  );

  // What the agent is doing right now, and why, in one request.
  //
  // Both halves come from the same collection: the word at the top of the
  // screen and the detail behind it cannot disagree, which they would if the
  // status were derived separately from the health.
  app.get(
    '/api/agents/:id/status',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);

      const [diagnostics, inFlight, waiting] = await Promise.all([
        collectDiagnostics(agent.id),
        query<{ status: string; current_node_key: string | null; action_type: string }>(
          `SELECT status, current_node_key, action_type FROM jobs
            WHERE agent_id = $1 AND status = ANY($2::text[])`,
          [agent.id, [...IN_FLIGHT_JOB_STATUSES]],
        ),
        query<{ n: number }>(
          `SELECT count(*)::int AS n FROM jobs
            WHERE agent_id = $1 AND status IN ('REVIEW_REQUIRED', 'WAITING_FOR_APPROVAL')`,
          [agent.id],
        ),
      ]);

      return {
        status: liveStatus({
          diagnostics,
          inFlight: inFlight.map((row) => ({
            status: row.status,
            currentNodeKey: row.current_node_key,
            actionType: row.action_type,
          })),
          awaitingPeople: waiting[0]?.n ?? 0,
        }),
        diagnostics,
      };
    }),
  );

  // How the agent is actually behaving, counted from traces and actions rather
  // than from counters that could drift.
  app.get(
    '/api/agents/:id/evaluation',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const days = Math.min(Math.max(Number((request.query as { days?: string }).days ?? 7) || 7, 1), 90);
      return {
        metrics: await evaluationRepo.socialMetrics(agent.id, days),
        providers: await evaluationRepo.byProvider(agent.id, days),
      };
    }),
  );

  // ── Tools ─────────────────────────────────────────────────────────────────

  /** The tool allowlist on the agent's active policy. */
  const allowedTools = async (agentId: string): Promise<string[]> => {
    const row = await agentsRepo.getActivePolicy(agentId);
    return PolicyConfig.parse(row?.config ?? {}).tools.allowed;
  };

  app.get(
    '/api/agents/:id/tools',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const items = await ops.listAgentTools(agent.id);
      const allowed = await allowedTools(agent.id);
      // The verdict travels with the tool, so an interface never has to work
      // out "enabled but blocked" for itself and phrase it badly.
      return {
        items,
        readiness: items.map((tool) => toolReadiness({ key: tool.key, name: tool.name, enabled: tool.enabled }, allowed)),
      };
    }),
  );

  app.get(
    '/api/agents/:id/tools/:key/preflight',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const key = params(request).key!;
      const tool = (await ops.listAgentTools(agent.id)).find((t) => t.key === key);
      if (!tool) throw new NotFoundError('Tool');
      // Asked before the switch, rather than discovered mid-conversation.
      return preflightEnabling({ key, name: tool.name, enabled: true }, await allowedTools(agent.id));
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
      const key = params(request).key!;
      await ops.setAgentTool({ agentId: agent.id, toolKey: key, enabled: body.enabled, config: body.config });

      const items = await ops.listAgentTools(agent.id);
      const allowed = await allowedTools(agent.id);
      return {
        items,
        readiness: items.map((tool) => toolReadiness({ key: tool.key, name: tool.name, enabled: tool.enabled }, allowed)),
      };
    }),
  );

  app.post(
    '/api/agents/:id/tools/:key/allow',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const key = params(request).key!;

      const known = await ops.listAgentTools(agent.id);
      if (!known.some((t) => t.key === key)) throw new NotFoundError('Tool');

      // One tool onto the allowlist, and nothing else touched. A quick fix that
      // permits every tool to make one work is not a fix.
      const row = await agentsRepo.getActivePolicy(agent.id);
      const config = PolicyConfig.parse(row?.config ?? {});
      const next = {
        ...config,
        tools: { ...config.tools, allowed: withToolAllowed(config.tools.allowed, key) },
      };
      await agentsRepo.savePolicyVersion(agent.id, next, `allowed the ${key} tool`, user.id);
      await ops.audit({
        actorUserId: user.id,
        action: 'policy.tool.allowed',
        entityType: 'agent',
        entityId: agent.id,
        data: { tool: key },
      });

      const items = await ops.listAgentTools(agent.id);
      return {
        items,
        readiness: items.map((tool) =>
          toolReadiness({ key: tool.key, name: tool.name, enabled: tool.enabled }, next.tools.allowed),
        ),
      };
    }),
  );
}
