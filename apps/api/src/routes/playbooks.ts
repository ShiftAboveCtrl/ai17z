import type { FastifyInstance } from 'fastify';
import { confirmPlaybook, playbookStatusFor, previewPlaybook, refusalError } from '@xbam/runtime';
import { z } from 'zod';
import { handler, params, parseBody, requireUser } from '../http';

/**
 * Running a published playbook on an agent. Owner control plane only: no
 * capability reaches these routes and no model can call them, because what a
 * playbook may change is the agent's own mandate.
 *
 * The body names where the playbook is (a document, or an id on the linked
 * Studio) and nothing else. There is no field for a mode, an approval, a
 * capability or a limit, and a body with one is refused as unknown.
 */
const PreviewBody = z.union([
  z.object({ document: z.unknown(), allowDowngrade: z.boolean().optional() }).strict(),
  z.object({ studioId: z.string().min(1).max(80), allowDowngrade: z.boolean().optional() }).strict(),
]);
const ConfirmBody = z.union([
  z.object({ document: z.unknown(), sha256: z.string().length(64), allowDowngrade: z.boolean().optional() }).strict(),
  z.object({ studioId: z.string().min(1).max(80), sha256: z.string().length(64), allowDowngrade: z.boolean().optional() }).strict(),
]);

export async function playbookRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/agents/:id/playbook',
    handler(async (request) => ({ playbook: await playbookStatusFor(params(request).id!, (await requireUser(request)).id) })),
  );

  app.post(
    '/api/agents/:id/playbook/preview',
    handler(async (request) => {
      const user = await requireUser(request);
      const body = parseBody(PreviewBody, request);
      const { allowDowngrade, ...source } = body;
      const result = await previewPlaybook(params(request).id!, user.id, source as never, { allowDowngrade: allowDowngrade === true });
      if (!result.ok) throw refusalError(result);
      return result;
    }),
  );

  app.post(
    '/api/agents/:id/playbook/confirm',
    handler(async (request) => {
      const user = await requireUser(request);
      const body = parseBody(ConfirmBody, request);
      const { sha256, allowDowngrade, ...source } = body;
      const result = await confirmPlaybook(params(request).id!, user.id, source as never, sha256, { allowDowngrade: allowDowngrade === true });
      if (!result.ok) throw refusalError(result);
      return result;
    }),
  );
}
