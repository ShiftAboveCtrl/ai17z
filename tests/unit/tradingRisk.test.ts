import { describe, expect, it } from 'vitest';
import {
  AssetRef,
  MarketSnapshot,
  TRADE_NO_RESIGN_STATUSES,
  TRADE_VENUES,
  TradeIntent,
  TradeMandate,
  assetKey,
  venueSupportsNetwork,
  type TradeIntentStatus,
} from '@xbam/shared/contracts';
import { judgeTrade, type RiskInput } from '@xbam/runtime';

/**
 * The gate between a model proposing and an adapter signing.
 *
 * Everything here is synthetic. No network, no chain, no signing: the point of
 * the risk engine is that it is arithmetic over an owner's mandate, so it can
 * be put to every refusal it is supposed to make without touching money.
 *
 * The codes are asserted rather than the prose, because the prose is for a
 * person and the code is the contract.
 */

const AGENT = '11111111-1111-4111-8111-111111111111';
const MANDATE = '22222222-2222-4222-8222-222222222222';
const INTENT = '33333333-3333-4333-8333-333333333333';

// A plausible Pons V2 curve token on Robinhood Chain, and the native asset it
// trades against. Invented for the fixture: nothing here is read as an address.
const TOKEN = AssetRef.parse({
  kind: 'ONCHAIN',
  network: 'robinhood',
  address: '0x00000000000000000000000000000000000000aa',
  decimals: 18,
  symbol: 'FIXTURE',
});
const NATIVE = AssetRef.parse({ kind: 'NATIVE', network: 'robinhood' });

const NOW = new Date('2026-10-03T12:00:00.000Z');
const iso = (msFromNow: number) => new Date(NOW.getTime() + msFromNow).toISOString();

const snapshot = (over: Partial<MarketSnapshot> = {}): MarketSnapshot =>
  MarketSnapshot.parse({
    venue: 'PONS_V2_CURVE',
    network: 'robinhood',
    asset: TOKEN,
    quoteAsset: NATIVE,
    atBlock: '1234567',
    observedAt: iso(-500),
    priceBaseUnits: '1000000000000000000',
    liquidityBase: '500000000000000000000',
    feeMicroBps: 10_000,
    phase: 'CURVE',
    source: 'fixture',
    ...over,
  });

const mandate = (over: Partial<TradeMandate> = {}): TradeMandate =>
  TradeMandate.parse({
    id: MANDATE,
    agentId: AGENT,
    mode: 'LIVE',
    approval: 'OWNER_APPROVES_EACH',
    venues: ['PONS_V2_CURVE'],
    networks: ['robinhood'],
    allowedAssets: [TOKEN],
    maxPerTrade: '10000000000000000000',
    maxPerDay: '50000000000000000000',
    maxOpenExposure: '40000000000000000000',
    maxOpenPositions: 5,
    maxSlippageBps: 100,
    maxPriceImpactBps: 200,
    minLiquidityBase: '1000000000000000000',
    maxFeeBase: '100000000000000000',
    quoteMaxAgeMs: 5_000,
    expiresAt: null,
    paused: false,
    ...over,
  });

const intent = (over: Partial<TradeIntent> = {}): TradeIntent =>
  TradeIntent.parse({
    id: INTENT,
    agentId: AGENT,
    mandateId: MANDATE,
    mode: 'LIVE',
    venue: 'PONS_V2_CURVE',
    network: 'robinhood',
    side: 'BUY',
    assetIn: NATIVE,
    assetOut: TOKEN,
    maxIn: '1000000000000000000',
    minOut: '900000000000000000',
    maxSlippageBps: 50,
    maxPriceImpactBps: 100,
    maxFeeBase: '10000000000000000',
    quote: snapshot(),
    expiresAt: iso(30_000),
    status: 'DRAFTED',
    idempotencyKey: 'fixture-intent-0001',
    createdAt: iso(-1_000),
    ...over,
  });

