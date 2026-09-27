import type { FastifyInstance } from 'fastify';
import { ops, studio as ledger } from '@xbam/database';
import {
  abandonStudioPurchase,
  beginStudioLink,
  disconnectStudio,
  pollStudioLink,
  prepareStudioPurchase,
  recordStudioPurchaseSent,
  studioPurchases,
  studioStatus,
  syncStudio,
} from '@xbam/runtime';
import { z } from 'zod';
import { handler, params, parseBody, requireUser } from '../http';

const intentId = (request: Parameters<typeof params>[0]) => {
  const id = params(request).intentId ?? '';
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
};

/**
 * AI17Z Studio, as the owner reaches it from the Plugins screen.
 *
 * Owner control plane only. None of this is a capability, none of it is
 * reachable by a model, and the purchase routes exist because an owner
 * pressed a button: the page asks for the one transfer a purchase allows,
 * hands it to the owner's own wallet in their browser, and reports the hash
 * the wallet returned. No private key of any wallet is ever here.
 *
 * Nothing secret comes back out: not the installation key, not a token, not
 * the device code. The pairing code is shown because the owner types it.
 */
export async function registerStudioRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/studio',
    handler(async (request) => {
      await requireUser(request);
      return studioStatus();
    }),
  );

  app.post(
    '/api/studio/link',
    handler(async (request) => {
      const user = await requireUser(request);
      const body = parseBody(z.object({ replacePrevious: z.boolean().optional() }).strict(), request);
      const started = await beginStudioLink(body.replacePrevious === undefined ? {} : { replacePrevious: body.replacePrevious });
      await ops.audit({ actorUserId: user.id, action: 'studio.link.started', entityType: 'settings', entityId: 'studio', data: { ok: started.ok } });
      return started;
    }),
  );

  app.post(
    '/api/studio/link/poll',
    handler(async (request) => {
      const user = await requireUser(request);
      const outcome = await pollStudioLink();
      if (outcome.state === 'LINKED' || outcome.state === 'FAILED') {
        await ops.audit({ actorUserId: user.id, action: 'studio.link.settled', entityType: 'settings', entityId: 'studio', data: { state: outcome.state } });
      }
      return outcome;
    }),
  );

  app.post(
    '/api/studio/disconnect',
    handler(async (request) => {
      const user = await requireUser(request);
      const done = await disconnectStudio();
      await ops.audit({ actorUserId: user.id, action: 'studio.disconnected', entityType: 'settings', entityId: 'studio', data: { studioTold: done.studioTold } });
      return done;
    }),
  );

  app.post(
    '/api/studio/sync',
    handler(async (request) => {
      await requireUser(request);
      return syncStudio();
    }),
  );

  /** Purchases Studio says are waiting here, beside what this installation recorded about each. */
  app.get(
    '/api/studio/purchases',
    handler(async (request) => {
      await requireUser(request);
      const [remote, local] = await Promise.all([studioPurchases(), ledger.listPurchases(100)]);
      return { studio: remote, ledger: local };
    }),
  );

  app.post(
    '/api/studio/purchases/:intentId/prepare',
    handler(async (request) => {
      const user = await requireUser(request);
      const id = intentId(request);
      if (!id) return { ok: false, why: 'That is not a purchase id.' };
      const prepared = await prepareStudioPurchase(id);
      await ops.audit({
        actorUserId: user.id,
        action: 'studio.purchase.prepared',
        entityType: 'studio_purchase',
        entityId: id,
        data: prepared.ok ? { amountBaseUnits: prepared.purchase.amountBaseUnits, recipient: prepared.purchase.recipient } : { refused: prepared.why },
      });
      return prepared;
    }),
  );

  app.post(
    '/api/studio/purchases/:intentId/sent',
    handler(async (request) => {
      const user = await requireUser(request);
      const id = intentId(request);
      if (!id) return { ok: false, why: 'That is not a purchase id.' };
      const body = parseBody(z.object({ txHash: z.string().trim().max(80) }).strict(), request);
      const recorded = await recordStudioPurchaseSent(id, body.txHash);
      await ops.audit({ actorUserId: user.id, action: 'studio.purchase.sent', entityType: 'studio_purchase', entityId: id, data: { ok: recorded.ok } });
      return recorded;
    }),
  );

  /** The owner says their wallet sent nothing, so the purchase may be prepared again. */
  app.post(
    '/api/studio/purchases/:intentId/not-sent',
    handler(async (request) => {
      const user = await requireUser(request);
      const id = intentId(request);
      if (!id) return { ok: false, why: 'That is not a purchase id.' };
      const done = await abandonStudioPurchase(id);
      await ops.audit({ actorUserId: user.id, action: 'studio.purchase.not_sent', entityType: 'studio_purchase', entityId: id, data: { ok: done.ok } });
      return done;
    }),
  );
}
