import { describe, expect, it } from 'vitest';
import { query, trading } from '@xbam/database';
import { AssetRef, MarketSnapshot, type TradeMandate } from '@xbam/shared/contracts';
import { judgeTrade, judgeTradeInput } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * The rows a trade leaves behind, against a real database.
 *
 * Unique indexes and conditional updates are what actually keep a trade from
 * happening twice, so these are integration tests rather than unit tests: a
 * mock would be testing the mock. Nothing here signs anything, touches a
 * network or names a real contract.
 */

const TOKEN = AssetRef.parse({
  kind: 'ONCHAIN',
  network: 'robinhood',
  address: '0x00000000000000000000000000000000000000aa',
  decimals: 18,
  symbol: 'FIXTURE',
});
const NATIVE = AssetRef.parse({ kind: 'NATIVE', network: 'robinhood' });

const snapshot = (over: Partial<MarketSnapshot> = {}): MarketSnapshot =>
  MarketSnapshot.parse({
    venue: 'PONS_V2_CURVE',
    network: 'robinhood',
    asset: TOKEN,
    quoteAsset: NATIVE,
    atBlock: '1234567',
    observedAt: new Date().toISOString(),
    priceBaseUnits: '1000000000000000000',
    liquidityBase: '500000000000000000000',
    feeMicroBps: 10_000,
    phase: 'CURVE',
    source: 'fixture',
    ...over,
  });