const ask = (over: Partial<RiskInput> = {}) =>
  judgeTrade({
    intent: intent(),
    mandate: mandate(),
    fresh: snapshot(),
    exposure: { spentTodayBase: '0', openExposureBase: '0', openPositions: 0 },
    pausedScopes: [],
    simulated: true,
    now: NOW,
    ...over,
  });

const codes = (v: ReturnType<typeof judgeTrade>) => v.reasons.map((r) => r.code);

describe('the trade a mandate permits', () => {
  it('allows one inside every bound, and still asks the owner', () => {
    const v = ask();
    expect(v.allowed, codes(v).join(',')).toBe(true);
    expect(v.needsOwnerApproval).toBe(true);
    expect(codes(v)).toContain('WITHIN_MANDATE');
  });

  it('does not ask the owner to approve a simulation', () => {
    // Paper cannot move value, and teaching an owner to click through
    // approvals on trades that are not real is how a real one gets clicked.
    const v = ask({ intent: intent({ mode: 'PAPER' }), simulated: false });
    expect(v.allowed).toBe(true);
    expect(v.needsOwnerApproval).toBe(false);
  });

  it('lets autonomy inside the mandate proceed without a per-trade approval', () => {
    const v = ask({ mandate: mandate({ approval: 'AUTONOMOUS_WITHIN_MANDATE' }) });
    expect(v.allowed).toBe(true);
    expect(v.needsOwnerApproval).toBe(false);
  });
});

describe('stops that arithmetic cannot argue with', () => {
  it.each(['GLOBAL', 'RUNTIME', 'AGENT', 'VENUE', 'WALLET'] as const)('refuses while paused at %s', (scope) => {
    const v = ask({ pausedScopes: [scope] });
    expect(v.allowed).toBe(false);
    expect(codes(v)).toContain('PAUSED');
  });

  it('refuses a paused or expired mandate', () => {
    expect(codes(ask({ mandate: mandate({ paused: true }) }))).toContain('MANDATE_PAUSED');
    expect(codes(ask({ mandate: mandate({ expiresAt: iso(-1) }) }))).toContain('MANDATE_EXPIRED');
  });

  it('refuses an intent judged against somebody else mandate or agent', () => {
    const other = '44444444-4444-4444-8444-444444444444';
    expect(codes(ask({ intent: intent({ mandateId: other }) }))).toContain('WRONG_MANDATE');
    expect(codes(ask({ intent: intent({ agentId: other }), mandate: mandate() }))).toContain('WRONG_AGENT');
  });

  it('refuses an expired intent', () => {
    expect(codes(ask({ intent: intent({ expiresAt: iso(-1) }) }))).toContain('INTENT_EXPIRED');
  });
});

describe('never a second signature for the same trade', () => {
  it.each(TRADE_NO_RESIGN_STATUSES)('refuses to proceed from %s', (status) => {
    // This is the whole of the no-blind-retry rule at this layer: once
    // something irreversible may exist, the answer is to reconcile the
    // identity already held, never to produce another one.
    const v = ask({ intent: intent({ status: status as TradeIntentStatus }) });
    expect(v.allowed).toBe(false);
    expect(codes(v)).toContain('ALREADY_IN_FLIGHT');
  });

  it('names exactly the statuses where something irreversible may exist', () => {
    expect([...TRADE_NO_RESIGN_STATUSES]).toEqual(['SIGNED', 'SUBMITTED', 'UNKNOWN', 'CONFIRMED']);
  });
});

