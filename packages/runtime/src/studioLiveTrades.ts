import { agents as agentsRepo, ops, trading, wallets as walletsRepo, type TradeIntentRow } from '@xbam/database';
import { createLogger, errorMessage } from '@xbam/shared';
import { AssetRef } from '@xbam/shared/contracts';
import { proposeLiveSwap, reconcileLiveSwap, withdrawLiveSwap } from './liveTrading';
import { readBalances } from './walletCore';
import { liveTradeSettled, liveTradeWaiting } from './notify';
import { studioLiveTradeReport, studioLiveTradesCollect, type StudioLiveRequest } from './studioLink';

const log = createLogger('studio-live-trades');

/**
 * Real trades a Studio agent asks this installation to carry out.
 *
 * ## The boundary
 *
 * Studio decides and holds no key. This installation holds the key, and the
 * owner approves here, by the digest of the exact transaction, through the
 * same `liveTrading.ts` path an owner's own trade takes. Nothing Studio sends
 * can approve, sign or send anything: what it can do is ask for a trade to be
 * prepared, and every rule a local trade passes is passed again here.
 *
 *   1. **Off until the owner says otherwise** (`studio.liveTrades`), and
 *      separate from control: steering agents and preparing trades are
 *      different things to have agreed to.
 *   2. **Bound by the owner.** A Studio agent is carried out by the local
 *      agent its owner chose here, whose mandate, wallet and limits apply. A
 *      Studio agent nobody bound is refused with a sentence.
 *   3. **Outbound only.** Collected on the worker's sweep; Studio never
 *      reaches this machine.
 *   4. **Exact asset.** The request names a mint; the swap is built for that
 *      mint and no other, and a symbol is never looked up.
 *   5. **Once.** The trade's idempotency key is the request's id, so a request
 *      delivered twice prepares one trade.
 *   6. **Reported, not trusted back.** Each step is told to Studio, which
 *      records it; nothing Studio answers changes what happens here.
 */

export const LIVE_TRADES_SETTING = 'studio.liveTrades';
const BINDINGS_SETTING = 'studio.liveTrades.bindings';
const REPORTED_SETTING = 'studio.liveTrades.reported';
const SEEN_SETTING = 'studio.liveTrades.seen';
const SEEN_KEPT = 50;
export const STUDIO_LIVE_KEY_PREFIX = 'studio-live:';
/** Requests one sweep prepares, so a backlog cannot hold the worker's loop. */
const PER_SWEEP = 5;
const REPORTED_KEPT = 300;

const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
const SOL = AssetRef.parse({ kind: 'ONCHAIN', network: 'solana', address: WRAPPED_SOL, decimals: 9, symbol: 'SOL' });
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface LiveTradesSetting {
  enabled: boolean;
  changedAt: string | null;
}

export async function studioLiveTradesSetting(): Promise<LiveTradesSetting> {
  return (await ops.getSetting<LiveTradesSetting>(LIVE_TRADES_SETTING)) ?? { enabled: false, changedAt: null };
}

export async function setStudioLiveTrades(enabled: boolean, by: string | null): Promise<LiveTradesSetting> {
  const next = { enabled, changedAt: new Date().toISOString() };
  await ops.setSetting(LIVE_TRADES_SETTING, next);
  await ops.audit({ actorUserId: by, action: enabled ? 'studio.liveTrades.enabled' : 'studio.liveTrades.disabled', entityType: 'settings', entityId: 'studio' });
  return next;
}

/** Which local agent carries out each Studio agent's real trades. */
export async function studioLiveBindings(): Promise<Record<string, string>> {
  return (await ops.getSetting<Record<string, string>>(BINDINGS_SETTING)) ?? {};
}

