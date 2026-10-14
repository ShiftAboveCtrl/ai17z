import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { trading } from '@xbam/database';
import { AssetRef, MarketSnapshot, type TradeMandate } from '@xbam/shared/contracts';
import {
  base58,
  createWallet,
  messageSha256,
  registerMarketReader,
  registerWalletAdapter,
  SWAP_PROGRAMS,
  type MarketReader,
  type WalletAdapter,
} from '@xbam/runtime';
import { JUPITER_SWAP_FAMILY, defineUpstream, perSecond, registerUpstream, type SwapQuoteQuery, type SwapQuoteResult } from '@xbam/upstream';
import { buildTransaction, keyFor, withSignature } from './solanaTx';

/**
 * A live Solana swap with everything outside this process stood in for: a
 * market reader, Jupiter's router answering with a recorded order, and a
 * wallet adapter that builds a real v0 transaction around a key nobody owns.
 * Nothing here can reach a chain. Shared by tests that need a trade to get as
 * far as a digest and a hash without one.
 */

export const SOL = AssetRef.parse({ kind: 'ONCHAIN', network: 'solana', address: 'So11111111111111111111111111111111111111112', decimals: 9, symbol: 'SOL' });
export const BONK = AssetRef.parse({ kind: 'ONCHAIN', network: 'solana', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5, symbol: 'BONK' });
const ORDER = JSON.parse(readFileSync(new URL('../fixtures/jupiter-swap-v2-order.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const SECRET = new Uint8Array(randomBytes(32));
export const LIVE_TX_HASH = '5'.repeat(88);
export const LIVE_WALLET = base58(Uint8Array.from([9, ...SECRET.subarray(1)]));

const snap = (): MarketSnapshot =>
  MarketSnapshot.parse({
    venue: 'AMM_POOL_SOLANA', network: 'solana', asset: BONK, quoteAsset: SOL, atBlock: null, observedAt: new Date().toISOString(),
    priceBaseUnits: '30', liquidityBase: '500000000000000', feeMicroBps: 2_500, phase: 'POOL', source: 'fake-reader',
  });

const reader: MarketReader = { id: 'fake', version: '1', venues: ['AMM_POOL_SOLANA'], async read() { return snap(); } };

export function liveAdapter(held: { amount: string } = { amount: '0' }) {
  const calls = { sign: 0, broadcast: 0 };
  const tx = buildTransaction({ feePayer: LIVE_WALLET, instructions: [{ program: SWAP_PROGRAMS[0]!, accounts: [LIVE_WALLET, keyFor(30)], data: [1] }] });
  const a: WalletAdapter = {
    id: 'fake-solana', version: '0', families: ['SOLANA'],
    generateSecret: () => SECRET,
    addressOf: () => LIVE_WALLET,
    validAddress: (_f, address) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address),
    balances: async () => [{ symbol: 'BONK', amount: held.amount, decimals: 5, token: BONK.kind === 'ONCHAIN' ? BONK.address : null }],
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
      // Shaped like a real Solana signature: base58, which Studio checks.
      return { txHash: LIVE_TX_HASH, raw: withSignature(tx) };
    },
    broadcast: async () => {
      calls.broadcast += 1;
    },
    receipt: async () => 'CONFIRMED',
  };
  return { a, calls };
}

export function liveRouter() {
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

export const liveMandate = (over: Record<string, unknown> = {}) =>
  ({
    mode: 'LIVE', approval: 'OWNER_APPROVES_EACH', venues: ['AMM_POOL_SOLANA'], networks: ['solana'], allowedAssets: [BONK],
    maxPerTrade: '1000000000', maxPerDay: '5000000000', maxOpenExposure: '5000000000', maxOpenPositions: 5,
    maxSlippageBps: 300, maxPriceImpactBps: 500, minLiquidityBase: '1', maxFeeBase: '100000000', quoteMaxAgeMs: 60_000, expiresAt: null, paused: false,
    ...over,
  }) as unknown as Omit<TradeMandate, 'id' | 'agentId'>;

/** A local agent with a Solana wallet and a LIVE mandate that requires approval of each trade. */
export async function liveAgent(f: { agentId: string; ownerId: string }, over: Record<string, unknown> = {}, held?: { amount: string }) {
  registerMarketReader(reader);
  liveRouter();
  const { a, calls } = liveAdapter(held);
  registerWalletAdapter(a);
  await createWallet({ agentId: f.agentId, ownerId: f.ownerId, family: 'SOLANA' });
  await trading.putMandate({ agentId: f.agentId, ownerId: f.ownerId, mandate: liveMandate(over) });
  return { calls };
}