describe('a quote has to still be true', () => {
  it('refuses state older than the mandate allows', () => {
    const v = ask({ fresh: snapshot({ observedAt: iso(-6_000) }), mandate: mandate({ quoteMaxAgeMs: 5_000 }) });
    expect(codes(v)).toContain('QUOTE_STALE');
  });

  it('refuses state that claims to be from the future', () => {
    expect(codes(ask({ fresh: snapshot({ observedAt: iso(5_000) }) }))).toContain('QUOTE_FROM_THE_FUTURE');
  });

  it('refuses when the price moved further than the intent allowed', () => {
    // 1.0 -> 1.1 is 1000bps against an intent allowing 50.
    const v = ask({ fresh: snapshot({ priceBaseUnits: '1100000000000000000' }) });
    expect(codes(v)).toContain('PRICE_MOVED');
  });

  it('refuses when the venue graduated between the quote and now', () => {
    // A curve that became a pool is a different venue with different maths.
    const v = ask({ fresh: snapshot({ phase: 'POOL' }) });
    expect(codes(v)).toContain('VENUE_PHASE_CHANGED');
  });

  it('refuses fresh state for the wrong venue or asset', () => {
    expect(codes(ask({ fresh: snapshot({ venue: 'PONS_V1' }) }))).toContain('QUOTE_WRONG_VENUE');
    const other = AssetRef.parse({ ...TOKEN, address: '0x00000000000000000000000000000000000000bb' });
    expect(codes(ask({ fresh: snapshot({ asset: other }) }))).toContain('QUOTE_WRONG_ASSET');
  });
});

describe('bounds', () => {
  it('refuses an intent that allows more slippage, impact or fee than the mandate', () => {
    expect(codes(ask({ intent: intent({ maxSlippageBps: 500 }) }))).toContain('SLIPPAGE_ABOVE_MANDATE');
    expect(codes(ask({ intent: intent({ maxPriceImpactBps: 900 }) }))).toContain('IMPACT_ABOVE_MANDATE');
    expect(codes(ask({ intent: intent({ maxFeeBase: '900000000000000000' }) }))).toContain('FEE_ABOVE_MANDATE');
  });

  it('refuses a trade larger than one trade may be', () => {
    expect(codes(ask({ intent: intent({ maxIn: '20000000000000000000' }) }))).toContain('SIZE_ABOVE_MANDATE');
  });

  it('refuses the trade that would cross the daily limit', () => {
    const v = ask({ exposure: { spentTodayBase: '49500000000000000000', openExposureBase: '0', openPositions: 0 } });
    expect(codes(v)).toContain('DAILY_LIMIT');
  });

  it('refuses the trade that would cross open exposure or the position count', () => {
    expect(
      codes(ask({ exposure: { spentTodayBase: '0', openExposureBase: '39500000000000000000', openPositions: 0 } })),
    ).toContain('EXPOSURE_LIMIT');
    expect(codes(ask({ exposure: { spentTodayBase: '0', openExposureBase: '0', openPositions: 5 } }))).toContain('POSITION_LIMIT');
  });

  it('treats depth nobody could read as unknown, not as empty', () => {
    // Absent is not zero. A pool whose depth could not be seen must fail the
    // minimum rather than pass it by arriving as a zero that beats nothing.
    const v = ask({ fresh: snapshot({ liquidityBase: null }) });
    expect(v.allowed).toBe(false);
    expect(codes(v)).toContain('LIQUIDITY_UNKNOWN');
    expect(codes(v)).not.toContain('LIQUIDITY_TOO_LOW');
  });

  it('refuses a venue, network or asset the mandate never allowed', () => {
    expect(codes(ask({ mandate: mandate({ venues: ['PONS_V1'] }) }))).toContain('VENUE_NOT_ALLOWED');
    expect(codes(ask({ mandate: mandate({ networks: ['ethereum'] }) }))).toContain('NETWORK_NOT_ALLOWED');
    expect(codes(ask({ mandate: mandate({ allowedAssets: [] }) }))).toContain('NO_ASSETS_ALLOWED');
    const other = AssetRef.parse({ ...TOKEN, address: '0x00000000000000000000000000000000000000bb' });
    expect(codes(ask({ mandate: mandate({ allowedAssets: [other] }) }))).toContain('ASSET_NOT_ALLOWED');
  });
});

describe('simulation is not optional', () => {
  it('refuses a live trade that was never simulated', () => {
    const v = ask({ simulated: false });
    expect(v.allowed).toBe(false);
    expect(codes(v)).toContain('NOT_SIMULATED');
  });
});

