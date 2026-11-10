import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SignalEvidence, candidateStory, type SignalRadarData } from '../../apps/web/src/components/SignalRadar';
import { RadarSourceItem, ownerSignalSource, type RadarSource } from '../../apps/web/src/components/RadarPanel';
import { StudioRiskWatchesView, choiceFor, POST_SENTENCE, WATCH_SENTENCE, type StudioRiskWatchStatus } from '../../apps/web/src/components/StudioRiskWatchesPanel';
import { radarSourceProvenance } from '@xbam/shared/contracts';

const watch = { chain: 'solana', address: 'So11111111111111111111111111111111111111112', predicate: 'liquidity_below' as const, threshold: 100, studioMetric: 'LIQUIDITY_BELOW' as const };
const before = { value: 200, source: 'jupiter', observedAt: '2026-11-09T09:00:00Z', definition: 'Index liquidity in USD.' };
const after = { ...before, value: 50, observedAt: '2026-11-09T09:01:00Z' };
const candidate = (over: Partial<SignalRadarData['candidates'][number]> = {}): SignalRadarData['candidates'][number] => ({
  id: 'c', sourceId: 's', provenance: 'STUDIO_RISK_WATCH', evidence: { watch, before, after },
  reason: 'In idea backlog; posting gates have not run.', ideaStatus: 'unused', ideaError: null, jobStatus: null, jobError: null, ...over,
});
const source = (over: Partial<RadarSource> = {}): RadarSource => ({
  id: 'src', provenance: 'OWNER', kind: 'market_signal', target: null, label: 'Market and wallet signals', enabled: true, status: 'HEALTHY',
  lastPollAt: null, lastSuccessAt: null, lastResultAt: null, lastError: null, idleReason: null, consecutiveFailures: 0, nextPollAt: null,
  config: { mayTrigger: false }, ...over,
});
const render = (item: RadarSource) => renderToStaticMarkup(<ul><RadarSourceItem source={item} busy={false} onRetry={() => undefined} onRemove={() => undefined} /></ul>);

