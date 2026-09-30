import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  approveIntent,
  confirmWalletBackup,
  createWallet,
  draftIntent,
  intentsOf,
  readBalances,
  reconcileIntent,
  rejectIntent,
  simulateIntent,
  submitIntent,
  walletReadiness,
  walletsOf,
} from '@xbam/runtime';
import { WALLET_NETWORKS, WALLET_NETWORK_IDS, WalletFamily } from '@xbam/shared/contracts';
import { handler, params, parseBody, requireUser } from '../http';

/**
 * An agent's own wallet, for its owner. The only routes through which a
 * transaction is drafted, simulated, approved or sent, and every one resolves
 * the agent through the signed-in owner. No response carries a secret; the
 * wallet rows these return never include one.
 */
export async function walletRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/agents/:id/wallets',
    handler(async (request) => {
      const user = await requireUser(request);
      const agentId = params(request).id!;
      const [wallets, intents] = await Promise.all([walletsOf(agentId, user.id), intentsOf(agentId, user.id)]);
      return { readiness: walletReadiness(), networks: WALLET_NETWORKS, wallets, intents };
    }),
  );

  app.post(
    '/api/agents/:id/wallets',
    handler(async (request) => {
      const user = await requireUser(request);
      const body = parseBody(z.object({ family: WalletFamily }), request);
      return { wallet: await createWallet({ agentId: params(request).id!, ownerId: user.id, family: body.family }) };
    }),
  );

  app.post(
    '/api/wallets/:id/backed-up',
    handler(async (request) => ({ wallet: await confirmWalletBackup(params(request).id!, (await requireUser(request)).id) })),
  );

  app.get(
    '/api/agents/:id/wallets/balances',
    handler(async (request) => {
      const user = await requireUser(request);
      const agentId = params(request).id!;
      await walletsOf(agentId, user.id);
      const out: Record<string, unknown> = {};
      for (const network of WALLET_NETWORK_IDS) {
        out[network] = await readBalances(agentId, network).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
      }
      return { balances: out };
    }),
  );

  app.post(
    '/api/agents/:id/wallet-intents',
    handler(async (request) => {
      const user = await requireUser(request);
      const body = parseBody(z.object({ params: z.unknown(), idempotencyKey: z.string().trim().min(8).max(100).optional() }), request);
      return draftIntent({ agentId: params(request).id!, ownerId: user.id, params: body.params, idempotencyKey: body.idempotencyKey });
    }),
  );

  app.post(
    '/api/wallet-intents/:id/simulate',
    handler(async (request) => ({ intent: await simulateIntent(params(request).id!, (await requireUser(request)).id) })),
  );

  app.post(
    '/api/wallet-intents/:id/approve',
    handler(async (request) => {
      const user = await requireUser(request);
      const body = parseBody(z.object({ digest: z.string().trim().regex(/^[0-9a-f]{64}$/i) }), request);
      return { intent: await approveIntent(params(request).id!, user.id, body.digest) };
    }),
  );

  app.post(
    '/api/wallet-intents/:id/submit',
    handler(async (request) => ({ intent: await submitIntent(params(request).id!, (await requireUser(request)).id) })),
  );

  app.post(
    '/api/wallet-intents/:id/reject',
    handler(async (request) => ({ intent: await rejectIntent(params(request).id!, (await requireUser(request)).id) })),
  );

  app.post(
    '/api/wallet-intents/:id/reconcile',
    handler(async (request) => ({ intent: await reconcileIntent(params(request).id!, (await requireUser(request)).id) })),
  );
}
