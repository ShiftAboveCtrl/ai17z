import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { devUpdates } from '@xbam/database';
import {
  approveDevUpdate,
  authenticateSender,
  createDevUpdateProject,
  getDevUpdateProject,
  getOwnerUpdate,
  getSenderUpdate,
  listDevUpdateProjects,
  listOwnerUpdates,
  listSenderUpdates,
  rejectDevUpdate,
  revokeSenderToken,
  rotateSenderToken,
  senderProjectView,
  submitDevUpdate,
  updateDevUpdateProject,
} from '@xbam/runtime';
import { handler, ok, params, parseQuery, requireUser } from '../http';

/**
 * Development updates over HTTP.
 *
 * Two audiences on two prefixes, with two credentials that cannot stand in for
 * each other. `/api/dev-updates/sender/*` takes a project's sender token and
 * can submit and read that project's updates, nothing more: there is no sender
 * route that approves, rejects, changes a mode or names another project.
 * Everything else takes the owner's signed-in session.
 */

function senderToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

const OwnerListQuery = z.object({
  projectId: z.uuid().optional(),
  status: z.enum(devUpdates.DEV_UPDATE_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const SenderListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function devUpdateRoutes(app: FastifyInstance): Promise<void> {
  // ── Sender ────────────────────────────────────────────────────────────────
  app.get(
    '/api/dev-updates/sender/project',
    handler(async (request) => senderProjectView(await authenticateSender(senderToken(request)))),
  );

  app.post(
    '/api/dev-updates/sender/updates',
    handler(async (request, reply) => {
      const project = await authenticateSender(senderToken(request));
      const result = await submitDevUpdate(project, request.body ?? {});
      // A duplicate is an answer, not an error: the sender learns what became
      // of the first one, which is what it needs to stop asking.
      return ok(reply, result, result.outcome === 'ACCEPTED' ? 201 : 200);
    }),
  );

  app.get(
    '/api/dev-updates/sender/updates',
    handler(async (request) => {
      const project = await authenticateSender(senderToken(request));
      const query = parseQuery(SenderListQuery, request);
      return { items: await listSenderUpdates(project, query.limit) };
    }),
  );

  app.get(
    '/api/dev-updates/sender/updates/:id',
    handler(async (request) => {
      const project = await authenticateSender(senderToken(request));
      return getSenderUpdate(project, params(request).id!);
    }),
  );

  // ── Owner ─────────────────────────────────────────────────────────────────
  app.get(
    '/api/dev-updates/projects',
    handler(async (request) => {
      const user = await requireUser(request);
      return { items: await listDevUpdateProjects(user.id) };
    }),
  );

  app.post(
    '/api/dev-updates/projects',
    handler(async (request, reply) => {
      const user = await requireUser(request);
      const created = await createDevUpdateProject(user.id, request.body ?? {});
      return ok(reply, created, 201);
    }),
  );

  app.get(
    '/api/dev-updates/projects/:id',
    handler(async (request) => {
      const user = await requireUser(request);
      return getDevUpdateProject(user.id, params(request).id!);
    }),
  );

  app.patch(
    '/api/dev-updates/projects/:id',
    handler(async (request) => {
      const user = await requireUser(request);
      return updateDevUpdateProject(user.id, params(request).id!, request.body ?? {});
    }),
  );

  app.post(
    '/api/dev-updates/projects/:id/sender-token',
    handler(async (request) => {
      const user = await requireUser(request);
      return rotateSenderToken(user.id, params(request).id!);
    }),
  );

  app.delete(
    '/api/dev-updates/projects/:id/sender-token',
    handler(async (request) => {
      const user = await requireUser(request);
      return revokeSenderToken(user.id, params(request).id!);
    }),
  );

  app.get(
    '/api/dev-updates/updates',
    handler(async (request) => {
      const user = await requireUser(request);
      const query = parseQuery(OwnerListQuery, request);
      return { items: await listOwnerUpdates(user.id, query) };
    }),
  );

  app.get(
    '/api/dev-updates/updates/:id',
    handler(async (request) => {
      const user = await requireUser(request);
      return getOwnerUpdate(user.id, params(request).id!);
    }),
  );

  app.post(
    '/api/dev-updates/updates/:id/approve',
    handler(async (request) => {
      const user = await requireUser(request);
      return approveDevUpdate(user.id, params(request).id!, request.body ?? {});
    }),
  );

  app.post(
    '/api/dev-updates/updates/:id/reject',
    handler(async (request) => {
      const user = await requireUser(request);
      return rejectDevUpdate(user.id, params(request).id!, request.body ?? {});
    }),
  );
}
