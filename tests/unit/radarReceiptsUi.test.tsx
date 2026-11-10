import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SignalEvidence } from '../../apps/web/src/components/SignalRadar';

const before = { value: 200, source: 'fixture', observedAt: '2026-11-09T09:00:00Z', definition: 'Median liquidity; bounded pool coverage.' };
it('AC2 and AC3 the owner sees before, at-post, missing now and the skipped reason', () => {
  const html = renderToStaticMarkup(<SignalEvidence data={{ baselines: [], candidates: [], receipts: [{
    id: 'receipt', actionId: 'published', windowHours: 1, dueAt: '2026-11-09T10:00:00Z',
    evidence: { watch: { chain: 'solana', address: 'So11111111111111111111111111111111111111112', predicate: 'liquidity_below', threshold: 100 }, before, after: { ...before, value: 50 } },
    nowRead: null, verdict: null, status: 'skipped', reason: 'Everything is paused.', jobStatus: null, jobError: null, ideaStatus: null, ideaError: null, publishedActionId: null,
  }] }} />);
  for (const text of ['Radar receipts', '1h', 'Before', 'At post', 'Now', 'Unavailable', 'Skipped', 'Everything is paused.', 'fixture', before.observedAt]) expect(html).toContain(text);
  expect(html).not.toMatch(/hit.rate|PnL|called it/i);
});
