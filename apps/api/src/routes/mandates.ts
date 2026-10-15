import type { FastifyInstance } from 'fastify';
import { mandateOf, pauseOwnerMandate, writeOwnerMandate } from '@xbam/runtime';
import { z } from 'zod';
import { handler, params, parseBody, requireUser } from '../http';

/**
 * An agent's trading mandate, written by its owner. Owner control plane only:
 * no capability reaches it and no model can write it, because a mandate is
 * exactly the thing an agent must not be able to change about itself.
 */
export async function mandateRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/agents/:id/mandate',
    handler(async (request) => ({ mandate: await mandateOf(params(request).id!, (await requireUser(request)).id) })),
  );

  app.put(
    '/api/agents/:id/mandate',
    handler(async (request) => ({ mandate: await writeOwnerMandate(params(request).id!, (await requireUser(request)).id, request.body) })),
  );

  app.post(
    '/api/agents/:id/mandate/pause',
    handler(async (request) => {
      const user = await requireUser(request);
      const body = parseBody(z.object({ paused: z.boolean() }).strict(), request);
      return { mandate: await pauseOwnerMandate(params(request).id!, user.id, body.paused) };
    }),
  );
}
