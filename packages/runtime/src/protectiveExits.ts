import { agents as agentsRepo, ops, trading, wallets as walletsRepo, type TradeIntentRow, type TradeMandateRow } from '@xbam/database';
import { createLogger, errorMessage } from '@xbam/shared';
import { AssetRef, type MarketSnapshot, type ProtectiveExitPolicy } from '@xbam/shared/contracts';
import { approveLiveSwap, proposeLiveSwap, reconcileLiveSwap, submitLiveSwap } from './liveTrading';
import { readMarket } from './marketData';
import { readBalances } from './walletCore';

const log = createLogger('protective-exits');

/**
 * The guardian on the owner's own machine: it watches what an agent really
 * holds and sells it, without waking anybody, when the owner preauthorized
 * that sale.
 *
 * ## Why it lives here
 *
 * Studio's guardian decides and asks; this one can act, because the key is
 * here. It does not depend on Studio being reachable, on a model answering
 * or on the hourly cycle. If Studio is down a stop still fires.
 *
 * ## What it may do, and nothing else
 *
 * Only what `trade_mandates.protective_exits` says, which only the owner
 * writes: sell everything of a token the agent's own wallet holds, back to
 * SOL, into that wallet, when the price is past the stop, has fallen past the
 * trailing distance from its best, or the pool's depth is below the floor. It
 * never buys and never widens anything. It goes through `proposeLiveSwap`,
 * which builds and simulates the exact transaction and asks the same risk
 * verdict as any trade, so a pause stops it and a mandate gone back to paper
 * stops it. The only step it takes in the owner's place is approving the digest
 * of that exact sale, and the audit row says it was the policy that did.
 *
 * ## Once
 *
 * One exit in flight per position. An exit whose outcome is unknown is asked
 * about by hash and never sent again; one that failed may be tried again a
 * minute later, under a new key, because a stop that gives up protects nothing.
 */

const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
const SOL = AssetRef.parse({
  kind: 'ONCHAIN',
  network: 'solana',
  address: WRAPPED_SOL,
  decimals: 9,
  symbol: 'SOL',
});
const OPEN: TradeIntentRow['status'][] = ['DRAFTED', 'SIMULATED', 'AWAITING_APPROVAL', 'APPROVED', 'SIGNED', 'SUBMITTED', 'UNKNOWN'];
/** How often a failed exit may be tried again. */
const RETRY_MS = 60_000;

export type ProtectiveTrigger = 'STOP_LOSS' | 'TRAILING_STOP' | 'LIQUIDITY_FLOOR';

/**
 * Whether a position is past what the owner preauthorized, from the price now
 * (quote base units per whole token), the average cost in the same units, and
 * the best price seen since entry. Pure, so every edge is a test.
 */
export function protectiveTrigger(
  policy: Pick<ProtectiveExitPolicy, 'stopLossBps' | 'trailingBps' | 'liquidityFloorBase'>,
  position: { averageCost: bigint; peak: bigint | null },
  snapshot: Pick<MarketSnapshot, 'priceBaseUnits' | 'liquidityBase'>,
): { trigger: ProtectiveTrigger; sentence: string } | null {
  const price = BigInt(snapshot.priceBaseUnits);
  if (policy.liquidityFloorBase !== null && snapshot.liquidityBase !== null && BigInt(snapshot.liquidityBase) < BigInt(policy.liquidityFloorBase)) {
    return {
      trigger: 'LIQUIDITY_FLOOR',
      sentence: `The pool's depth is below the floor you set, so everything is sold while it still can be.`,
    };
  }
  if (policy.stopLossBps !== null && position.averageCost > 0n && price * 10_000n <= position.averageCost * BigInt(10_000 - policy.stopLossBps)) {
    return {
      trigger: 'STOP_LOSS',
      sentence: `The price is ${(policy.stopLossBps / 100).toFixed(0)} per cent or more below what it cost, past the stop you set.`,
    };
  }
  // A trailing stop protects a gain: it applies once the best price has been above the cost.
  if (policy.trailingBps !== null && position.peak !== null && position.peak > position.averageCost && price * 10_000n <= position.peak * BigInt(10_000 - policy.trailingBps)) {
    return {
      trigger: 'TRAILING_STOP',
      sentence: `The price has fallen ${(policy.trailingBps / 100).toFixed(0)} per cent or more from its best since entry, past the trailing stop you set.`,
    };
  }
  return null;
}

interface LivePosition {
  mint: string;
  decimals: number;
  symbol: string | undefined;
  /** What the wallet holds now, in the token's base units: the truth, read from the chain. */
  held: bigint;
  /** Lamports per whole token, from what the confirmed buys spent and received. */
  averageCost: bigint;
  /** The last confirmed buy, which names the position for idempotency. */
  openedBy: string;
}

