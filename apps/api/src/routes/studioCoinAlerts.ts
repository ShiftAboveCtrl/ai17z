import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agents } from '@xbam/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '@xbam/shared';
import { setStudioCoinAlerts, studioCoinAlertStatus } from '@xbam/runtime';
import { handler, params, parseBody, requireUser } from '../http';

export async function studioCoinAlertRoutes(app: FastifyInstance): Promise<void> {
  const path = '/api/agents/:id/studio-coin-alerts';
  const owned = async (request: Parameters<typeof params>[0]) => {
    const user = await requireUser(request);
    const agent = await agents.getAgent(z.string().uuid().parse(params(request).id));
    if (!agent) throw new NotFoundError('Agent');
    if (agent.ownerId !== user.id) throw new ForbiddenError('That agent belongs to another owner.');
    return { agentId: agent.id, ownerId: user.id };
  };
  app.get(path, handler(async request => {
    const scope = await owned(request);
    return studioCoinAlertStatus(scope.agentId, scope.ownerId);
  }));
  app.put(path, handler(async request => {
    const scope = await owned(request);
    const body = parseBody(z.object({ accountId: z.string().uuid(), enabled: z.boolean().default(false) }).strict(), request);
    const result = await setStudioCoinAlerts({ ...scope, ...body });
    if (!result.ok) throw new BadRequestError(result.why);
    return result;
  }));
}
