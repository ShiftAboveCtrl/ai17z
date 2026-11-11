import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agents } from '@xbam/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '@xbam/shared';
import { confirmEvidenceRiskWatch, setStudioRiskWatches, studioRiskWatchStatus } from '@xbam/runtime';
import { StudioRiskKind } from '@xbam/shared/contracts';
import { handler, params, parseBody, requireUser } from '../http';

export async function studioRiskWatchRoutes(app: FastifyInstance): Promise<void> {
  const path = '/api/agents/:id/studio-risk-watches';
  const owned = async (request: Parameters<typeof params>[0]) => {
    const user = await requireUser(request);
    const agent = await agents.getAgent(z.string().uuid().parse(params(request).id));
    if (!agent) throw new NotFoundError('Agent');
    if (agent.ownerId !== user.id) throw new ForbiddenError('That agent belongs to another owner.');
    return { agentId: agent.id, ownerId: user.id };
  };
  app.get(path, handler(async request => {
    const scope = await owned(request);
    return studioRiskWatchStatus(scope.agentId, scope.ownerId);
  }));
  app.post(`${path}/confirm-card`, handler(async request => {
    const scope = await owned(request);
    const body = parseBody(z.object({ jobId: z.string().uuid(), kind: StudioRiskKind, threshold: z.number().finite().positive() }).strict(), request);
    const result = await confirmEvidenceRiskWatch({ ...scope, ...body });
    if (!result.ok) throw new BadRequestError(result.why);
    return result;
  }));
  app.put(path, handler(async request => {
    const scope = await owned(request);
    const body = parseBody(z.object({ accountId: z.string().uuid(), enabled: z.boolean().default(false), mayTrigger: z.boolean().default(false) }).strict(), request);
    const result = await setStudioRiskWatches({ ...scope, ...body });
    if (!result.ok) throw new BadRequestError(result.why);
    return result;
  }));
}
