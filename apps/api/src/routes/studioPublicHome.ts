import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agents } from '@xbam/database';
import { NotFoundError } from '@xbam/shared';
import { PublicHomeChoices, previewPublicHome, publicHomeState, publishPublicHome, unpublishPublicHome, setPublicHomePosting } from '@xbam/runtime';
import { handler, params, parseBody, requireUser } from '../http';

export async function studioPublicHomeRoutes(app: FastifyInstance): Promise<void> {
  const base = '/api/agents/:id/public-home';
  app.get(base, handler(async (request) => {
    const user = await requireUser(request);
    const id = params(request).id!;
    if ((await agents.getAgent(id))?.ownerId !== user.id) throw new NotFoundError('Agent');
    return publicHomeState(id);
  }));
  app.post(`${base}/preview`, handler(async (request) => {
    const user = await requireUser(request);
    return previewPublicHome({ agentId: params(request).id!, ownerId: user.id, choices: parseBody(PublicHomeChoices, request) });
  }));
  app.post(`${base}/publish`, handler(async (request) => {
    const user = await requireUser(request);
    const body = parseBody(z.object({ digest: z.string().regex(/^[0-9a-f]{64}$/), confirmed: z.literal(true) }).strict(), request);
    return publishPublicHome({ agentId: params(request).id!, ownerId: user.id, ...body });
  }));
  app.post(`${base}/unpublish`, handler(async (request) => {
    const user = await requireUser(request);
    parseBody(z.object({}).strict(), request);
    return unpublishPublicHome(params(request).id!, user.id);
  }));
  app.put(`${base}/posting`, handler(async (request) => {
    const user = await requireUser(request);
    const body = parseBody(z.object({ enabled: z.boolean() }).strict(), request);
    await setPublicHomePosting(params(request).id!, user.id, body.enabled);
    return publicHomeState(params(request).id!);
  }));
}
