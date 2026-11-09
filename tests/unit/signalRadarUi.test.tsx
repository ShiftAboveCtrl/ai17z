import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SignalEvidence, SignalRadar, type SignalRadarData } from '../../apps/web/src/components/SignalRadar';

const watch = { chain: 'solana', address: 'So11111111111111111111111111111111111111112', predicate: 'liquidity_below' as const, threshold: 100 };
const before = { value: 200, source: 'fixture-provider', observedAt: '2026-11-09T09:00:00Z', definition: 'Median USD pool liquidity; top 20 coverage.' };
const after = { ...before, value: 50, observedAt: '2026-11-09T09:01:00Z' };
const data: SignalRadarData = {
  baselines: [{ sourceId: 'source', watchKey: 'watch', watch, state: null, lastRead: { ...before, value: null }, reason: 'Reading unavailable; retained baseline unchanged.' }],
  candidates: [{ id: 'candidate', sourceId: 'source', evidence: { watch, before, after }, reason: 'In idea backlog; posting gates have not run.', ideaStatus: 'unused', ideaError: null, jobStatus: null, jobError: null }],
};
describe('signal evidence UI', () => {
  it('AC5 and AC6 show exact wrapping identities, unavailable fields, before/after provenance and outcome', () => {
    const html = renderToStaticMarkup(<SignalEvidence data={data} />);
    for (const text of [watch.address, 'Unavailable', 'Before', 'After', '200', '50', 'fixture-provider', after.observedAt, 'Idea: unused', 'posting gates have not run']) expect(html).toContain(text);
    expect(html).toContain('[overflow-wrap:anywhere]');
    expect(html).toContain('grid-cols-1');
  });
  it('AC6 config uses labelled native controls and shows unsupported chains without claiming coverage', () => {
    const html = renderToStaticMarkup(<SignalRadar accountId="account" source={{ id: 'source', config: { watches: [{ ...watch, chain: 'bitcoin' }], mayTrigger: false } }} data={data} reload={() => undefined} />);
    expect(html).toContain('Unsupported chain; not watched');
    expect(html).toContain('method="post"');
    expect(html).toContain('Exact mint or address');
    expect(html).toContain('min-h-12');
    expect(html).not.toContain('checked="" name="mayTrigger"');
  });
  it('AC1 and AC5 show each compound read source and observation time', () => {
    const reads = [{ source: 'supply-rpc', observedAt: '2026-11-09T09:00:01Z' }, { source: 'accounts-rpc', observedAt: '2026-11-09T09:00:02Z' }];
    const html = renderToStaticMarkup(<SignalEvidence data={{ baselines: [], candidates: [{ ...data.candidates[0]!, evidence: { watch, before, after: { ...after, reads } } }] }} />);
    for (const read of reads) {
      expect(html).toContain(read.source);
      expect(html).toContain(read.observedAt);
    }
  });
});
