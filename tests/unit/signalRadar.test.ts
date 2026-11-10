import { describe, expect, it } from 'vitest';
import { RadarSourceKind, SignalWatch } from '@xbam/shared/contracts';
import { evaluateSignal, signalPublicationRefusal } from '../../packages/runtime/src/signalRadar';

const address = 'So11111111111111111111111111111111111111112';
const watch = { chain: 'solana', address, predicate: 'liquidity_below' as const, threshold: 100 };
let observedAtMs = Date.now() - 1000;
const read = (value: number | null, observedAt = new Date(observedAtMs += 10).toISOString()) => ({ value, source: 'fixture', observedAt, definition: 'Median pool liquidity USD' });

describe('market signal radar contracts and transitions', () => {
  it('AC1 declares a non-X market source', () => {
    expect(RadarSourceKind.safeParse('market_signal').success).toBe(true);
  });
  it('AC2 accepts exact owner pins and rejects tickers and malformed addresses', () => {
    expect(SignalWatch.safeParse(watch).success).toBe(true);
    for (const value of ['$SOL', 'SOL', '11111111111111111111111111111111111111111111']) {
      expect(SignalWatch.safeParse({ ...watch, address: value }).success).toBe(false);
    }
  });
  it('AC3 baselines first, fires on crossing, stays latched until a fresh clear', () => {
    const baseline = evaluateSignal(watch, null, read(200));
    expect(baseline.transition).toBe(false);
    const crossed = evaluateSignal(watch, baseline.state, read(50));
    expect(crossed.transition).toBe(true);
    expect(crossed.before?.value).toBe(200);
    expect(evaluateSignal(watch, crossed.state, read(20)).transition).toBe(false);
    const clear = evaluateSignal(watch, crossed.state, read(150));
    expect(evaluateSignal(watch, clear.state, read(90)).transition).toBe(true);
  });
  it('AC3 missing and stale reads neither clear nor become zero', () => {
    const baseline = evaluateSignal(watch, null, read(50));
    for (const observation of [read(null), read(200, '2000-01-01T00:00:00.000Z')]) {
      const missing = evaluateSignal(watch, baseline.state, observation);
      expect(missing.state).toEqual(baseline.state);
      expect(missing.transition).toBe(false);
      expect(missing.reason).toMatch(/unavailable|stale/i);
    }
  });
  it('AC3 a pool rotating into coverage is not a newly created pool', () => {
    const w = { ...watch, predicate: 'new_pool' as const };
    const earlier = new Date(Date.now() - 60_000).toISOString();
    const baseline = evaluateSignal(w, null, { ...read(null), value: ['pool1'], poolCreatedAt: { pool1: earlier } });
    const rotated = evaluateSignal(w, baseline.state, { ...read(null), value: ['pool1', 'oldPool'], poolCreatedAt: { pool1: earlier, oldPool: earlier } });
    expect(rotated.transition).toBe(false);
  });
  it('AC3 replaying a cached observation cannot rearm an event latch', () => {
    const w = { ...watch, predicate: 'wallet_transaction' as const };
    const first = evaluateSignal(w, null, { ...read(null), value: 'signature1' });
    const nextRead = { ...read(null), value: 'signature2' };
    const crossed = evaluateSignal(w, first.state, nextRead);
    expect(crossed.transition).toBe(true);
    const replay = evaluateSignal(w, crossed.state, nextRead);
    expect(replay.state?.active).toBe(true);
    expect(replay.transition).toBe(false);
  });
  it('AC4 a shortened mint ending in pump is not itself a token pitch', () => {
    expect(signalPublicationRefusal('Observed liquidity 123456...pump from 200 to 100 USD.')).toBeNull();
  });
  it('AC4 declines strong pitches, advice, predictions and safety verdicts', () => {
    for (const text of ['I gave you $SOL at 1k, next 100x gem, ape in now', 'Buy this token now', 'The price will double', 'This is rug proof', 'Election campaign liquidity', 'SOL headed for $300', 'This token is unruggable', '$SOL<script> rises next', 'The developer wallet dumped everything']) {
      expect(signalPublicationRefusal(text)).toBeTruthy();
    }
    expect(signalPublicationRefusal('Median pool liquidity changed from 200 USD to 50 USD.')).toBeNull();
  });
});
