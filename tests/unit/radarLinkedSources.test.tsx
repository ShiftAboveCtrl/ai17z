import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RadarSourceItem, type RadarSource } from '../../apps/web/src/components/RadarPanel';
import { hasStudioRiskMark, radarSourceProvenance } from '@xbam/shared/contracts';

const source = (over: Partial<RadarSource> = {}): RadarSource => ({
  id: 'src', provenance: 'OWNER', kind: 'tracked_keyword', target: 'my topic', label: 'mine', enabled: true, status: 'HEALTHY',
  lastPollAt: null, lastSuccessAt: null, lastResultAt: null, lastError: null, idleReason: null, consecutiveFailures: 0, nextPollAt: null,
  config: { mayTrigger: true }, ...over,
});
const render = (item: RadarSource) => renderToStaticMarkup(<ul><RadarSourceItem source={item} busy={false} onRetry={() => undefined} onRemove={() => undefined} /></ul>);

describe('a source that follows a playbook link', () => {
  const playbook = source({ provenance: 'PLAYBOOK', label: 'Playbook: Momentum', target: null, config: { mayTrigger: false } });
  it('offers no way to remove it and says in one sentence that it follows the playbook', () => {
    const html = render(playbook);
    expect(html).not.toMatch(/aria-label="Remove /);
    expect(html).toContain('follows the playbook linked to this agent');
    expect(html.match(/follows the playbook/g)).toHaveLength(1);
    expect(html).not.toContain('Studio risk watch');
  });
  it('still lets an owner source be removed, and shows its target', () => {
    const html = render(source());
    expect(html).toMatch(/aria-label="Remove /);
    expect(html).toContain('my topic');
    expect(html).not.toContain('follows the playbook');
  });
});

describe('provenance is one rule', () => {
  it('counts a Studio mark only when it is a non-null object', () => {
    expect(hasStudioRiskMark({ studioRisk: { bindingId: 'b' } })).toBe(true);
    for (const studioRisk of [null, undefined, [], 'x', true, 0, false, '']) {
      expect(hasStudioRiskMark({ studioRisk }), JSON.stringify(studioRisk)).toBe(false);
      expect(radarSourceProvenance({ studioRisk })).toBe('OWNER');
    }
  });
  it('reads a playbook link and lets a Studio mark win', () => {
    expect(radarSourceProvenance({ playbookAgentId: 'a' })).toBe('PLAYBOOK');
    expect(radarSourceProvenance({ playbookAgentId: null })).toBe('OWNER');
    expect(radarSourceProvenance({ studioRisk: {}, playbookAgentId: 'a' })).toBe('STUDIO_RISK_WATCH');
  });
});
