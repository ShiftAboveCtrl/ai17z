import type { FastifyInstance } from 'fastify';
import { inbox as inboxRepo } from '@xbam/database';
import { pauseState, setPauseAll } from '@xbam/runtime';
import { z } from 'zod';
import { parseBody } from '../http';
import { handler, requireUser } from '../http';

/**
 * One place to operate every agent an owner has.
 *
 * Deliberately not the Activity table with a filter on it. Activity answers
 * "what occurred"; this answers "what do I need to do", and those produce
 * different lists -- a reply that went out perfectly is the most interesting
 * row in a log and the least interesting thing here.
 */
export async function registerInboxRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/inbox',
    handler(async (request) => {
      const user = await requireUser(request);
      const items = await inboxRepo.ownerInbox(user.id);

      // Counted from the same rows the list returns, so the chips cannot
      // disagree with what is under them.
      return { counts: inboxRepo.countBuckets(items), items: items.map((item) => ({ ...item, bucket: inboxRepo.bucketOf(item) })) };
    }),
  );

  // Stopping everything, from one place.
  //
  // Enforced at the last gate before a remote call rather than here: a pause
  // that lives in the interface stops the buttons and nothing else.
  app.get(
    '/api/runtime/pause',
    handler(async (request) => {
      await requireUser(request);
      return pauseState();
    }),
  );

  app.put(
    '/api/runtime/pause',
    handler(async (request) => {
      const user = await requireUser(request);
      const body = parseBody(z.object({ paused: z.boolean(), reason: z.string().max(300).optional() }), request);
      return setPauseAll({
        paused: body.paused,
        by: user.email ?? user.id,
        ...(body.reason ? { reason: body.reason } : {}),
      });
    }),
  );
}