const mandateDraft = (over: Partial<TradeMandate> = {}) => ({
  mode: 'LIVE' as const,
  approval: 'OWNER_APPROVES_EACH' as const,
  venues: ['PONS_V2_CURVE' as const],
  networks: ['robinhood' as const],
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

async function agentWithMandate(over: Partial<TradeMandate> = {}) {
  const fixture = await createFixture();
  const mandate = await trading.putMandate({
    agentId: fixture.agentId,
    ownerId: fixture.ownerId,
    mandate: mandateDraft(over) as Omit<TradeMandate, 'id' | 'agentId'>,
  });
  return { fixture, mandate };
}

const draft = (agentId: string, mandateId: string, key: string, over: Record<string, unknown> = {}) => ({
  agentId,
  mandateId,
  walletId: null,
  mode: 'LIVE' as const,
  venue: 'PONS_V2_CURVE' as const,
  network: 'robinhood',
  side: 'BUY' as const,
  assetIn: NATIVE,
  assetOut: TOKEN,
  maxIn: '1000000000000000000',
  minOut: '900000000000000000',
  maxSlippageBps: 50,
  maxPriceImpactBps: 100,
  maxFeeBase: '10000000000000000',
  quote: snapshot(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  idempotencyKey: key,
  ...over,
});

describe('a mandate is superseded, never edited', () => {
  it('retires the previous one so what was allowed then still has an answer', async () => {
    const { fixture, mandate } = await agentWithMandate();
    const second = await trading.putMandate({
      agentId: fixture.agentId,
      ownerId: fixture.ownerId,
      mandate: mandateDraft({ maxPerTrade: '1' }) as Omit<TradeMandate, 'id' | 'agentId'>,
    });

    const live = await trading.liveMandate(fixture.agentId);
    expect(live?.id).toBe(second.id);
    const old = await trading.getMandate(mandate.id);
    expect(old?.retiredAt, 'the old mandate should be retired, not gone').not.toBeNull();
    expect(old?.maxPerTrade).toBe('10000000000000000000');
  }, 60_000);

  it('defaults to paper, owner-approved and unpaused when the owner says nothing', async () => {
    const fixture = await createFixture();
    await query(
      `INSERT INTO trade_mandates (agent_id, venues, networks, max_per_trade, max_per_day, max_open_exposure,
         max_open_positions, max_slippage_bps, max_price_impact_bps, min_liquidity_base, max_fee_base, quote_max_age_ms)
       VALUES ($1, '["PONS_V2_CURVE"]'::jsonb, '["robinhood"]'::jsonb, '1','1','1',1,1,1,'1','1',1000)`,
      [fixture.agentId],
    );
    const live = await trading.liveMandate(fixture.agentId);
    expect(live?.mode).toBe('PAPER');
    expect(live?.approval).toBe('OWNER_APPROVES_EACH');
    expect(live?.paused).toBe(false);
  }, 60_000);
});

describe('one decision makes one trade', () => {
  it('a retry of the same key finds the first row rather than making a second', async () => {
    const { fixture, mandate } = await agentWithMandate();
    const key = `idem-${fixture.agentId}`;
    const first = await trading.createIntent(draft(fixture.agentId, mandate.id, key));
    const again = await trading.createIntent(draft(fixture.agentId, mandate.id, key, { maxIn: '9999999999999999999' }));

    expect(first.created).toBe(true);
    expect(again.created, 'a retry must not create a second intent').toBe(false);
    expect(again.row.id).toBe(first.row.id);
    // And it is the first decision that stands, not the retry's numbers.
    expect(again.row.maxIn).toBe('1000000000000000000');

    const all = await trading.listIntents(fixture.agentId);
    expect(all).toHaveLength(1);
  }, 60_000);

  it('refuses two intents claiming the same transaction identity', async () => {
    const { fixture, mandate } = await agentWithMandate();
    const a = await trading.createIntent(draft(fixture.agentId, mandate.id, `a-${fixture.agentId}`));
    const b = await trading.createIntent(draft(fixture.agentId, mandate.id, `b-${fixture.agentId}`));
    for (const row of [a.row, b.row]) {
      await trading.transitionIntent(row.id, 'DRAFTED', 'APPROVED');
      await trading.transitionIntent(row.id, 'APPROVED', 'SIMULATED');
      await trading.transitionIntent(row.id, 'SIMULATED', 'SIGNED');
    }
    const hash = `0x${'11'.repeat(32)}`;
    expect(await trading.recordBroadcast(a.row.id, hash)).not.toBeNull();
    // The database says no rather than the application hoping it noticed.
    await expect(trading.recordBroadcast(b.row.id, hash)).rejects.toThrow();
  }, 60_000);
});

describe('a state change only happens from a state it is allowed to happen from', () => {
  it('returns null when the row was not where the caller thought', async () => {
    const { fixture, mandate } = await agentWithMandate();
    const { row } = await trading.createIntent(draft(fixture.agentId, mandate.id, `t-${fixture.agentId}`));

    const moved = await trading.transitionIntent(row.id, 'DRAFTED', 'APPROVED');
    expect(moved?.status).toBe('APPROVED');
    // The same call again lost the race, and says so rather than moving it twice.
    expect(await trading.transitionIntent(row.id, 'DRAFTED', 'APPROVED')).toBeNull();
  }, 60_000);

  it('keeps the reasons the gate gave, so the refusal can be read later', async () => {
    const { fixture, mandate } = await agentWithMandate();
    const { row } = await trading.createIntent(draft(fixture.agentId, mandate.id, `r-${fixture.agentId}`));
    const reasons = [{ code: 'LIQUIDITY_UNKNOWN', detail: 'The reader could not see the venue depth.' }];
    const out = await trading.transitionIntent(row.id, 'DRAFTED', 'RISK_REJECTED', { riskReasons: reasons });
    expect(out?.riskReasons).toEqual(reasons);
  }, 60_000);
});

describe('what recovery has to work from', () => {
  it('writes the transaction identity with the submission, never after it', async () => {
    const { fixture, mandate } = await agentWithMandate();
    const { row } = await trading.createIntent(draft(fixture.agentId, mandate.id, `bc-${fixture.agentId}`));
    await trading.transitionIntent(row.id, 'DRAFTED', 'APPROVED');
    await trading.transitionIntent(row.id, 'APPROVED', 'SIMULATED');
    await trading.transitionIntent(row.id, 'SIMULATED', 'SIGNED');

    const hash = `0x${'22'.repeat(32)}`;
    const sent = await trading.recordBroadcast(row.id, hash);
    // There is no moment where an identity exists on a row still claiming to
    // be unsent: both move in the one statement.
    expect(sent?.status).toBe('SUBMITTED');
    expect(sent?.txIdentity).toBe(hash);
    expect(sent?.broadcastAt).not.toBeNull();

    // And it cannot be overwritten by a second attempt.
    expect(await trading.recordBroadcast(row.id, `0x${'33'.repeat(32)}`)).toBeNull();
    expect((await trading.getIntent(row.id))?.txIdentity).toBe(hash);
  }, 60_000);

  it('offers the unresolved intents oldest first', async () => {
    const { fixture, mandate } = await agentWithMandate();
    const keys = ['s1', 's2', 's3'].map((s) => `${s}-${fixture.agentId}`);
    const made = [];
    for (const k of keys) made.push((await trading.createIntent(draft(fixture.agentId, mandate.id, k))).row);
    // One stays drafted, one is in flight, one is settled.
    await trading.transitionIntent(made[1]!.id, 'DRAFTED', 'APPROVED');
    await trading.transitionIntent(made[1]!.id, 'APPROVED', 'SIMULATED');
    await trading.transitionIntent(made[1]!.id, 'SIMULATED', 'SIGNED');
    await trading.transitionIntent(made[2]!.id, 'DRAFTED', 'CONFIRMED');

    const pending = await trading.intentsNeedingReconciliation();
    const ids = pending.map((p) => p.id);
    expect(ids, 'only the in-flight one needs asking about').toContain(made[1]!.id);
    expect(ids).not.toContain(made[0]!.id);
    expect(ids).not.toContain(made[2]!.id);
  }, 60_000);
});

describe('exposure is counted in exact units', () => {
  it('sums committed amounts without going near a float', async () => {
    const { fixture } = await agentWithMandate();
    // Two amounts whose sum is larger than Number.MAX_SAFE_INTEGER, so a
    // numeric column or a JS number would quietly lose the answer.
    const big = '9007199254740993000000000000';
    await trading.putMandate({
      agentId: fixture.agentId,
      ownerId: fixture.ownerId,
      mandate: mandateDraft({ maxPerTrade: big, maxPerDay: big, maxOpenExposure: big }) as Omit<TradeMandate, 'id' | 'agentId'>,
    });
    const live = await trading.liveMandate(fixture.agentId);
    for (const k of ['e1', 'e2']) {
      const { row } = await trading.createIntent(draft(fixture.agentId, live!.id, `${k}-${fixture.agentId}`, { maxIn: big }));
      await trading.transitionIntent(row.id, 'DRAFTED', 'APPROVED');
    }

    const now = await trading.exposureOf(fixture.agentId, new Date(Date.now() - 60_000));
    expect(now.openPositions).toBe(2);
    expect(now.openExposureBase).toBe((BigInt(big) * 2n).toString());
    expect(now.spentTodayBase).toBe((BigInt(big) * 2n).toString());
  }, 60_000);

  it('stops counting a settled trade as open exposure', async () => {
    const { fixture, mandate } = await agentWithMandate();
    const { row } = await trading.createIntent(draft(fixture.agentId, mandate.id, `x1-${fixture.agentId}`));
    await trading.transitionIntent(row.id, 'DRAFTED', 'CONFIRMED');
    const now = await trading.exposureOf(fixture.agentId, new Date(Date.now() - 60_000));
    expect(now.openPositions).toBe(0);
    expect(now.openExposureBase).toBe('0');
    // It still counts against the day: the money left.
    expect(now.spentTodayBase).toBe('1000000000000000000');
  }, 60_000);

  it('ignores paper trades entirely, because nothing was committed', async () => {
    const { fixture, mandate } = await agentWithMandate();
    const { row } = await trading.createIntent(draft(fixture.agentId, mandate.id, `p1-${fixture.agentId}`, { mode: 'PAPER' }));
    await trading.transitionIntent(row.id, 'DRAFTED', 'PAPER_FILLED');
    const now = await trading.exposureOf(fixture.agentId, new Date(Date.now() - 60_000));
    expect(now.openPositions).toBe(0);
    expect(now.spentTodayBase).toBe('0');
  }, 60_000);
});

describe('the stops', () => {
  it('finds a global pause for every agent and venue', async () => {
    const { fixture } = await agentWithMandate();
    const pause = await trading.pauseTrading({ scope: 'GLOBAL', target: null, reason: 'incident', createdBy: fixture.ownerId });
    const scopes = await trading.activePauseScopes({ agentId: fixture.agentId, venue: 'PONS_V2_CURVE', walletId: null });
    expect(scopes).toContain('GLOBAL');
    await trading.liftPause(pause.id, fixture.ownerId);
    expect(await trading.activePauseScopes({ agentId: fixture.agentId, venue: 'PONS_V2_CURVE', walletId: null })).toEqual([]);
  }, 60_000);

  it('matches a pause to its own scope and nothing wider', async () => {
    const { fixture } = await agentWithMandate();
    const other = await createFixture();
    await trading.pauseTrading({ scope: 'AGENT', target: fixture.agentId, reason: 'this one', createdBy: null });
    await trading.pauseTrading({ scope: 'VENUE', target: 'PUMP_CURVE', reason: 'that venue', createdBy: null });

    expect(await trading.activePauseScopes({ agentId: fixture.agentId, venue: 'PONS_V2_CURVE', walletId: null })).toEqual(['AGENT']);
    expect(await trading.activePauseScopes({ agentId: other.agentId, venue: 'PONS_V2_CURVE', walletId: null })).toEqual([]);
    expect(await trading.activePauseScopes({ agentId: other.agentId, venue: 'PUMP_CURVE', walletId: null })).toEqual(['VENUE']);
  }, 60_000);

  it('does not stack a second pause on the same scope', async () => {
    const { fixture } = await agentWithMandate();
    const a = await trading.pauseTrading({ scope: 'AGENT', target: fixture.agentId, reason: 'first', createdBy: null });
    const b = await trading.pauseTrading({ scope: 'AGENT', target: fixture.agentId, reason: 'second', createdBy: null });
    expect(b.id).toBe(a.id);
    expect(b.reason).toBe('first');
  }, 60_000);

  it('keeps a lifted pause as history rather than deleting it', async () => {
    const { fixture } = await agentWithMandate();
    const p = await trading.pauseTrading({ scope: 'AGENT', target: fixture.agentId, reason: 'why', createdBy: null });
    await trading.liftPause(p.id, null);
    expect(await trading.liftPause(p.id, null), 'lifting twice is not a second event').toBeNull();
    const all = await trading.listPauses(true);
    expect(all.find((x) => x.id === p.id)?.liftedAt).not.toBeNull();
  }, 60_000);
});

describe('the gate and the rows agree', () => {
  it('refuses a stored live intent while a stored pause is in force', async () => {
    // The two halves have to work together: a pause row the gate never reads
    // is decoration, and a gate with no pause source cannot be stopped.
    const { fixture, mandate } = await agentWithMandate();
    const { row } = await trading.createIntent(draft(fixture.agentId, mandate.id, `g1-${fixture.agentId}`));
    await trading.pauseTrading({ scope: 'AGENT', target: fixture.agentId, reason: 'stop', createdBy: null });

    const verdict = judgeTrade(
      await judgeTradeInput({ intentRow: row, mandateRow: mandate, fresh: snapshot() }),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.map((r) => r.code)).toContain('PAUSED');
  }, 60_000);

  it('refuses a live intent that has not been simulated, from the stored row alone', async () => {
    // `simulated` is derived from the row rather than passed in, so a drafted
    // live intent carries no simulation and the mandatory check bites without
    // anybody having to remember to ask for it.
    const { fixture, mandate } = await agentWithMandate();
    const { row } = await trading.createIntent(draft(fixture.agentId, mandate.id, `g3-${fixture.agentId}`));
    const verdict = judgeTrade(await judgeTradeInput({ intentRow: row, mandateRow: mandate, fresh: snapshot() }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.map((r) => r.code)).toContain('NOT_SIMULATED');
  }, 60_000);

  it('allows a stored intent inside its stored mandate once simulated, and still asks the owner', async () => {
    const { fixture, mandate } = await agentWithMandate();
    const { row } = await trading.createIntent(draft(fixture.agentId, mandate.id, `g2-${fixture.agentId}`));
    const simulated = await trading.transitionIntent(row.id, 'DRAFTED', 'SIMULATED', {
      simulation: { expectedOut: '950000000000000000', feeBase: '1000000000000000' },
    });
    const verdict = judgeTrade(
      await judgeTradeInput({ intentRow: simulated!, mandateRow: mandate, fresh: snapshot() }),
    );
    expect(verdict.allowed, verdict.reasons.map((r) => r.code).join(',')).toBe(true);
    expect(verdict.needsOwnerApproval).toBe(true);
  }, 60_000);
});

describe('today is a window, and yesterday is outside it', () => {
  it("does not subtract a trade created yesterday from today's spend", async () => {
    /*
      An intent is removed from the exposure figures before its own size is
      tested against them, which is right. But `spentTodayBase` only counts
      rows created today, so subtracting a row created yesterday took its size
      off a total that never included it, understated today's spend by exactly
      that much, and let an agent past its daily limit. The open-exposure
      figure has no such window, which is why the two lines are not the same
      and why this was easy to miss.
    */
    const { fixture, mandate } = await agentWithMandate();

    // One trade today, which does count against the day.
    const today = await trading.createIntent(draft(fixture.agentId, mandate.id, `w1-${fixture.agentId}`));
    await trading.transitionIntent(today.row.id, 'DRAFTED', 'APPROVED');

    // And one from yesterday, which does not.
    const old = await trading.createIntent(draft(fixture.agentId, mandate.id, `w2-${fixture.agentId}`));
    const approved = await trading.transitionIntent(old.row.id, 'DRAFTED', 'APPROVED');
    await query(`UPDATE trade_intents SET created_at = now() - interval '2 days' WHERE id = $1`, [old.row.id]);
    const backdated = { ...approved!, createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString() };

    const input = await judgeTradeInput({ intentRow: backdated, mandateRow: mandate, fresh: snapshot() });

    // Today's spend is the one trade from today, with nothing taken off for a
    // trade the total never counted.
    expect(input.exposure.spentTodayBase).toBe('1000000000000000000');
    // Its own open exposure is still removed, because that figure counted it.
    expect(input.exposure.openExposureBase).toBe('1000000000000000000');
  }, 60_000);

  it("still subtracts a trade created today from today's spend", async () => {
    const { fixture, mandate } = await agentWithMandate();
    const { row } = await trading.createIntent(draft(fixture.agentId, mandate.id, `w3-${fixture.agentId}`));
    const approved = await trading.transitionIntent(row.id, 'DRAFTED', 'APPROVED');

    const input = await judgeTradeInput({ intentRow: approved!, mandateRow: mandate, fresh: snapshot() });
    expect(input.exposure.spentTodayBase).toBe('0');
    expect(input.exposure.openExposureBase).toBe('0');
  }, 60_000);
});
