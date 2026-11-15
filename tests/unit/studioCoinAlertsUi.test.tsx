import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudioCoinAlertsView, coinAlertChoiceFor, COIN_ALERTS_SENTENCE, type StudioCoinAlertStatus } from '../../apps/web/src/components/StudioCoinAlertsPanel';

const view = (over: Partial<Parameters<typeof StudioCoinAlertsView>[0]> = {}) => renderToStaticMarkup(
  <StudioCoinAlertsView status={{ binding: null }} loading={false} error={null} saving={false} problem={null} accountId="a" onRetry={() => undefined} onChange={() => undefined} {...over} />);
const bound = (over: Partial<NonNullable<StudioCoinAlertStatus['binding']>> = {}): StudioCoinAlertStatus => ({
  binding: { accountId: 'a', enabled: true, confirmedAt: null, lastError: null, watching: 0, skipped: [], ...over },
});

describe('Studio coin alerts opt-in', () => {
  it('is off by default and says in plain words what it does and what it reads', () => {
    const html = view();
    expect(html.match(/aria-checked="false"/g)).toHaveLength(1);
    expect(html).not.toContain('aria-checked="true"');
    expect(html).toContain(COIN_ALERTS_SENTENCE);
    expect(COIN_ALERTS_SENTENCE).toContain('inside its usual X reading budget');
    expect(COIN_ALERTS_SENTENCE).not.toContain('never touches X');
  });
  it('shows waiting, then the count watched and skipped', () => {
    expect(view({ status: bound() })).toContain('Waiting for the first sync with Studio.');
    const synced = view({ status: bound({ confirmedAt: '2026-11-15T10:00:00Z', watching: 3, skipped: [{ index: 4, reason: 'Not a Solana mint.' }] }) });
    expect(synced).toContain('Watching 3 coin(s)');
    expect(synced).toContain('1 alert(s) were skipped.');
  });
  it('has loading, error with retry, saving, binding error and problem states', () => {
    expect(view({ status: null, loading: true })).toContain('Loading your Studio coin alert settings');
    const failed = view({ status: null, error: 'Network down' });
    expect(failed).toContain('could not be loaded');
    expect(failed).toContain('Try again');
    expect(view({ saving: true })).toContain('Saving');
    expect(view({ status: bound({ lastError: 'Studio is unreachable.' }) })).toContain('Studio is unreachable.');
    expect(view({ problem: 'Link Studio first.' })).toContain('Link Studio first.');
  });
  it('treats a binding held by another account as off here, and says so', () => {
    const elsewhere = bound({ accountId: 'other' });
    expect(coinAlertChoiceFor(elsewhere, 'a')).toEqual({ enabled: false, elsewhere: true });
    expect(coinAlertChoiceFor(bound(), 'a')).toEqual({ enabled: true, elsewhere: false });
    expect(coinAlertChoiceFor(null, 'a')).toEqual({ enabled: false, elsewhere: false });
    expect(view({ status: elsewhere })).toContain('through another account');
  });
});
