import { afterEach, describe, expect, it, vi } from 'vitest';
import * as upstream from '@xbam/upstream';
import { readStudioRiskMetric, studioRiskSignalWatch } from '../../packages/runtime/src/studioRiskWatches';
import { evaluateSignal } from '../../packages/runtime/src/signalRadar';

afterEach(() => vi.restoreAllMocks());
const watch = studioRiskSignalWatch({ id: '10000000-0000-4000-8000-000000000001', mint: 'So11111111111111111111111111111111111111112', kind: 'LIQUIDITY_BELOW', threshold: 100, interval_seconds: 14400 });
describe('Studio index observation age', () => {
  it('does not turn an untimed index figure into a fresh reading by using the fetch time', async () => {
    vi.spyOn(upstream, 'ask').mockResolvedValue({ value: { tokens: [{ id: watch.address, liquidity: 50, firstPool: { createdAt: '2026-01-01T00:00:00Z' } }] }, provenance: { upstreamId: 'solana_tokens.jupiter', fetchedAt: new Date().toISOString() } } as never);
    const read = await readStudioRiskMetric(watch);
    const result = evaluateSignal(watch, null, read);
    expect(result.state).toBeNull();
    expect(result.reason).toMatch(/unavailable|stale/i);
  });
});
