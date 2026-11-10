import { describe, expect, it } from 'vitest';
import { receiptDraftRefusal, receiptEvidence } from '../../packages/runtime/src/radarReceipts';
import { signalRank, signalPublicationRefusal } from '../../packages/runtime/src/signalRadar';
import { projectActivity } from '../../packages/runtime/src/studioActivityTape';

const before = { value: 200, source: 'fixture', observedAt: '2026-11-01T00:00:00.000Z', definition: 'Median liquidity across three pools.' };
const atPost = { ...before, value: 50 };
const watch = { chain: 'solana', address: 'So11111111111111111111111111111111111111112', predicate: 'liquidity_below' as const, threshold: 100 };
describe('radar receipts', () => {
  it('AC2 preserves three observations and their source times without a performance claim', () => {
    const result = receiptEvidence({ watch, before, after: atPost }, { ...before, value: 30 }, Date.parse(before.observedAt));
    expect(result.verdict).toBe('changed');
    expect(result.detail).toContain('Before 200');
    expect(result.detail).toContain('At post 50');
    expect(result.detail).toContain('Now 30');
    expect(result.detail).toContain('fixture, 2026-11-01T00:00:00.000Z');
    expect(signalPublicationRefusal(result.detail)).toBeNull();
  });
  it.each([null, NaN])('AC2 absent or invalid readings remain ungraded: %s', value => {
    const result = receiptEvidence({ watch, before, after: atPost }, { ...before, value }, Date.parse(before.observedAt));
    expect(result.verdict).toBe('unavailable');
    expect(result.detail).toMatch(/Now unavailable/i);
  });
  it('AC2 stale observations are unavailable, never unchanged', () => {
    expect(receiptEvidence({ watch, before, after: atPost }, atPost, Date.parse(before.observedAt) + 3600000).verdict).toBe('unavailable');
  });
  it('AC2 finished text cannot omit the measured values or their source times', () => {
    const evidence = { watch, before, after: atPost };
    const now = { ...before, value: 30 };
    expect(receiptDraftRefusal(evidence, now, 'Liquidity changed.')).toMatch(/Before.*At post.*Now/i);
    const detail = receiptEvidence(evidence, now, Date.parse(before.observedAt)).detail;
    expect(receiptDraftRefusal(evidence, now, detail)).toBeNull();
    expect(receiptDraftRefusal(evidence, now, detail.replaceAll(before.observedAt, 'earlier'))).toMatch(/source time/i);
  });
  it.each(['PnL 10', 'I called it', 'price rose', '100% hit rate'])('AC2 refuses performance language: %s', text => {
    expect(signalPublicationRefusal(text)).not.toBeNull();
  });
  it('AC4 exports only the allowlisted receipt envelope', () => {
    expect(projectActivity({ id: 'receipt:11111111-1111-4111-8111-111111111111', agent_id: '22222222-2222-4222-8222-222222222222', kind: 'RECEIPT', at: before.observedAt, dry_run: false, text: 'private', wallet: watch.address, evidence: { before } })).toEqual({
      id: 'receipt:11111111-1111-4111-8111-111111111111', agent_id: '22222222-2222-4222-8222-222222222222', kind: 'RECEIPT', at: before.observedAt, dry_run: false, target_handle: null, paper: null,
    });
  });
  it('AC5 ranks a larger measured change higher and names its factors', () => {
    const small = signalRank(before, { ...atPost, value: 190 });
    const large = signalRank(before, atPost);
    expect(large.score).toBeGreaterThan(small.score);
    expect(large.reason).toMatch(/magnitude/i);
    expect(large.reason).toMatch(/source/i);
  });
});