/** What one agent's confirmed live buys add up to, held against what its wallet really holds now. */
async function positionsOf(agentId: string): Promise<LivePosition[]> {
  const rows = (await trading.listIntents(agentId, 200)).filter((r) => r.mode === 'LIVE' && r.status === 'CONFIRMED');
  const byMint = new Map<
    string,
    {
      decimals: number;
      symbol?: string;
      spent: bigint;
      bought: bigint;
      openedBy: string;
    }
  >();
  for (const r of [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (r.side !== 'BUY' || r.assetOut.kind !== 'ONCHAIN') continue;
    const sim = (r.simulation ?? {}) as { walletIntentId?: string };
    const wallet = sim.walletIntentId ? await walletsRepo.getIntent(sim.walletIntentId) : null;
    const out = (wallet?.simulation as { pinned?: { simulatedOut?: unknown } } | null)?.pinned?.simulatedOut;
    const bought = typeof out === 'string' && /^\d+$/.test(out) ? BigInt(out) : BigInt(r.minOut);
    const p = byMint.get(r.assetOut.address) ?? {
      decimals: r.assetOut.decimals,
      symbol: r.assetOut.symbol,
      spent: 0n,
      bought: 0n,
      openedBy: r.id,
    };
    p.spent += BigInt(r.maxIn);
    p.bought += bought;
    p.openedBy = r.id;
    byMint.set(r.assetOut.address, p);
  }
  if (!byMint.size) return [];
  const balances = await readBalances(agentId, 'solana')
    .then((b) => b.balances)
    .catch(() => null);
  if (!balances) return [];
  const out: LivePosition[] = [];
  for (const [mint, p] of byMint) {
    const held = BigInt(balances.find((b) => b.token === mint)?.amount ?? '0');
    if (held <= 0n || p.bought <= 0n) continue;
    out.push({
      mint,
      decimals: p.decimals,
      symbol: p.symbol,
      held,
      averageCost: (p.spent * 10n ** BigInt(p.decimals)) / p.bought,
      openedBy: p.openedBy,
    });
  }
  return out;
}

const peakKey = (agentId: string, mint: string) => `protective.peak:${agentId}:${mint}`;

/**
 * Sells one position under the owner's preauthorization: proposed and judged
 * like any trade, approved by the policy on the digest of exactly what was
 * simulated, and sent once. Returns what happened, in a sentence.
 */
export async function executeProtectiveExit(input: {
  mandate: TradeMandateRow;
  ownerId: string;
  mint: string;
  decimals: number;
  symbol?: string;
  amount: bigint;
  trigger: ProtectiveTrigger | 'STUDIO_GUARDIAN';
  idempotencyKey: string;
  existing?: TradeIntentRow;
}): Promise<{ sent: boolean; detail: string; tradeIntent?: TradeIntentRow }> {
  const policy = input.mandate.protectiveExits;
  if (!policy)
    return {
      sent: false,
      detail: 'No protective exits are preauthorized, so this one waits for the owner.',
    };
  let row = input.existing;
  let digest: string | null = null;
  if (!row) {
    const token = AssetRef.parse({
      kind: 'ONCHAIN',
      network: 'solana',
      address: input.mint,
      decimals: input.decimals,
      ...(input.symbol ? { symbol: input.symbol.slice(0, 32) } : {}),
    });
    const proposed = await proposeLiveSwap({
      agentId: input.mandate.agentId,
      ownerId: input.ownerId,
      venue: 'AMM_POOL_SOLANA',
      side: 'SELL',
      assetIn: token,
      assetOut: SOL,
      subject: token,
      maxIn: input.amount.toString(),
      maxSlippageBps: policy.maxSlippageBps,
      maxPriceImpactBps: policy.maxPriceImpactBps,
      maxFeeBase: policy.maxFeeBase,
      idempotencyKey: input.idempotencyKey,
    });
    if (proposed.outcome !== 'PROPOSED') {
      const why = proposed.outcome === 'REFUSED' ? proposed.verdict.reasons.map((r) => r.detail).join(' ') : proposed.detail;
      return { sent: false, detail: why };
    }
    row = proposed.tradeIntent;
    digest = proposed.digest;
  } else {
    digest = (row.simulation as { digest?: string } | null)?.digest ?? null;
  }
  // The policy's bounds, held to the exact sale that was built: never wider than what the owner wrote.
  if (row.side !== 'SELL' || row.assetOut.kind !== 'ONCHAIN' || row.assetOut.address !== WRAPPED_SOL) return { sent: false, detail: 'A protective exit only ever sells back to SOL.', tradeIntent: row };
  if (row.maxSlippageBps > policy.maxSlippageBps || row.maxPriceImpactBps > policy.maxPriceImpactBps || BigInt(row.maxFeeBase) > BigInt(policy.maxFeeBase)) {
    return {
      sent: false,
      detail: 'The exit would need more slippage, impact or fee than you preauthorized, so it waits for you.',
      tradeIntent: row,
    };
  }
  // Proposed already under this key and past waiting: that sale is the sale, and it is not approved twice.
  if (row.status !== 'AWAITING_APPROVAL') return { sent: false, detail: `This exit is already ${row.status.toLowerCase()}.`, tradeIntent: row };
  if (!digest) return { sent: false, detail: 'The exit has no simulated transaction to approve.', tradeIntent: row };
  await approveLiveSwap(row.id, input.ownerId, digest);
  await ops.audit({
    actorUserId: null,
    action: 'live.protective_exit.approved_by_policy',
    entityType: 'agent',
    entityId: input.mandate.agentId,
    data: {
      tradeIntentId: row.id,
      mandateId: input.mandate.id,
      trigger: input.trigger,
      mint: input.mint,
      amount: input.amount.toString(),
    },
  });
  const sent = await submitLiveSwap(row.id, input.ownerId);
  if (!sent.sent) return { sent: false, detail: sent.why.join(' '), tradeIntent: row };
  return {
    sent: true,
    detail: `Sold under your preauthorized ${input.trigger.toLowerCase().replace(/_/g, ' ')}.`,
    tradeIntent: sent.tradeIntent,
  };
}

/**
 * One pass over every agent whose live mandate preauthorizes protective exits.
 * Cheap when there are none: one indexed query. Never throws.
 */
export async function guardLivePositions(now = Date.now()): Promise<{ watched: number; exits: number }> {
  let watched = 0;
  let exits = 0;
  for (const mandate of await trading.mandatesWithProtectiveExits()) {
    const policy = mandate.protectiveExits!;
    try {
      const agent = await agentsRepo.getAgent(mandate.agentId);
      if (!agent) continue;
      const held = await trading.withLiveExitLock(mandate.agentId, async () => {
        // Read inside the lock, so what is in flight is what the other process left.
        const intents = await trading.listIntents(mandate.agentId, 200);
        for (const position of await positionsOf(mandate.agentId)) {
          watched += 1;
          // One exit in flight per position; one whose outcome is unknown is asked about, never resent.
          const inFlight = intents.find((r) => r.side === 'SELL' && r.mode === 'LIVE' && OPEN.includes(r.status) && r.assetIn.kind === 'ONCHAIN' && r.assetIn.address === position.mint);
          if (inFlight) {
            if (inFlight.status === 'SUBMITTED' || inFlight.status === 'UNKNOWN') await reconcileLiveSwap(inFlight.id, agent.ownerId).catch(() => undefined);
            continue;
          }
          const token = AssetRef.parse({
            kind: 'ONCHAIN',
            network: 'solana',
            address: position.mint,
            decimals: position.decimals,
          });
          const read = await readMarket(token, 'AMM_POOL_SOLANA', SOL);
          if (read.outcome !== 'OK') {
            log.warn('a held position could not be priced', {
              agentId: mandate.agentId,
              mint: position.mint,
              why: read.detail,
            });
            continue;
          }
          const price = BigInt(read.snapshot.priceBaseUnits);
          const stored = await ops.getSetting<string>(peakKey(mandate.agentId, position.mint));
          const peak = stored && /^\d+$/.test(stored) && BigInt(stored) > price ? BigInt(stored) : price;
          if (!stored || BigInt(stored) !== peak) await ops.setSetting(peakKey(mandate.agentId, position.mint), peak.toString());
          const verdict = protectiveTrigger(policy, { averageCost: position.averageCost, peak }, read.snapshot);
          if (!verdict) continue;
          const done = await executeProtectiveExit({
            mandate,
            ownerId: agent.ownerId,
            mint: position.mint,
            decimals: position.decimals,
            symbol: position.symbol,
            amount: position.held,
            trigger: verdict.trigger,
            // A position and a minute: a failed exit is tried again, never twice at once.
            idempotencyKey: `protective:${position.openedBy}:${Math.floor(now / RETRY_MS)}`,
          });
          if (done.sent) exits += 1;
          log.info('protective exit', {
            agentId: mandate.agentId,
            mint: position.mint,
            trigger: verdict.trigger,
            sent: done.sent,
            detail: done.detail,
          });
        }
      });
      if (!held.ran) continue;
    } catch (error) {
      log.warn('protective exit pass failed for one agent', {
        agentId: mandate.agentId,
        message: errorMessage(error),
      });
    }
  }
  return { watched, exits };
}
