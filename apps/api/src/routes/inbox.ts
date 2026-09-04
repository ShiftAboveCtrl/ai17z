import type { FastifyInstance } from 'fastify';
import { inbox as inboxRepo, notifications as notificationsRepo } from '@xbam/database';
import { DEFAULT_MUTE_MS, notificationSummary, pauseState, setPauseAll } from '@xbam/runtime';
import { z } from 'zod';
import { parseBody } from '../http';
import { handler, params, requireUser } from '../http';

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

  /**
   * What is wrong with the installation, as opposed to what is waiting for an
   * answer. Nothing here overlaps the inbox above -- an account locked out of X
   * produces no job at all, which is exactly why a list built from jobs cannot
   * show it.
   */
  app.get(
    '/api/notifications',
    handler(async (request) => {
      await requireUser(request);
      const items = await notificationsRepo.listOpen({ limit: 100 });
      return { ...(await notificationSummary()), items };
    }),
  );

  app.post(
    '/api/notifications/:id/acknowledge',
    handler(async (request) => {
      const user = await requireUser(request);
      const body = parseBody(z.object({ mute: z.boolean().default(false) }), request);
      const id = params(request).id!;
      const acknowledged = await notificationsRepo.acknowledge({
        id,
        by: user.email ?? user.id,
        // Muting is "and stop telling me for a while", never "never again".
        ...(body.mute ? { muteMs: DEFAULT_MUTE_MS } : {}),
      });
      if (!acknowledged) {
        // Already cleared, by another tab or by the problem fixing itself.
        // Not an error: the outcome the caller wanted is the outcome.
        return { acknowledged: false, alreadyCleared: true };
      }
      return { acknowledged: true, alreadyCleared: false, item: acknowledged };
    }),
  );

  app.post(
    '/api/notifications/acknowledge-all',
    handler(async (request) => {
      const user = await requireUser(request);
      return { cleared: await notificationsRepo.acknowledgeAll(user.email ?? user.id) };
    }),
  );
}
