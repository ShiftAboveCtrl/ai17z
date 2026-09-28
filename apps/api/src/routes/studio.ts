import type { FastifyInstance } from 'fastify';
import { ops, studio as ledger } from '@xbam/database';
import {
  abandonStudioPurchase,
  beginStudioLink,
  disconnectStudio,
  pollStudioLink,
  prepareStudioPurchase,
  recordStudioPurchaseSent,
  reviewStudioPurchase,
  studioLinkWallet,
  studioWalletChallenge,
  studioWallets,
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

/** Which payment of a checkout, from `?leg=`; absent is the first, which is all a single-payment checkout has. */
const legOf = (request: Parameters<typeof params>[0]): number | null => {
  const raw = (request.query as Record<string, unknown> | undefined)?.leg;
  if (raw === undefined) return 0;
  return typeof raw === 'string' && /^[0-7]$/.test(raw) ? Number(raw) : null;
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

  /** The wallets linked to the Studio account this installation acts for. Addresses only. */
  app.get(
    '/api/studio/wallets',
    handler(async (request) => {
      await requireUser(request);
      return studioWallets();
    }),
  );

  /** A one-time message for the owner's wallet, checked here before the page may show it. */
  app.post(
    '/api/studio/wallets/challenge',
    handler(async (request) => {
      await requireUser(request);
      const body = parseBody(z.object({ address: z.string().trim().max(64) }).strict(), request);
      return studioWalletChallenge(body.address);
    }),
  );

  app.post(
    '/api/studio/wallets',
    handler(async (request) => {
      const user = await requireUser(request);
      const body = parseBody(z.object({ challengeId: z.string().uuid(), signature: z.string().trim().max(200) }).strict(), request);
      const linked = await studioLinkWallet(body.challengeId, body.signature);
      await ops.audit({ actorUserId: user.id, action: 'studio.wallet.linked', entityType: 'settings', entityId: 'studio', data: { ok: linked.ok } });
      return linked;
    }),
  );

  /** Terms, the transfer they allow and what the chain says about it. Records nothing and asks no wallet. */
  app.post(
    '/api/studio/purchases/:intentId/review',
    handler(async (request) => {
      await requireUser(request);
      const id = intentId(request);
      const leg = legOf(request);
      if (!id || leg === null) return { ok: false, why: 'That is not a purchase id.' };
      return reviewStudioPurchase(id, leg);
    }),
  );

  app.post(
    '/api/studio/purchases/:intentId/prepare',
    handler(async (request) => {
      const user = await requireUser(request);
      const id = intentId(request);
      const leg = legOf(request);
      if (!id || leg === null) return { ok: false, why: 'That is not a purchase id.' };
      const prepared = await prepareStudioPurchase(id, leg);
      await ops.audit({
        actorUserId: user.id,
        action: 'studio.purchase.prepared',
        entityType: 'studio_purchase',
        entityId: id,
        data: prepared.ok
          ? { leg, role: prepared.purchase.role, asset: prepared.purchase.asset, amountBaseUnits: prepared.purchase.amountBaseUnits, recipient: prepared.purchase.recipient }
          : { leg, refused: prepared.why },
      });
      return prepared;
    }),
  );

  app.post(
    '/api/studio/purchases/:intentId/sent',
    handler(async (request) => {
      const user = await requireUser(request);
      const id = intentId(request);
      const leg = legOf(request);
      if (!id || leg === null) return { ok: false, why: 'That is not a purchase id.' };
      const body = parseBody(z.object({ txHash: z.string().trim().max(80) }).strict(), request);
      const recorded = await recordStudioPurchaseSent(id, body.txHash, leg);
      await ops.audit({ actorUserId: user.id, action: 'studio.purchase.sent', entityType: 'studio_purchase', entityId: id, data: { leg, ok: recorded.ok } });
      return recorded;
    }),
  );

  /** The owner says their wallet sent nothing, so the purchase may be prepared again. */
  app.post(
    '/api/studio/purchases/:intentId/not-sent',
    handler(async (request) => {
      const user = await requireUser(request);
      const id = intentId(request);
      const leg = legOf(request);
      if (!id || leg === null) return { ok: false, why: 'That is not a purchase id.' };
      const done = await abandonStudioPurchase(id, leg);
      await ops.audit({ actorUserId: user.id, action: 'studio.purchase.not_sent', entityType: 'studio_purchase', entityId: id, data: { leg, ok: done.ok } });
      return done;
    }),
  );
}