/** Binds a Studio agent to a local agent of this owner's, or unbinds it with null. */
export async function bindStudioAgent(studioAgentId: string, localAgentId: string | null, ownerId: string): Promise<Record<string, string>> {
  if (!/^[0-9a-f-]{36}$/i.test(studioAgentId)) throw new Error('That is not a Studio agent id.');
  const bindings = { ...(await studioLiveBindings()) };
  if (localAgentId === null) {
    delete bindings[studioAgentId];
  } else {
    const agent = await agentsRepo.getAgent(localAgentId);
    if (!agent || agent.ownerId !== ownerId) throw new Error('That is not one of your agents here.');
    bindings[studioAgentId] = localAgentId;
  }
  await ops.setSetting(BINDINGS_SETTING, bindings);
  await ops.audit({ actorUserId: ownerId, action: 'studio.liveTrades.bound', entityType: 'settings', entityId: studioAgentId });
  return bindings;
}

/** The Studio agents that have asked this installation for a trade, by id, with the name Studio gave: what the owner binds. */
export async function studioAgentsSeen(): Promise<Record<string, string>> {
  return (await ops.getSetting<Record<string, string>>(SEEN_SETTING)) ?? {};
}

async function noteSeen(requests: StudioLiveRequest[]): Promise<void> {
  if (!requests.length) return;
  const seen = { ...(await studioAgentsSeen()) };
  let changed = false;
  for (const r of requests) {
    const name = (r.agent_name ?? 'A Studio agent').slice(0, 80);
    if (seen[r.agent_id] !== name) {
      seen[r.agent_id] = name;
      changed = true;
    }
  }
  const keys = Object.keys(seen);
  for (const k of keys.slice(0, Math.max(0, keys.length - SEEN_KEPT))) delete seen[k];
  if (changed) await ops.setSetting(SEEN_SETTING, seen);
}

type StudioStatus = 'PREPARED' | 'APPROVED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'REFUSED' | 'EXPIRED';

/** A local trade's state, as Studio's request names it. Null for states that are not a step Studio follows. */
export function studioStatusOf(status: TradeIntentRow['status']): StudioStatus | null {
  switch (status) {
    case 'AWAITING_APPROVAL':
      return 'PREPARED';
    case 'APPROVED':
    case 'SIGNED':
      return 'APPROVED';
    case 'SUBMITTED':
    case 'UNKNOWN':
      return 'SUBMITTED';
    case 'CONFIRMED':
      return 'CONFIRMED';
    case 'FAILED':
      return 'FAILED';
    case 'RISK_REJECTED':
      return 'REFUSED';
    case 'EXPIRED':
    case 'CANCELLED':
      return 'EXPIRED';
    default:
      return null;
  }
}

async function remembered(): Promise<Record<string, string>> {
  return (await ops.getSetting<Record<string, string>>(REPORTED_SETTING)) ?? {};
}

async function remember(requestId: string, status: string): Promise<void> {
  const all = { ...(await remembered()), [requestId]: status };
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - REPORTED_KEPT))) delete all[k];
  await ops.setSetting(REPORTED_SETTING, all);
}

/** Tells Studio one step, once per step: a report that did not arrive is sent again on the next sweep. */
async function report(requestId: string, body: Record<string, unknown>): Promise<void> {
  const told = await studioLiveTradeReport(requestId, body);
  if (told.ok) await remember(requestId, String(body.status));
  else log.warn('could not tell Studio about a live trade', { requestId, why: told.why });
}

