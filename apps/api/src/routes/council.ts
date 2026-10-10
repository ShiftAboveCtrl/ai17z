import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agents as agentsRepo, type UserRow } from '@xbam/database';
import { ForbiddenError, NotFoundError } from '@xbam/shared';
import { COUNCIL_ROLES, convene } from '@xbam/runtime';
import { handler, params, parseBody, requireUser } from '../http';

async function ownedAgent(agentId: string, user: UserRow) {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent) throw new NotFoundError('Agent');
  if (agent.ownerId !== user.id) throw new ForbiddenError('That agent belongs to another owner.');
  return agent;
}

const CouncilBody = z
  .object({
    proposition: z.string().trim().min(3).max(500),
    evidence: z
      .array(z.object({ source: z.string().trim().min(1).max(200), content: z.string().min(1).max(8_000), url: z.string().url().max(2_000).nullable().optional() }).strict())
      .min(1)
      .max(12),
    roles: z.array(z.enum(COUNCIL_ROLES)).min(2).max(5).optional(),
  })
  .strict();

/**
 * A council of the agent's own models, convened by its owner: a proposition,
 * the evidence to judge it from, and up to five specialists. One model call
 * per member through the owner's configured provider, each counted in the
 * ordinary model-call record; no member sees anything but the evidence given.
 * Owner only: a council spends the owner's own model budget.
 */
export async function registerCouncilRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/agents/:id/council',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(CouncilBody, request);
      return convene({
        agentId: agent.id,
        proposition: body.proposition,
        evidence: body.evidence.map((e) => ({ source: e.source, content: e.content, url: e.url ?? null })),
        ...(body.roles ? { roles: body.roles } : {}),
      });
    }),
  );
}
