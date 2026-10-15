import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { trading } from '@xbam/database';
import { createWallet, judgeTrade, asMandate, registerWalletAdapter, resetWalletAdapterForTest } from '@xbam/runtime';
import { buildServer } from '../../apps/api/src/server';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { liveAdapter } from '../support/liveSwap';

/**
 * The owner writes an agent's mandate. What is pinned: SOL in, base units out,
 * and back again exactly; no autonomy is ever written; LIVE needs the wallet
 * that would sign; a policy with no trigger is refused; any Solana token means
 * a token on Solana and nothing else; the pause is the agent's emergency stop;
 * and nobody else can read or write it.
 */

installHarness();
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => app?.close());
afterEach(() => resetWalletAdapterForTest());

const signIn = async (email: string) => {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password-1234' } });
  return { authorization: `Bearer ${(r.json() as { data: { token: string } }).data.token}` };
};

const CANARY = {
  mode: 'LIVE', assetScope: 'ANY_SOLANA_TOKEN', maxPerTradeSol: '0.05', maxPerDaySol: '0.2', maxOpenExposureSol: '0.2', maxOpenPositions: 2,
  maxSlippageBps: 300, maxPriceImpactBps: 500, minLiquiditySol: '25', maxFeeSol: '0.002', expiresAt: null,
  protectiveExits: { stopLossPct: 20, trailingPct: 25, liquidityFloorSol: '5', honorStudioProtective: true, maxSlippageBps: 800, maxPriceImpactBps: 1500, maxFeeSol: '0.003' },
};

describe('an owner writing a mandate', () => {
  it('needs the signing wallet to go live, writes exact base units, and never writes autonomy', async () => {
    const f = await createFixture();
    const auth = await signIn(f.ownerEmail);
    const url = `/api/agents/${f.agentId}/mandate`;
    expect((await app.inject({ method: 'PUT', url, headers: auth, payload: CANARY })).statusCode).toBe(422);
    registerWalletAdapter(liveAdapter().a);
    await createWallet({ agentId: f.agentId, ownerId: f.ownerId, family: 'SOLANA' });
    const saved = await app.inject({ method: 'PUT', url, headers: auth, payload: CANARY });
    expect(saved.statusCode).toBe(200);
    expect((saved.json() as { data: { mandate: Record<string, unknown> } }).data.mandate).toMatchObject({ mode: 'LIVE', maxPerTradeSol: '0.05', maxFeeSol: '0.002', protectiveExits: { stopLossPct: 20, liquidityFloorSol: '5' } });
    const row = (await trading.liveMandate(f.agentId))!;
    expect(row).toMatchObject({ mode: 'LIVE', approval: 'OWNER_APPROVES_EACH', maxPerTrade: '50000000', maxFeeBase: '2000000', assetScope: 'ANY_SOLANA_TOKEN', venues: ['AMM_POOL_SOLANA'], networks: ['solana'] });
    expect(row.protectiveExits).toMatchObject({ stopLossBps: 2000, trailingBps: 2500, liquidityFloorBase: '5000000000', maxFeeBase: '3000000' });
    // Asking for autonomy is not a field it has.
    expect((await app.inject({ method: 'PUT', url, headers: auth, payload: { ...CANARY, approval: 'AUTONOMOUS_WITHIN_MANDATE' } })).statusCode).toBe(422);
    // Exits with nothing to trigger them allow nothing.
    expect((await app.inject({ method: 'PUT', url, headers: auth, payload: { ...CANARY, protectiveExits: { ...CANARY.protectiveExits, stopLossPct: null, trailingPct: null, liquidityFloorSol: null, honorStudioProtective: false } } })).statusCode).toBe(422);
    // Nobody else reads it or writes it.
    const stranger = await createFixture();
    expect((await app.inject({ method: 'GET', url, headers: await signIn(stranger.ownerEmail) })).statusCode).toBe(404);
  });

  it('pauses the agent as an emergency stop, and any Solana token means a token on Solana by exact mint', async () => {
    const f = await createFixture();
    const auth = await signIn(f.ownerEmail);
    registerWalletAdapter(liveAdapter().a);
    await createWallet({ agentId: f.agentId, ownerId: f.ownerId, family: 'SOLANA' });
    await app.inject({ method: 'PUT', url: `/api/agents/${f.agentId}/mandate`, headers: auth, payload: CANARY });
    const paused = await app.inject({ method: 'POST', url: `/api/agents/${f.agentId}/mandate/pause`, headers: auth, payload: { paused: true } });
    expect((paused.json() as { data: { mandate: { paused: boolean } } }).data.mandate.paused).toBe(true);
    const mandate = asMandate((await trading.liveMandate(f.agentId))!);
    const solToken = { kind: 'ONCHAIN', network: 'solana', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5 } as const;
    const base = {
      fresh: { venue: 'AMM_POOL_SOLANA', network: 'solana', asset: solToken, quoteAsset: { kind: 'NATIVE', network: 'solana' }, atBlock: null, observedAt: new Date().toISOString(), priceBaseUnits: '30', liquidityBase: '500000000000', feeMicroBps: 2500, phase: 'POOL', source: 't' },
      exposure: { spentTodayBase: '0', openExposureBase: '0', openPositions: 0 },
      pausedScopes: [],
      simulated: true,
      now: new Date(),
    } as never;
    const intent = (assetOut: unknown) => ({ id: '33333333-3333-4333-8333-333333333333', agentId: f.agentId, mandateId: mandate.id, mode: 'LIVE', venue: 'AMM_POOL_SOLANA', network: 'solana', side: 'BUY', assetIn: { kind: 'NATIVE', network: 'solana' }, assetOut, maxIn: '10000000', minOut: '1', maxSlippageBps: 100, maxPriceImpactBps: 100, maxFeeBase: '1000', quote: (base as { fresh: unknown }).fresh, expiresAt: new Date(Date.now() + 60_000).toISOString(), status: 'SIMULATED', idempotencyKey: 'k-0000000001', createdAt: new Date().toISOString() });
    const verdict = judgeTrade({ ...(base as object), mandate, intent: intent(solToken) } as never);
    expect(verdict.reasons.map((r) => r.code)).toContain('MANDATE_PAUSED');
    expect(verdict.reasons.map((r) => r.code)).not.toContain('ASSET_NOT_ALLOWED');
    const evmToken = { kind: 'ONCHAIN', network: 'ethereum', address: '0x' + 'a'.repeat(40), decimals: 18 };
    expect(judgeTrade({ ...(base as object), mandate, intent: intent(evmToken) } as never).reasons.map((r) => r.code)).toContain('NO_ASSETS_ALLOWED');
  });
});
