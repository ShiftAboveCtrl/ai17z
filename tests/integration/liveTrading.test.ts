import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trading, wallets } from '@xbam/database';
import { AssetRef, MarketSnapshot, type TradeMandate } from '@xbam/shared/contracts';
import {
  approveLiveSwap,
  base58,
  createWallet,
  messageSha256,
  proposeLiveSwap,
  reconcileLiveSwap,
  registerMarketReader,
  registerWalletAdapter,
  resetMarketReadersForTest,
  resetWalletAdapterForTest,
  setPauseAll,
  submitLiveSwap,
  SWAP_PROGRAMS,
  type MarketReader,
  type WalletAdapter,
} from '@xbam/runtime';
import {
  JUPITER_SWAP_FAMILY,
  defineUpstream,
  perSecond,
  registerUpstream,
  resetUpstreamsForTest,
  type SwapQuoteQuery,
  type SwapQuoteResult,
} from '@xbam/upstream';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { buildTransaction, keyFor, withSignature } from '../support/solanaTx';

/**
 * A live Solana trade from a decision to one transaction. What is pinned:
 * nothing is proposed under a paper or an autonomous mandate; a proposal is
 * one trade intent and one wallet intent, tied by key; approving the trade is
 * approving the wallet digest; sending asks `maySign` then, so a mandate put
 * back to paper, a pause or a stale quote sends nothing; a sent trade carries
 * its hash, and reconciling never resends.
 */

installHarness();

