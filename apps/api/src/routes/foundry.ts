import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConflictError, ForbiddenError, NotFoundError } from '@xbam/shared';
import { FOUNDRY_SECTIONS, FoundryBrief, readBrief } from '@xbam/shared/contracts';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  foundry as foundryRepo,
  ops,
  research as researchRepo,
  testSuites,
  type UserRow,
} from '@xbam/database';
import { applyFoundry, foundryReport, foundryRunView, startTestSuite, testSuiteView } from '@xbam/runtime';
import { handler, params, parseBody, requireUser } from '../http';

async function ownedAgent(agentId: string, user: UserRow) {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent) throw new NotFoundError('Agent');
  if (agent.ownerId !== user.id) throw new ForbiddenError('That agent belongs to another owner.');
  return agent;
}

async function ownedRun(runId: string, user: UserRow) {
  const run = await researchRepo.getRun(runId);
  if (!run || (!run.kind.startsWith('FOUNDRY') && run.kind !== 'PERSONA_REFRESH')) throw new NotFoundError('Foundry run');
  if (run.ownerId !== user.id) throw new ForbiddenError('That run belongs to another owner.');
  return run;
}

const PlanRequest = z.object({
  text: z.string().max(4_000).default(''),
  handle: z.string().trim().max(16).nullable().optional(),
  projects: z.array(z.string().trim().min(1).max(60)).max(6).optional(),
  urls: z.array(z.string().trim().url().max(500)).max(12).optional(),
  relationship: z.enum(['MODELED_AFTER', 'AUTHORIZED_AS']).optional(),
  autonomy: z.enum(['CONSERVATIVE', 'SELECTIVE', 'ACTIVE']).optional(),
  useMirrors: z.boolean().optional(),
});

/** What the owner said, read into fields, with anything they set explicitly winning. */
function briefFrom(body: z.infer<typeof PlanRequest>): FoundryBrief {
  const read = readBrief(body.text);
  return FoundryBrief.parse({
    ...read,
    ...(body.handle !== undefined ? { handle: body.handle ? body.handle.replace(/^@+/, '') : null } : {}),
    ...(body.projects ? { projects: body.projects } : {}),
    ...(body.urls ? { urls: body.urls } : {}),
    ...(body.relationship ? { relationship: body.relationship } : {}),
    ...(body.autonomy ? { autonomy: body.autonomy } : {}),
    ...(body.useMirrors !== undefined ? { useMirrors: body.useMirrors } : {}),
  });
}

/**
 * Agent Foundry: research-backed setup, reviewed before anything changes.
 *
 * A run is created here and advanced by the worker, which owns the browser;
 * this process only records intent, shows progress and applies decisions.
 */
