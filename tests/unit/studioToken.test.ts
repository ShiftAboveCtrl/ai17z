import { beforeEach, describe, expect, it } from 'vitest';
import { listCapabilities, resetCapabilitiesForTest } from '@xbam/tools';
import { AI17Z_PAYMENT, TokenFactsDocument } from '@xbam/shared/contracts';
import { checkTokenStatement, describeTokenFacts, registerStudioTokenCapabilities, tokenPageUrl } from '../../packages/runtime/src/studioToken';
import { checkLinkUrl } from '../../packages/runtime/src/studioCheckLink';

const NOW = new Date('2026-11-14T12:00:00Z');

function doc(over: Partial<{ observed_at: string; median: boolean }> = {}): TokenFactsDocument {
  return TokenFactsDocument.parse({
    protocol: 1,
    generated_at: NOW.toISOString(),
    token: { symbol: 'ai17z', chain_id: AI17Z_PAYMENT.chainId, address: AI17Z_PAYMENT.token },
    holder_requirement: { tokens: '1000000' },
    observed_median_7d:
      over.median === false ? null : { price_usd: '0.0042', window_days: 7, observed_at: over.observed_at ?? NOW.toISOString() },
  });
}

const links = {
  tokenPage: tokenPageUrl('https://studio.example.invalid'),
  checkPage: checkLinkUrl('https://studio.example.invalid', 'robinhood', AI17Z_PAYMENT.token),
};

describe('$AI17Z self-awareness', () => {
  beforeEach(() => resetCapabilitiesForTest());

  it('is one READ capability, off by default, and not owner-only so a holder can ask in public', () => {
    registerStudioTokenCapabilities();
    const found = listCapabilities().filter((c) => c.id.startsWith('ai17z_token.'));
    expect(found.map((c) => c.id)).toEqual(['ai17z_token.facts']);
    expect(found[0]!.effect).toBe('READ');
    expect(found[0]!.unsetPermission).toBe('DISABLED');
  });

  it('states the median as observed and not a forecast, passes the advice check, and links from the given origin', () => {
    const { statement, medianPriceUsd } = describeTokenFacts(doc(), links, NOW);
    expect(medianPriceUsd).toBe('0.0042');
    expect(statement).toContain('observed seven-day median');
    expect(statement).toContain('not a forecast');
    expect(statement).toContain('https://studio.example.invalid/token');
    expect(statement).toContain(`https://studio.example.invalid/check/robinhood/${AI17Z_PAYMENT.token}`);
    expect(checkTokenStatement(statement)).toEqual([]);
    expect(statement).not.toMatch(/\bbuy\b/i);
  });

  it('drops a stale or missing price instead of quoting it', () => {
    const stale = describeTokenFacts(doc({ observed_at: '2026-11-10T12:00:00Z' }), links, NOW);
    expect(stale.medianPriceUsd).toBeNull();
    expect(stale.statement).not.toContain('0.0042');
    const none = describeTokenFacts(doc({ median: false }), links, NOW);
    expect(none.medianPriceUsd).toBeNull();
    expect(none.statement).toContain('will not quote one');
  });

  it('builds no link without an origin', () => {
    const { statement } = describeTokenFacts(doc(), { tokenPage: null, checkPage: null }, NOW);
    expect(statement).not.toContain('http');
  });

  it('refuses a document with a field outside the allowlist', () => {
    const raw = { ...doc(), balance: '5' };
    expect(TokenFactsDocument.safeParse(raw).success).toBe(false);
    const nested = { ...doc(), observed_median_7d: { price_usd: '1', window_days: 7, observed_at: NOW.toISOString(), target: '9' } };
    expect(TokenFactsDocument.safeParse(nested).success).toBe(false);
  });

  it('the advice tripwire catches pitches', () => {
    expect(checkTokenStatement('Buy $AI17Z now, it will keep going up').length).toBeGreaterThan(0);
    expect(checkTokenStatement('Bullish on the dip')).not.toEqual([]);
  });
});