const SOL = AssetRef.parse({ kind: 'ONCHAIN', network: 'solana', address: 'So11111111111111111111111111111111111111112', decimals: 9, symbol: 'SOL' });
const BONK = AssetRef.parse({ kind: 'ONCHAIN', network: 'solana', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5, symbol: 'BONK' });
const ORDER = JSON.parse(readFileSync(new URL('../fixtures/jupiter-swap-v2-order.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const SECRET = new Uint8Array(randomBytes(32));
const WALLET = base58(Uint8Array.from([9, ...SECRET.subarray(1)]));

const snap = (): MarketSnapshot =>
  MarketSnapshot.parse({
    venue: 'AMM_POOL_SOLANA', network: 'solana', asset: BONK, quoteAsset: SOL, atBlock: null, observedAt: new Date().toISOString(),
    // 30 lamports for one whole BONK, roughly where it trades.
    priceBaseUnits: '30', liquidityBase: '500000000000000', feeMicroBps: 2_500, phase: 'POOL', source: 'fake-reader',
  });

const reader: MarketReader = { id: 'fake', version: '1', venues: ['AMM_POOL_SOLANA'], async read() { return snap(); } };

function adapter() {
  const calls = { sign: 0, broadcast: 0 };
  const tx = buildTransaction({ feePayer: WALLET, instructions: [{ program: SWAP_PROGRAMS[0]!, accounts: [WALLET, keyFor(30)], data: [1] }] });
  const a: WalletAdapter = {
    id: 'fake-solana', version: '0', families: ['SOLANA'],
    generateSecret: () => SECRET,
    addressOf: () => WALLET,
    validAddress: (_f, address) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address),
    balances: async () => [],
    networkStatus: async () => ({ reachable: true, height: '1', chainProof: 'solana', detail: 'ok' }),
    recentActivity: async () => [],
    simulate: async (_n, _from, intent) => {
      const floor = intent.kind === 'SOLANA_SWAP' ? BigInt(intent.minOut) : 0n;
      return {
        ok: true, maxFee: '5000', balanceBefore: '50000000', balanceAfter: '37955000', warnings: [], failure: null,
        pinned: {
          transaction: tx, messageSha256: messageSha256(tx), lastValidBlockHeight: '300000000', router: 'metis',
          quotedOut: (floor + 100n).toString(), quotedMinOut: floor.toString(), simulatedOut: (floor + 50n).toString(), simulatedNativeSpent: '12045000',
        },
      };
    },
    sign: async () => {
      calls.sign += 1;
      return { txHash: 'live' + 'x'.repeat(60), raw: withSignature(tx) };
    },
    broadcast: async () => {
      calls.broadcast += 1;
    },
    receipt: async () => 'CONFIRMED',
  };
  return { a, calls };
}

function router() {
  registerUpstream(
    defineUpstream<SwapQuoteQuery, SwapQuoteResult>({
      id: `${JUPITER_SWAP_FAMILY}.test`, family: JUPITER_SWAP_FAMILY, name: 'test', description: 'test', origin: 'router.example',
      limit: { concurrentPerProcess: 10, windows: [perSecond(100, { scope: 'MACHINE' })] }, timeoutMs: 1_000, freshMs: 0, rank: 1,
      cacheKey: (q) => q.amount,
      async fetch() {
        return { order: ORDER };
      },
    }),
  );
}

const mandate = (over: Record<string, unknown> = {}) =>
  ({
    mode: 'LIVE', approval: 'OWNER_APPROVES_EACH', venues: ['AMM_POOL_SOLANA'], networks: ['solana'], allowedAssets: [BONK],
    maxPerTrade: '1000000000', maxPerDay: '5000000000', maxOpenExposure: '5000000000', maxOpenPositions: 5,
    maxSlippageBps: 300, maxPriceImpactBps: 500, minLiquidityBase: '1', maxFeeBase: '100000000', quoteMaxAgeMs: 60_000, expiresAt: null, paused: false,
    ...over,
  }) as unknown as Omit<TradeMandate, 'id' | 'agentId'>;

async function setUp(over: Record<string, unknown> = {}) {
  const f = await createFixture();
  const { a, calls } = adapter();
  registerWalletAdapter(a);
  await createWallet({ agentId: f.agentId, ownerId: f.ownerId, family: 'SOLANA' });
  await trading.putMandate({ agentId: f.agentId, ownerId: f.ownerId, mandate: mandate(over) });
  return { f, calls };
}

const buy = (agentId: string, ownerId: string, idempotencyKey?: string) =>
  proposeLiveSwap({
    agentId, ownerId, venue: 'AMM_POOL_SOLANA', side: 'BUY', assetIn: SOL, assetOut: BONK, subject: BONK,
    maxIn: '10000000', maxSlippageBps: 100, maxPriceImpactBps: 500, maxFeeBase: '100000000', ...(idempotencyKey ? { idempotencyKey } : {}),
  });

beforeEach(() => {
  resetUpstreamsForTest();
  registerMarketReader(reader);
  router();
});
afterEach(async () => {
  resetMarketReadersForTest();
  resetWalletAdapterForTest();
  resetUpstreamsForTest();
  await setPauseAll({ paused: false, by: null });
});

describe('a live trade', () => {
  it('is never proposed under a paper mandate or one that asks for autonomy', async () => {
    const paper = await setUp({ mode: 'PAPER' });
    expect(await buy(paper.f.agentId, paper.f.ownerId)).toMatchObject({ outcome: 'NOT_LIVE', detail: expect.stringMatching(/paper/) });
    const auto = await setUp({ approval: 'AUTONOMOUS_WITHIN_MANDATE' });
    expect(await buy(auto.f.agentId, auto.f.ownerId)).toMatchObject({ outcome: 'NOT_LIVE', detail: expect.stringMatching(/approved/) });
    expect(await trading.listIntents(paper.f.agentId)).toHaveLength(0);
  });

  it('is one trade and one wallet transaction, approved by its digest and sent once', async () => {
    const { f, calls } = await setUp();
    const proposed = await buy(f.agentId, f.ownerId, 'decision-1');
    expect(proposed.outcome).toBe('PROPOSED');
    if (proposed.outcome !== 'PROPOSED') return;
    expect(proposed.tradeIntent.status).toBe('AWAITING_APPROVAL');
    const wallet = (await wallets.getIntent(proposed.walletIntentId))!;
    expect(wallet).toMatchObject({ status: 'AWAITING_APPROVAL', kind: 'SOLANA_SWAP', idempotencyKey: `trade-intent:${proposed.tradeIntent.id}` });
    // The floor on the wallet transaction is the trade's floor.
    expect((wallet.params as { minOut: string }).minOut).toBe(proposed.tradeIntent.minOut);

    // Proposed again under the same decision: the same two records.
    const again = await buy(f.agentId, f.ownerId, 'decision-1');
    expect(again).toMatchObject({ outcome: 'PROPOSED', walletIntentId: proposed.walletIntentId });

    await expect(approveLiveSwap(proposed.tradeIntent.id, f.ownerId, 'f'.repeat(64))).rejects.toThrow();
    await approveLiveSwap(proposed.tradeIntent.id, f.ownerId, proposed.digest);
    const sent = await submitLiveSwap(proposed.tradeIntent.id, f.ownerId);
    expect(sent).toMatchObject({ sent: true, tradeIntent: { status: 'SUBMITTED', receipt: { txHash: 'live' + 'x'.repeat(60) } } });
    expect(await submitLiveSwap(proposed.tradeIntent.id, f.ownerId)).toMatchObject({ sent: false });
    expect(calls).toEqual({ sign: 1, broadcast: 1 });
    expect((await reconcileLiveSwap(proposed.tradeIntent.id, f.ownerId)).status).toBe('CONFIRMED');
    expect(calls.broadcast).toBe(1);
  });

  it('sends nothing when the mandate went back to paper, everything is paused, or the quote went stale', async () => {
    const { f, calls } = await setUp();
    const approved = async (key: string) => {
      const p = await buy(f.agentId, f.ownerId, key);
      if (p.outcome !== 'PROPOSED') throw new Error(p.outcome);
      await approveLiveSwap(p.tradeIntent.id, f.ownerId, p.digest);
      return p.tradeIntent.id;
    };

    const stale = await approved('decision-stale');
    expect(await submitLiveSwap(stale, f.ownerId, Date.now() + 120_000)).toMatchObject({ sent: false, why: expect.arrayContaining([expect.stringMatching(/quote/i)]) });

    const paused = await approved('decision-paused');
    await setPauseAll({ paused: true, by: null });
    expect(await submitLiveSwap(paused, f.ownerId)).toMatchObject({ sent: false, why: expect.arrayContaining([expect.stringMatching(/pause/i)]) });
    await setPauseAll({ paused: false, by: null });

    const demoted = await approved('decision-demoted');
    await trading.putMandate({ agentId: f.agentId, ownerId: f.ownerId, mandate: mandate({ mode: 'PAPER' }) });
    expect(await submitLiveSwap(demoted, f.ownerId)).toMatchObject({ sent: false, why: expect.arrayContaining([expect.stringMatching(/PAPER/)]) });

    expect(calls.sign).toBe(0);
  });

  it('refuses a key too short to be one before writing anything', async () => {
    const { f } = await setUp();
    await expect(buy(f.agentId, f.ownerId, 'short')).rejects.toThrow(/eight/);
    expect(await trading.listIntents(f.agentId)).toHaveLength(0);
  });
});
