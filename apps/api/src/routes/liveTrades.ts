import type { FastifyInstance } from 'fastify';
import { agents as agentsRepo, trading, wallets as walletsRepo, type TradeIntentRow } from '@xbam/database';
import {
  approveLiveSwap,
  bindStudioAgent,
  refreshLiveSwap,
  setStudioLiveTrades,
  STUDIO_LIVE_KEY_PREFIX,
  studioAgentsSeen,
  studioLiveBindings,
  studioLiveTradesSetting,
  submitLiveSwap,
  withdrawLiveSwap,
} from '@xbam/runtime';
import { NotFoundError } from '@xbam/shared';
import { z } from 'zod';
import { handler, params, parseBody, requireUser } from '../http';

/**
 * Real trades waiting for their owner, and the switch that lets a Studio
 * agent ask for them.
 *
 * Owner control plane only: none of this is a capability, none of it is
 * reachable by a model, and approval is always of a digest the owner was
 * shown. "Review" builds the exact transaction afresh, because a Solana
 * transaction is only good for about a minute; "approve and send" approves
 * that digest and sends it at once, with every rule asked again at sending.
 */

type View = {
  id: string;
  agentId: string;
  agentName: string;
  side: string;
  status: string;
  spend: { amount: string; symbol: string; decimals: number };
  receive: { atLeast: string; symbol: string; decimals: number; simulated: string | null };
  digest: string | null;
  simulatedAt: string | null;
  warnings: string[];
  fromStudio: boolean;
  error: string | null;
  txHash: string | null;
  createdAt: string;
};

const symbolOf = (asset: unknown) => {
  const a = asset as { symbol?: string; address?: string; kind?: string };
  return a?.symbol ?? (a?.address ? `${a.address.slice(0, 4)}…` : 'SOL');
};
const decimalsOf = (asset: unknown) => (asset as { decimals?: number })?.decimals ?? 9;

async function view(row: TradeIntentRow, agentName: string): Promise<View> {
  const sim = (row.simulation ?? {}) as { walletIntentId?: string; digest?: string; simulatedAt?: string };
  const wallet = sim.walletIntentId ? await walletsRepo.getIntent(sim.walletIntentId) : null;
  const pinned = (wallet?.simulation as { pinned?: Record<string, unknown>; warnings?: string[] } | null) ?? null;
  return {
    id: row.id,
    agentId: row.agentId,
    agentName,
    side: row.side,
    status: row.status,
    spend: { amount: row.maxIn, symbol: symbolOf(row.assetIn), decimals: decimalsOf(row.assetIn) },
    receive: { atLeast: row.minOut, symbol: symbolOf(row.assetOut), decimals: decimalsOf(row.assetOut), simulated: typeof pinned?.pinned?.simulatedOut === 'string' ? pinned.pinned.simulatedOut : null },
    digest: wallet?.digest ?? sim.digest ?? null,
    simulatedAt: sim.simulatedAt ?? null,
    warnings: pinned?.warnings ?? [],
    fromStudio: row.idempotencyKey.startsWith(STUDIO_LIVE_KEY_PREFIX),
    error: row.error,
    txHash: (row.receipt as { txHash?: string } | null)?.txHash ?? null,
    createdAt: row.createdAt,
  };
}

const tradeId = (request: Parameters<typeof params>[0]) => {
  const id = params(request).id ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError('Live trade');
  return id;
};

/** The trade, only if it belongs to one of this owner's agents. */
async function owned(id: string, ownerId: string): Promise<{ row: TradeIntentRow; agentName: string }> {
  const row = await trading.getIntent(id);
  const agent = row ? await agentsRepo.getAgent(row.agentId) : null;
  if (!row || !agent || agent.ownerId !== ownerId || row.mode !== 'LIVE') throw new NotFoundError('Live trade');
  return { row, agentName: agent.name };
}

export async function liveTradeRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/live-trades',
    handler(async (request) => {
      const user = await requireUser(request);
      const out: View[] = [];
      for (const agent of await agentsRepo.listAgents(user.id)) {
        for (const row of await trading.listIntents(agent.id, 30)) {
          if (row.mode === 'LIVE') out.push(await view(row, agent.name));
        }
      }
      // Waiting first: a trade nobody approves expires, and a protective sale waiting is the one that costs money.
      out.sort((a, b) => Number(b.status === 'AWAITING_APPROVAL') - Number(a.status === 'AWAITING_APPROVAL') || b.createdAt.localeCompare(a.createdAt));
      return { trades: out.slice(0, 50) };
    }),
  );

  app.post(
    '/api/live-trades/:id/review',
    handler(async (request) => {
      const user = await requireUser(request);
      const { row, agentName } = await owned(tradeId(request), user.id);
      const fresh = await refreshLiveSwap(row.id, user.id);
      if (!fresh.ok) return { ok: false, why: fresh.why, trade: await view((await trading.getIntent(row.id))!, agentName) };
      return { ok: true, trade: await view(fresh.tradeIntent, agentName) };
    }),
  );

  app.post(
    '/api/live-trades/:id/approve',
    handler(async (request) => {
      const user = await requireUser(request);
      const body = parseBody(z.object({ digest: z.string().trim().regex(/^[0-9a-f]{64}$/i) }).strict(), request);
      const { row, agentName } = await owned(tradeId(request), user.id);
      await approveLiveSwap(row.id, user.id, body.digest);
      // Sent at once: the transaction approved is good for about a minute, and waiting only lets it go stale.
      const sent = await submitLiveSwap(row.id, user.id);
      return sent.sent ? { sent: true, trade: await view(sent.tradeIntent, agentName) } : { sent: false, why: sent.why, trade: await view((await trading.getIntent(row.id))!, agentName) };
    }),
  );

  app.post(
    '/api/live-trades/:id/reject',
    handler(async (request) => {
      const user = await requireUser(request);
      const { row, agentName } = await owned(tradeId(request), user.id);
      const done = await withdrawLiveSwap(row.id, user.id, 'You rejected it.');
      return { trade: await view(done ?? row, agentName) };
    }),
  );

  /*
    Whether a linked Studio's agents may ask this installation to prepare real
    trades, and which agent here carries out each one's. Off by default, and
    separate from control: steering agents and preparing trades are different
    things to have agreed to.
  */
  app.get(
    '/api/studio/live-trades',
    handler(async (request) => {
      await requireUser(request);
      return { ...(await studioLiveTradesSetting()), bindings: await studioLiveBindings(), seen: await studioAgentsSeen() };
    }),
  );

  app.put(
    '/api/studio/live-trades',
    handler(async (request) => {
      const user = await requireUser(request);
      const body = parseBody(z.object({ enabled: z.boolean() }).strict(), request);
      return { ...(await setStudioLiveTrades(body.enabled, user.id)), bindings: await studioLiveBindings() };
    }),
  );

  app.put(
    '/api/studio/live-trades/bindings',
    handler(async (request) => {
      const user = await requireUser(request);
      const body = parseBody(z.object({ studioAgentId: z.string().uuid(), localAgentId: z.string().uuid().nullable() }).strict(), request);
      return { bindings: await bindStudioAgent(body.studioAgentId, body.localAgentId, user.id) };
    }),
  );
}
