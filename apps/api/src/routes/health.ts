import type { FastifyInstance } from 'fastify';
import { collectHealth } from '@xbam/runtime';
import { handler } from '../http';

/**
 * Two routes and no health logic.
 *
 * `collectHealth` is in the runtime because the web screen is no longer its
 * only caller: Telegram's `/health` renders the same report, so a phone and a
 * screen cannot disagree about whether anything is wrong.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health/live', async (_request, reply) => reply.send({ ok: true, data: { alive: true } }));
  app.get('/api/health', handler(async () => collectHealth()));
}