export async function foundryRoutes(app: FastifyInstance): Promise<void> {
  // The plan, before anything runs. Nothing is stored.
  app.post(
    '/api/foundry/plan',
    handler(async (request) => {
      const user = await requireUser(request);
      const brief = briefFrom(parseBody(PlanRequest, request));
      const accounts = await accountsRepo.listAccounts(user.id);
      const reader = accounts.find((a) => a.channel === 'x' && a.status === 'CONNECTED') ?? null;
      return {
        brief,
        sources: [
          ...(brief.handle ? [{ name: `@${brief.handle} on X`, role: 'Primary evidence for the voice', available: Boolean(reader) }] : []),
          ...(brief.projects.length ? [{ name: `Official sources for ${brief.projects.join(', ')}`, role: 'Documentation and repositories, found by search', available: Boolean(reader) }] : []),
          ...brief.urls.map((u) => ({ name: u, role: 'An address you gave', available: true })),
          { name: 'Search engines', role: 'Posts X did not surface; never treated as the whole post', available: Boolean(reader) },
          ...(brief.useMirrors ? [{ name: 'TwStalker and Sotwe (optional)', role: 'Older public posts, confirmed on X where possible', available: Boolean(reader) }] : []),
        ],
        reader: reader ? { handle: reader.handle } : null,
        warning: reader ? null : 'No X account is signed in here, so X cannot be read. Connect one first for a persona worth having.',
      };
    }),
  );

  app.post(
    '/api/agents/:id/foundry',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(PlanRequest.extend({ mode: z.enum(['SETUP', 'IMPROVE', 'REFRESH']).default('SETUP') }), request);
      const running = (await researchRepo.listRuns({ ownerId: user.id, agentId: agent.id, limit: 10 })).find(
        (r) => r.status === 'QUEUED' || r.status === 'RUNNING',
      );
      if (running) throw new ConflictError('A Foundry run for this agent is already going. Stop it or wait for it to finish.');
      const brief = briefFrom(body);
      const run = await researchRepo.createRun({
        ownerId: user.id,
        agentId: agent.id,
        kind: body.mode === 'IMPROVE' ? 'FOUNDRY_IMPROVE' : body.mode === 'REFRESH' ? 'PERSONA_REFRESH' : 'FOUNDRY_SETUP',
        brief,
      });
      await ops.audit({ actorUserId: user.id, action: 'agent.foundry.started', entityType: 'agent', entityId: agent.id, data: { runId: run.id, mode: body.mode } });
      return { run: await foundryRunView(run.id) };
    }),
  );

  app.get(
    '/api/agents/:id/foundry',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const runs = (await researchRepo.listRuns({ ownerId: user.id, agentId: agent.id, limit: 20 })).filter(
        (r) => r.kind.startsWith('FOUNDRY') || r.kind === 'PERSONA_REFRESH',
      );
      return { runs: await Promise.all(runs.map((r) => foundryRunView(r.id))) };
    }),
  );

  app.get(
    '/api/foundry/runs/:runId',
    handler(async (request) => {
      const user = await requireUser(request);
      const run = await ownedRun(params(request).runId!, user);
      return {
        run: await foundryRunView(run.id),
        items: run.status === 'READY' || run.status === 'CANCELLED' ? await foundryRepo.listItems(run.id) : [],
        report: run.status === 'READY' ? await foundryReport(run.id) : null,
      };
    }),
  );

  app.post(
    '/api/foundry/runs/:runId/cancel',
    handler(async (request) => {
      const user = await requireUser(request);
      const run = await ownedRun(params(request).runId!, user);
      return { cancelled: await researchRepo.cancelRun(run.id, user.id) };
    }),
  );

  app.patch(
    '/api/foundry/items/:itemId',
    handler(async (request) => {
      const user = await requireUser(request);
      const item = await foundryRepo.getItem(params(request).itemId!);
      if (!item) throw new NotFoundError('Foundry item');
      await ownedRun(item.runId, user);
      const body = parseBody(
        z.discriminatedUnion('decision', [
          z.object({ decision: z.enum(['ACCEPTED', 'REJECTED', 'PROPOSED']) }),
          z.object({ decision: z.literal('EDITED'), value: z.unknown() }),
        ]),
        request,
      );
      const updated = await foundryRepo.decideItem(
        item.id,
        body.decision === 'EDITED' ? { status: 'EDITED', ownerValue: body.value } : { status: body.decision },
      );
      if (!updated) throw new ConflictError('That item has already been applied. Change it where the setting lives.');
      return { item: updated };
    }),
  );

  app.post(
    '/api/foundry/runs/:runId/accept',
    handler(async (request) => {
      const user = await requireUser(request);
      const run = await ownedRun(params(request).runId!, user);
      const body = parseBody(z.object({ section: z.enum(FOUNDRY_SECTIONS).optional() }), request);
      return { accepted: await foundryRepo.acceptAll(run.id, body.section) };
    }),
  );

  // "Test this agent": the Foundry's behavioural tests, as rehearsals.
  app.post(
    '/api/agents/:id/tests',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(z.object({ foundryRunId: z.string().uuid().nullable().optional() }), request);
      if (body.foundryRunId) await ownedRun(body.foundryRunId, user);
      const suite = await startTestSuite({ agentId: agent.id, requestedBy: user.id, foundryRunId: body.foundryRunId ?? null });
      return { suite: await testSuiteView(suite.id) };
    }),
  );

  app.get(
    '/api/agents/:id/tests',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const latest = (await testSuites.listSuites(agent.id, 1))[0];
      return { suite: latest ? await testSuiteView(latest.id) : null };
    }),
  );

  app.get(
    '/api/agents/:id/tests/:suiteId',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const suite = await testSuites.getSuite(params(request).suiteId!);
      if (!suite || suite.agentId !== agent.id) throw new NotFoundError('Test suite');
      return { suite: await testSuiteView(suite.id) };
    }),
  );

  app.post(
    '/api/foundry/runs/:runId/apply',
    handler(async (request) => {
      const user = await requireUser(request);
      const run = await ownedRun(params(request).runId!, user);
      if (run.status !== 'READY') throw new ConflictError('This run has not finished researching yet.');
      const applied = await applyFoundry({ runId: run.id, userId: user.id });
      return { applied, report: await foundryReport(run.id) };
    }),
  );
}