/** What a prepared or finished trade tells Studio: its own id, the wallet, the digest and the amounts the exact transaction simulated. */
async function factsOf(row: TradeIntentRow): Promise<Record<string, unknown>> {
  const sim = (row.simulation ?? {}) as { walletIntentId?: string; digest?: string };
  const wallet = sim.walletIntentId ? await walletsRepo.getIntent(sim.walletIntentId) : null;
  const pinned = (wallet?.simulation as { pinned?: Record<string, unknown> } | null)?.pinned ?? {};
  const address = wallet ? (await walletsRepo.getWallet(wallet.walletId))?.address : undefined;
  const out = typeof pinned.simulatedOut === 'string' && /^\d+$/.test(pinned.simulatedOut) ? pinned.simulatedOut : undefined;
  const receipt = (row.receipt ?? {}) as { txHash?: string };
  return {
    trade_intent_id: row.id,
    ...(address ? { wallet_address: address } : {}),
    ...(sim.digest ? { digest: sim.digest } : {}),
    in_base: row.maxIn,
    ...(out ? { out_base: out, amounts_from: 'SIMULATION' } : {}),
    ...(receipt.txHash ? { tx_hash: receipt.txHash } : {}),
  };
}

/** Prepares one request: the same `proposeLiveSwap` an owner's own trade takes, under the bound agent's mandate. */
async function prepare(request: StudioLiveRequest, localAgentId: string): Promise<void> {
  const agent = await agentsRepo.getAgent(localAgentId);
  if (!agent) return report(request.id, { status: 'REFUSED', detail: 'The agent chosen to carry out these trades no longer exists on this AI17Z.' });
  if (!MINT.test(request.mint)) return report(request.id, { status: 'REFUSED', detail: 'That is not a Solana mint address.' });
  if (request.mint === WRAPPED_SOL) return report(request.id, { status: 'REFUSED', detail: 'A trade here is between SOL and another token.' });
  const token = AssetRef.parse({ kind: 'ONCHAIN', network: 'solana', address: request.mint, decimals: request.decimals, ...(request.symbol ? { symbol: request.symbol.slice(0, 32) } : {}) });

  let maxIn: string;
  if (request.side === 'BUY') {
    if (!request.spend_lamports || !/^\d+$/.test(request.spend_lamports) || BigInt(request.spend_lamports) <= 0n) return report(request.id, { status: 'REFUSED', detail: 'The amount to spend is not a positive number of lamports.' });
    maxIn = request.spend_lamports;
  } else {
    if (!request.sell_base || !/^\d+$/.test(request.sell_base) || BigInt(request.sell_base) <= 0n) return report(request.id, { status: 'REFUSED', detail: 'The amount to sell is not a positive number.' });
    // Never more than the wallet holds: Studio's book is what was confirmed, and this is what is there.
    const held = await readBalances(localAgentId, 'solana')
      .then((r) => r.balances.find((b) => b.token === request.mint)?.amount ?? null)
      .catch(() => null);
    if (held !== null && BigInt(held) <= 0n) return report(request.id, { status: 'REFUSED', detail: 'The wallet holds none of that token, so there is nothing to sell.' });
    maxIn = held !== null && BigInt(held) < BigInt(request.sell_base) ? held : request.sell_base;
  }

  const proposed = await proposeLiveSwap({
    agentId: localAgentId,
    ownerId: agent.ownerId,
    venue: 'AMM_POOL_SOLANA',
    side: request.side,
    assetIn: request.side === 'BUY' ? SOL : token,
    assetOut: request.side === 'BUY' ? token : SOL,
    subject: token,
    maxIn,
    maxSlippageBps: Math.max(1, Math.min(1_000, request.max_slippage_bps)),
    // A protective sale accepts a worse price than an entry, because a stop that does not fill protects nothing.
    maxPriceImpactBps: request.protective ? 1_500 : 500,
    maxFeeBase: request.side === 'BUY' ? maxIn : '100000000',
    idempotencyKey: `${STUDIO_LIVE_KEY_PREFIX}${request.id}`,
  });
  switch (proposed.outcome) {
    case 'PROPOSED':
      await liveTradeWaiting({
        tradeIntentId: proposed.tradeIntent.id,
        agentName: request.agent_name ?? 'A Studio agent',
        summary: request.side === 'BUY' ? `A buy of ${request.symbol ?? request.mint.slice(0, 6)} spending ${(Number(maxIn) / 1e9).toFixed(4)} SOL.` : `A sale of ${request.symbol ?? request.mint.slice(0, 6)}.`,
        protective: request.protective,
      }).catch((error) => log.warn('could not raise a waiting live trade', { message: errorMessage(error) }));
      return report(request.id, { status: 'PREPARED', detail: request.protective ? 'Prepared as an urgent protective sale. Review and approve it on this AI17Z.' : 'Prepared. Review and approve it on this AI17Z.', ...(await factsOf(proposed.tradeIntent)) });
    case 'REFUSED':
      return report(request.id, { status: 'REFUSED', detail: proposed.verdict.reasons.map((r) => r.detail).join(' ').slice(0, 480) || 'The mandate refused it.' });
    case 'NOT_LIVE':
      return report(request.id, { status: 'REFUSED', detail: proposed.detail.slice(0, 480) });
    case 'NO_MARKET':
    case 'SIMULATION_FAILED':
      return report(request.id, { status: 'FAILED', detail: proposed.detail.slice(0, 480) });
  }
}

