import { afterEach, describe, expect, it } from 'vitest';
import { query, trading, wallets } from '@xbam/database';
import {
  approveLiveSwap,
  guardLivePositions,
  proposeLiveSwap,
  protectiveTrigger,
  reconcileLiveSwap,
  resetMarketReadersForTest,
  resetWalletAdapterForTest,
  setPauseAll,
  submitLiveSwap,
} from '@xbam/runtime';
import { resetUpstreamsForTest } from '@xbam/upstream';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { BONK, SOL, liveAgent, liveMarket, resetLiveMarket } from '../support/liveSwap';

/**
 * The guardian on the owner's machine, which sells a real position without
 * waking anybody when, and only when, the owner preauthorized it. What is
 * pinned: a stop, a trailing stop and a liquidity floor each sell the whole
 * position once; nothing is sold without a policy, while paused, or at worse
 * bounds than the owner wrote; it never buys; two guardians at once sell once;
 * and every exit says in the audit that the policy approved it.
 */

installHarness();
afterEach(async () => {
  resetMarketReadersForTest();
  resetWalletAdapterForTest();
  resetUpstreamsForTest();
  resetLiveMarket();
  await setPauseAll({ paused: false, by: null });
});

const POLICY = { stopLossBps: 2_000, trailingBps: 2_500, liquidityFloorBase: '1000000000', honorStudioProtective: true, maxSlippageBps: 800, maxPriceImpactBps: 1_500, maxFeeBase: '5000000' };

/** A live agent that bought 0.01 SOL of BONK for real, approved and confirmed, and whose wallet now holds it. */
async function holding(policy: typeof POLICY | null = POLICY) {
  const f = await createFixture();
  const held = { amount: '0' };
  const { calls } = await liveAgent(f, { protectiveExits: policy }, held);
  const buy = await proposeLiveSwap({ agentId: f.agentId, ownerId: f.ownerId, venue: 'AMM_POOL_SOLANA', side: 'BUY', assetIn: SOL, assetOut: BONK, subject: BONK, maxIn: '10000000', maxSlippageBps: 100, maxPriceImpactBps: 500, maxFeeBase: '100000000', idempotencyKey: `buy-${f.agentId}` });
  if (buy.outcome !== 'PROPOSED') throw new Error(buy.outcome);
  await approveLiveSwap(buy.tradeIntent.id, f.ownerId, buy.digest);
  await submitLiveSwap(buy.tradeIntent.id, f.ownerId);
  expect((await reconcileLiveSwap(buy.tradeIntent.id, f.ownerId)).status).toBe('CONFIRMED');
  // What the chain says the wallet holds: what the buy delivered.
  const wallet = (await wallets.getIntent((buy.tradeIntent.simulation as { walletIntentId: string } | null)?.walletIntentId ?? ((await trading.getIntent(buy.tradeIntent.id))!.simulation as { walletIntentId: string }).walletIntentId))!;
  held.amount = String((wallet.simulation as unknown as { pinned: { simulatedOut: string } }).pinned.simulatedOut);
  return { f, held, calls };
}

const sales = async (agentId: string) => (await trading.listIntents(agentId)).filter((r) => r.side === 'SELL');

describe('when a protective exit is due', () => {
  it('does nothing while the position is inside the policy', async () => {
    const { f, calls } = await holding();
    expect(await guardLivePositions()).toMatchObject({ watched: 1, exits: 0 });
    expect(await sales(f.agentId)).toEqual([]);
    expect(calls.sign).toBe(1);
  });

  it('sells the whole position once at the stop, approved by the policy and said so, and never buys', async () => {
    const { f, held, calls } = await holding();
    liveMarket.price = '10';
    expect((await guardLivePositions()).exits).toBe(1);
    const [sale] = await sales(f.agentId);
    expect(sale).toMatchObject({ side: 'SELL', status: 'SUBMITTED', maxIn: held.amount, maxSlippageBps: 800 });
    expect(sale!.assetOut).toMatchObject({ address: SOL.kind === 'ONCHAIN' ? SOL.address : '' });
    expect(calls).toEqual({ sign: 2, broadcast: 2 });
    const audit = await query<{ action: string; data: Record<string, unknown> }>(`SELECT action, data FROM audit_events WHERE action = 'live.protective_exit.approved_by_policy'`);
    expect(audit.at(-1)!.data).toMatchObject({ trigger: 'STOP_LOSS', tradeIntentId: sale!.id });
    // The next pass, and the one after, do not sell again what is already being sold.
    await guardLivePositions();
    await guardLivePositions();
    expect(await sales(f.agentId)).toHaveLength(1);
    expect(calls.sign).toBe(2);
  });

  it('sells on a trailing stop once the price had gone above cost, and on a pool losing its depth', async () => {
    const trailing = await holding();
    liveMarket.price = '60';
    await guardLivePositions();
    liveMarket.price = '40';
    expect((await guardLivePositions()).exits).toBe(1);
    expect((await sales(trailing.f.agentId))[0]).toMatchObject({ status: 'SUBMITTED' });

    resetLiveMarket();
    const thin = await holding();
    liveMarket.liquidity = '10';
    expect((await guardLivePositions()).exits).toBe(1);
    expect(await sales(thin.f.agentId)).toHaveLength(1);
  });

  it('waits for the owner without a policy, and sends nothing while everything is paused', async () => {
    const unprotected = await holding(null);
    liveMarket.price = '1';
    expect((await guardLivePositions()).exits).toBe(0);
    expect(await sales(unprotected.f.agentId)).toEqual([]);

    resetLiveMarket();
    const paused = await holding();
    await setPauseAll({ paused: true, by: null });
    liveMarket.price = '1';
    await guardLivePositions();
    expect(paused.calls.sign).toBe(1);
  });

  it('sells once when two guardians run at the same moment', async () => {
    const { f, calls } = await holding();
    liveMarket.price = '10';
    await Promise.all([guardLivePositions(), guardLivePositions(), guardLivePositions()]);
    expect(await sales(f.agentId)).toHaveLength(1);
    expect(calls.sign).toBe(2);
  });
});

describe('the trigger itself', () => {
  const policy = { stopLossBps: 2_000, trailingBps: 2_500, liquidityFloorBase: '1000' };
  const at = (price: string, liquidity: string | null = '5000') => ({ priceBaseUnits: price, liquidityBase: liquidity });

  it('is exact at its edges and treats an unknown depth as no reason to sell', () => {
    expect(protectiveTrigger(policy, { averageCost: 100n, peak: 100n }, at('81'))).toBeNull();
    expect(protectiveTrigger(policy, { averageCost: 100n, peak: 100n }, at('80'))).toMatchObject({ trigger: 'STOP_LOSS' });
    expect(protectiveTrigger(policy, { averageCost: 100n, peak: 200n }, at('151'))).toBeNull();
    expect(protectiveTrigger(policy, { averageCost: 100n, peak: 200n }, at('150'))).toMatchObject({ trigger: 'TRAILING_STOP' });
    // A trailing stop protects a gain; below cost it is the stop's job.
    expect(protectiveTrigger({ ...policy, stopLossBps: null }, { averageCost: 100n, peak: 90n }, at('60'))).toBeNull();
    expect(protectiveTrigger(policy, { averageCost: 100n, peak: 100n }, at('100', '999'))).toMatchObject({ trigger: 'LIQUIDITY_FLOOR' });
    expect(protectiveTrigger(policy, { averageCost: 100n, peak: 100n }, at('100', null))).toBeNull();
  });
});