describe('every refusal says why, and they accumulate', () => {
  it('reports all the problems rather than the first one', () => {
    // An owner fixing a mandate would rather see three faults now than
    // discover them one run at a time.
    const v = ask({
      intent: intent({ maxIn: '20000000000000000000', maxSlippageBps: 500 }),
      mandate: mandate({ paused: true }),
    });
    expect(v.allowed).toBe(false);
    expect(codes(v)).toEqual(expect.arrayContaining(['MANDATE_PAUSED', 'SIZE_ABOVE_MANDATE', 'SLIPPAGE_ABOVE_MANDATE']));
  });

  it('gives a sentence with every code', () => {
    for (const r of ask({ mandate: mandate({ paused: true }) }).reasons) {
      expect(r.detail.length, r.code).toBeGreaterThan(10);
    }
  });
});

describe('the vocabulary itself', () => {
  it('keeps the Pons generations and Pump venues apart', () => {
    // Merging these is how an agent sells into a pool that is not there.
    expect(TRADE_VENUES.PONS_V2_CURVE.phase).toBe('CURVE');
    expect(TRADE_VENUES.PONS_V2_GRADUATED.phase).toBe('POOL');
    expect(TRADE_VENUES.PONS_V1.phase).toBe('POOL');
    expect(TRADE_VENUES.PUMP_CURVE.phase).toBe('CURVE');
    expect(TRADE_VENUES.PUMP_SWAP.phase).toBe('POOL');
  });

  it('refuses a venue on a network it does not execute on', () => {
    expect(venueSupportsNetwork('PONS_V1', 'robinhood')).toBe(true);
    expect(venueSupportsNetwork('PONS_V1', 'solana')).toBe(false);
    expect(venueSupportsNetwork('PUMP_CURVE', 'robinhood')).toBe(false);
    expect(() => intent({ venue: 'PUMP_CURVE', network: 'robinhood' })).toThrow();
  });

  it('identifies an asset by chain and address, never by symbol', () => {
    // Only the hex body changes case: a checksummed EVM address keeps its
    // `0x` lowercase, and `addressShapeOk` is right to refuse `0X`.
    const body = TOKEN.kind === 'ONCHAIN' ? TOKEN.address.slice(2).toUpperCase() : '';
    const upper = AssetRef.parse({ ...TOKEN, address: `0x${body}` });
    expect(assetKey(upper)).toBe(assetKey(TOKEN));
    const elsewhere = AssetRef.parse({ ...TOKEN, network: 'ethereum' });
    expect(assetKey(elsewhere)).not.toBe(assetKey(TOKEN));
    const renamed = AssetRef.parse({ ...TOKEN, symbol: 'SOMETHINGELSE' });
    expect(assetKey(renamed)).toBe(assetKey(TOKEN));
  });

  it('refuses an intent that trades an asset for itself', () => {
    expect(() => intent({ assetIn: TOKEN, assetOut: TOKEN })).toThrow();
  });

  it('defaults a mandate to paper, owner-approved and unpaused', () => {
    const bare = TradeMandate.parse({
      id: MANDATE,
      agentId: AGENT,
      venues: ['PONS_V2_CURVE'],
      networks: ['robinhood'],
      allowedAssets: [TOKEN],
      maxPerTrade: '1',
      maxPerDay: '1',
      maxOpenExposure: '1',
      maxOpenPositions: 1,
      maxSlippageBps: 1,
      maxPriceImpactBps: 1,
      minLiquidityBase: '1',
      maxFeeBase: '1',
      quoteMaxAgeMs: 1_000,
      expiresAt: null,
    });
    expect(bare.mode).toBe('PAPER');
    expect(bare.approval).toBe('OWNER_APPROVES_EACH');
    expect(bare.paused).toBe(false);
  });

  it('refuses an amount that is not a whole number of base units', () => {
    for (const bad of ['1.5', '-1', '0', '1e18', '']) {
      expect(() => intent({ maxIn: bad }), bad).toThrow();
    }
  });
});
