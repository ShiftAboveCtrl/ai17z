import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { deleteShadowFor, putShadowFor, setShadowPausedFor, shadowsOf } from '@xbam/runtime';
import { handler, params, parseBody, requireUser } from '../http';

/**
 * Shadow trading, for the owner who set it up.
 *
 * Every route resolves the agent through the signed-in owner, so an id is not
 * a way to reach somebody else's shadow: an agent that is not theirs is not
 * found, which tells a stranger nothing about what exists.
 *
 * There is deliberately no capability for any of this. A model that could
 * create a standing instruction to read a market every minute has been handed
 * a schedule, and the read budget exists precisely so nothing can do that. A
 * shadow is something a person decides to run.
 *
 * Nothing here can execute. A shadow calls the paper pipeline, which forces
 * PAPER and has no branch that signs.
 */
export async function shadowRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/agents/:id/shadows',
    handler(async (request) => {
      const user = await requireUser(request);
      // Venue readiness travels with the list, because a shadow on a venue
      // nothing can price records a column of NO_MARKET and reads as a fault.
      return shadowsOf(params(request).id!, user.id);
    }),
  );

  app.post(
    '/api/agents/:id/shadows',
    handler(async (request) => {
      const user = await requireUser(request);
      return { shadow: await putShadowFor(params(request).id!, user.id, request.body) };
    }),
  );

  app.post(
    '/api/shadows/:id/paused',
    handler(async (request) => {
      const user = await requireUser(request);
      const body = parseBody(z.object({ paused: z.boolean() }).strict(), request);
      return { shadow: await setShadowPausedFor(params(request).id!, user.id, body.paused) };
    }),
  );

  app.delete(
    '/api/shadows/:id',
    handler(async (request) => {
      const user = await requireUser(request);
      await deleteShadowFor(params(request).id!, user.id);
      // Already gone is the outcome somebody asked for, so deleting twice is
      // the same answer rather than an error.
      return { deleted: true };
    }),
  );
}
