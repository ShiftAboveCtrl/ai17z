import type { FastifyInstance } from 'fastify';
import { ForbiddenError, NotFoundError } from '@xbam/shared';
import { agents as agentsRepo } from '@xbam/database';
import { agentSetupCheck } from '@xbam/runtime';
import { handler, params, requireUser } from '../http';

/** Concrete setup checks for one agent, each with where to fix it. Read only. */
export async function setupCheckRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/agents/:id/setup-check',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await agentsRepo.getAgent(params(request).id!);
      if (!agent) throw new NotFoundError('Agent');
      if (agent.ownerId !== user.id) throw new ForbiddenError('That agent belongs to another owner.');
      return agentSetupCheck(agent.id);
    }),
  );
}
