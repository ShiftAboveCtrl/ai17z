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
  it('fits all six concentration reads and passes the final receipt check within 280 characters', () => {
    const observation = (value: number, hour: string) => ({
      ...before, value, observedAt: `2026-11-01T${hour}:00.000Z`,
      source: 'solana_mainnet.official',
      reads: [
        { source: 'solana_mainnet.official', observedAt: `2026-11-01T${hour}:00.000Z` },
        { source: 'solana_mainnet.official', observedAt: `2026-11-01T${hour}:02.000Z` },
      ],
    });
    const evidence = { watch: { ...watch, predicate: 'concentration_above' as const, threshold: 50 }, before: observation(49.99, '00:00'), after: observation(50.01, '01:00') };
    const now = observation(99.99, '02:00');
    const draft = 'Before 49.99 (sol/official@11-01T00:00Z,sol/official@11-01T00:00Z). At post 50.01 (sol/official@11-01T01:00Z,sol/official@11-01T01:00Z). Now 99.99 (sol/official@11-01T02:00Z,sol/official@11-01T02:00Z).';
    expect(draft.length).toBeLessThanOrEqual(280);
    expect(receiptDraftRefusal(evidence, now, draft)).toBeNull();
    expect(receiptDraftRefusal(evidence, now, draft.replace('sol/official@11-01T02:00Z,', ''))).not.toBeNull();
    expect(receiptEvidence(evidence, now, Date.parse(now.observedAt)).compact).toBe(draft);
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
    expect(receiptDraftRefusal(evidence, now, detail.replaceAll(before.observedAt, 'earlier').replaceAll('11-01T00:00Z', 'earlier'))).toMatch(/source time/i);
  });
  it.each(['PnL 10', 'I called it', 'price rose', '100% hit rate'])('AC2 refuses performance language: %s', text => {
    expect(signalPublicationRefusal(text)).not.toBeNull();
  });
  it('AC4 projects a receipt envelope now that Studio accepts the kind, carrying only normalised fields', () => {
    // 60cf11af turned STUDIO_ACCEPTS_RECEIPTS on; this used to assert the withheld state.
    const envelope = projectActivity({ id: 'receipt:11111111-1111-4111-8111-111111111111', agent_id: '22222222-2222-4222-8222-222222222222', kind: 'RECEIPT', at: before.observedAt, dry_run: false, text: 'private' });
    expect(envelope).toMatchObject({ id: 'receipt:11111111-1111-4111-8111-111111111111', kind: 'RECEIPT', target_handle: null, paper: null, dry_run: false });
    expect(JSON.stringify(envelope)).not.toContain('private');
  });
  it('AC5 ranks a larger measured change higher and names its factors', () => {
    const small = signalRank(before, { ...atPost, value: 190 });
    const large = signalRank(before, atPost);
    expect(large.score).toBeGreaterThan(small.score);
    expect(large.reason).toMatch(/magnitude/i);
    expect(large.reason).toMatch(/source/i);
  });
});
