import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agents } from '@xbam/database';
import { NotFoundError } from '@xbam/shared';
import { playbookPublishState, previewPlaybookPublish, publishPlaybookSetup, unpublishPlaybookSetup } from '@xbam/runtime';
import { handler, params, parseBody, requireUser } from '../http';

/**
 * Publishing this agent's own setup as a Studio playbook. Owner control plane
 * only: no capability reaches these routes and no model can call them, because
 * what gets published is a copy of the agent's paper mandate and exact-mint
 * universe, and that must be the owner's own act, off until they confirm it.
 */
const PreviewBody = z.object({ title: z.string().min(1).max(60) }).strict();
const PublishBody = z.object({ digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

export async function studioPlaybookPublishRoutes(app: FastifyInstance): Promise<void> {
  const base = '/api/agents/:id/playbook-publish';
  app.get(base, handler(async (request) => {
    const user = await requireUser(request);
    const id = params(request).id!;
    if ((await agents.getAgent(id))?.ownerId !== user.id) throw new NotFoundError('Agent');
    return playbookPublishState(id);
  }));
  app.post(`${base}/preview`, handler(async (request) => {
    const user = await requireUser(request);
    const body = parseBody(PreviewBody, request);
    return previewPlaybookPublish({ agentId: params(request).id!, ownerId: user.id, title: body.title });
  }));
  app.post(`${base}/publish`, handler(async (request) => {
    const user = await requireUser(request);
    const body = parseBody(PublishBody, request);
    return publishPlaybookSetup({ agentId: params(request).id!, ownerId: user.id, digest: body.digest });
  }));
  app.post(`${base}/unpublish`, handler(async (request) => {
    const user = await requireUser(request);
    parseBody(z.object({}).strict(), request);
    return unpublishPlaybookSetup(params(request).id!, user.id);
  }));
}