/**
 * One sweep: collect, withdraw what was cancelled, prepare what is new, and
 * tell Studio every step since the last sweep. Sent trades are asked about by
 * hash, which reads the chain and never sends anything again.
 */
export async function sweepStudioLiveTrades(now = Date.now()): Promise<{ prepared: number; reported: number; skipped?: string }> {
  const setting = await studioLiveTradesSetting();
  if (!setting.enabled) return { prepared: 0, reported: 0, skipped: 'off' };
  const collected = await studioLiveTradesCollect();
  if (!collected.ok) return { prepared: 0, reported: 0, skipped: collected.why };
  const bindings = await studioLiveBindings();
  await noteSeen(collected.requests);

  for (const id of collected.cancelled) {
    const row = await trading.intentByKey(`${STUDIO_LIVE_KEY_PREFIX}${id}`);
    if (row) await withdrawLiveSwap(row.id, (await agentsRepo.getAgent(row.agentId))?.ownerId ?? '', 'Its owner withdrew it in Studio.').catch(() => undefined);
  }

  let prepared = 0;
  for (const request of collected.requests) {
    if (await trading.intentByKey(`${STUDIO_LIVE_KEY_PREFIX}${request.id}`)) continue;
    if (Date.parse(request.expires_at) <= now) {
      await report(request.id, { status: 'EXPIRED', detail: 'It arrived after the agent stopped meaning it.' });
      continue;
    }
    const local = bindings[request.agent_id];
    if (!local) {
      await report(request.id, { status: 'REFUSED', detail: "No agent on this AI17Z is chosen to carry out this Studio agent's trades." });
      continue;
    }
    if (prepared >= PER_SWEEP) break;
    try {
      await prepare(request, local);
    } catch (error) {
      await report(request.id, { status: 'FAILED', detail: `It could not be prepared: ${errorMessage(error).slice(0, 300)}` });
    }
    prepared += 1;
  }

  // Every trade this bridge follows, each step told once.
  const told = await remembered();
  let reported = 0;
  for (const row of await trading.intentsByKeyPrefix(STUDIO_LIVE_KEY_PREFIX)) {
    let current = row;
    if (current.status === 'SUBMITTED' || current.status === 'UNKNOWN') {
      const owner = (await agentsRepo.getAgent(current.agentId))?.ownerId;
      if (owner) current = await reconcileLiveSwap(current.id, owner).catch(() => current);
    }
    const status = studioStatusOf(current.status);
    if (status && status !== 'PREPARED') await liveTradeSettled(current.id).catch(() => undefined);
    const requestId = current.idempotencyKey.slice(STUDIO_LIVE_KEY_PREFIX.length);
    if (!status || told[requestId] === status) continue;
    await report(requestId, { status, ...(current.error ? { detail: current.error.slice(0, 480) } : {}), ...(await factsOf(current)) });
    reported += 1;
  }
  return { prepared, reported };
}
