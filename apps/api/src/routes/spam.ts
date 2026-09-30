import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { labelInbound, muteActor, spamOverview } from '@xbam/runtime';
import { handler, params, parseBody, parseQuery, requireUser } from '../http';

/**
 * The owner's spam controls. Owner-only by construction: every route resolves
 * the account through the signed-in owner, and nothing here is reachable by an
 * agent, which never learns what was filtered.
 */
export async function spamRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/events/:id/spam',
    handler(async (request) => {
      const user = await requireUser(request);
      const body = parseBody(z.object({ label: z.enum(['SPAM', 'NOT_SPAM']) }), request);
      return labelInbound({ eventId: params(request).id!, ownerUserId: user.id, label: body.label });
    }),
  );

  app.post(
    '/api/accounts/:id/spam-actors',
    handler(async (request) => {
      const user = await requireUser(request);
      const body = parseBody(z.object({ handle: z.string().trim().min(1).max(40), muted: z.boolean() }), request);
      await muteActor({ accountId: params(request).id!, ownerUserId: user.id, handle: body.handle, muted: body.muted });
      return { ok: true };
    }),
  );

  app.get(
    '/api/spam',
    handler(async (request) => {
      const user = await requireUser(request);
      const query = parseQuery(z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }), request);
      return spamOverview(user.id, query.days);
    }),
  );
}