describe('Studio provenance in the Radar panel', () => {
  it('is computed from the Studio-only config key, never from the label', () => {
    expect(radarSourceProvenance({ studioRisk: { bindingId: 'b' } })).toBe('STUDIO_RISK_WATCH');
    expect(radarSourceProvenance({})).toBe('OWNER');
    expect(radarSourceProvenance(undefined)).toBe('OWNER');
  });
  it('shows the Studio source with provenance and no way to remove it, and says it follows the link', () => {
    const html = render(source({ provenance: 'STUDIO_RISK_WATCH', label: 'Studio risk watch: LIQUIDITY_BELOW', target: 'studio-risk:b:w:r' }));
    expect(html).toContain('From your Studio risk watch list.');
    expect(html).toContain('follows your Studio risk watch link');
    expect(html).not.toMatch(/aria-label="Remove /);
    expect(html).not.toContain('studio-risk:b:w:r');
  });
  it('does not treat an owner source as Studio just because its label starts the same way', () => {
    const html = render(source({ provenance: 'OWNER', label: 'Studio risk watch: mine' }));
    expect(html).not.toContain('From your Studio risk watch list.');
    expect(html).toMatch(/aria-label="Remove /);
  });
  it('leaves the owner pins form to the owner source, never a Studio one that shares the kind', () => {
    const studio = source({ id: 'studio', provenance: 'STUDIO_RISK_WATCH', target: 't' });
    const mine = source({ id: 'mine' });
    expect(ownerSignalSource([studio, mine])?.id).toBe('mine');
    expect(ownerSignalSource([studio])).toBeUndefined();
  });
  it('marks baselines and candidates from Studio by the provenance field', () => {
    const data: SignalRadarData = {
      baselines: [{ sourceId: 's', watchKey: 'k', watch, state: null, lastRead: before, reason: 'Waiting.', provenance: 'STUDIO_RISK_WATCH' }],
      candidates: [candidate(), candidate({ id: 'o', provenance: 'OWNER' })],
    };
    const html = renderToStaticMarkup(<SignalEvidence data={data} />);
    expect(html.match(/data-provenance="STUDIO_RISK_WATCH"/g)).toHaveLength(2);
    expect(html).toContain('Index liquidity below USD');
  });
});

describe('why a candidate was or was not posted', () => {
  it('states the recorded reason first, in sentences, then later trouble', () => {
    const off = candidateStory(candidate({ reason: 'Context only; posting candidates are switched off.', ideaStatus: null }));
    expect(off.outcome).toBe('Not offered for posting');
    expect(off.why).toEqual(['Context only; posting candidates are switched off.']);
    const refused = candidateStory(candidate({ reason: 'In idea backlog; posting gates have not run.', ideaStatus: 'rejected', ideaError: 'Strong token pitches are declined outright.' }));
    expect(refused.why).toEqual(['In idea backlog; posting gates have not run.', 'Strong token pitches are declined outright.']);
    const waiting = candidateStory(candidate({ postingEnabled: false }));
    expect(waiting.why).toContain('Posting schedule is off or not configured.');
  });
  it('renders the reason for the owner under a Why heading', () => {
    const html = renderToStaticMarkup(<SignalEvidence data={{ baselines: [], candidates: [candidate({ reason: 'READ and POST grants are required at ingest.', ideaStatus: null })] }} />);
    expect(html).toContain('Why');
    expect(html).toContain('READ and POST grants are required at ingest.');
  });
});

describe('Studio risk watch opt-in', () => {
  const view = (over: Partial<Parameters<typeof StudioRiskWatchesView>[0]> = {}) => renderToStaticMarkup(
    <StudioRiskWatchesView status={{ binding: null, pendingObservations: 0 }} loading={false} error={null} saving={false} problem={null} accountId="a" onRetry={() => undefined} onChange={() => undefined} {...over} />);
  it('defaults both switches off and says what each does in one sentence', () => {
    const html = view();
    expect(html.match(/aria-checked="false"/g)).toHaveLength(2);
    expect(html).not.toContain('aria-checked="true"');
    expect(html).toContain(WATCH_SENTENCE);
    expect(html).toContain(POST_SENTENCE);
    expect(html).toMatch(/Offer crossings as post ideas/);
  });
  it('keeps the posting switch locked until watching is on', () => {
    expect(view()).toMatch(/aria-checked="false"[^>]*disabled=""[^>]*>[\s\S]*Offer crossings/);
    const on: StudioRiskWatchStatus = { binding: { accountId: 'a', enabled: true, mayTrigger: false, syncedAt: null, expiresAt: null, lastError: null }, pendingObservations: 0 };
    expect(view({ status: on }).match(/aria-checked="true"/g)).toHaveLength(1);
    expect(view({ status: on })).toContain('Waiting for the first sync with Studio.');
  });
  it('has a loading state, an error with a retry, a saving state and a binding error', () => {
    expect(view({ status: null, loading: true })).toContain('Loading your Studio risk watch settings');
    const failed = view({ status: null, error: 'Network down' });
    expect(failed).toContain('could not be loaded');
    expect(failed).toContain('Network down');
    expect(failed).toContain('Try again');
    expect(view({ saving: true })).toContain('Saving');
    expect(view({ problem: 'Link Studio first.' })).toContain('Link Studio first.');
    const stale: StudioRiskWatchStatus = { binding: { accountId: 'a', enabled: true, mayTrigger: true, syncedAt: null, expiresAt: null, lastError: 'Studio risk watches are unavailable.' }, pendingObservations: 2 };
    expect(view({ status: stale })).toContain('Studio risk watches are unavailable.');
  });
  it('treats a binding held by another account as off here, and says so', () => {
    const elsewhere: StudioRiskWatchStatus = { binding: { accountId: 'other', enabled: true, mayTrigger: true, syncedAt: null, expiresAt: null, lastError: null }, pendingObservations: 0 };
    expect(choiceFor(elsewhere, 'a')).toEqual({ enabled: false, mayTrigger: false, elsewhere: true });
    expect(view({ status: elsewhere })).toContain('through another account');
  });
});
