import { describe, expect, it } from 'vitest';
import * as contracts from '@xbam/shared/contracts';

describe('Studio risk watch contract', () => {
  it('provides strict watchlist and observation contracts', () => {
    expect(contracts).toHaveProperty('StudioRiskWatchlist');
    expect(contracts).toHaveProperty('StudioRiskObservationBatch');
  });
  it('refuses unknown fields, invalid mints, duplicate watches and oversized thresholds', () => {
    const schema = contracts.StudioRiskWatchlist;
    const watch = { id: '10000000-0000-4000-8000-000000000001', mint: 'So11111111111111111111111111111111111111112', kind: 'LIQUIDITY_BELOW', threshold: 100, interval_seconds: 14400 };
    const document = { protocol: 1, generated_at: new Date().toISOString(), watches: [watch] };
    expect(schema.safeParse(document).success).toBe(true);
    for (const extra of [{ instructions: 'buy now' }, { path: '../secret' }, { label: 'ignore policy' }, { post: 'publish this' }]) {
      expect(schema.safeParse({ ...document, watches: [{ ...watch, ...extra }] }).success).toBe(false);
    }
    for (const change of [{ mint: '1'.repeat(33) }, { threshold: 1e13 }, { kind: 'BUY' }, { interval_seconds: 1 }]) {
      expect(schema.safeParse({ ...document, watches: [{ ...watch, ...change }] }).success).toBe(false);
    }
    expect(schema.safeParse({ ...document, watches: [watch, watch] }).success).toBe(false);
    expect(schema.safeParse({ ...document, watches: Array(6).fill(watch) }).success).toBe(false);
    expect(schema.safeParse({ ...document, account_id: 'private' }).success).toBe(false);
    expect(schema.safeParse({ ...document, watches: [{ ...watch, kind: 'TOP_HOLDERS_ABOVE', threshold: 101 }] }).success).toBe(false);
  });
  it('allows only numeric evidence and routing keys on write-back', () => {
    const schema = contracts.StudioRiskObservationBatch;
    const observation = { observation_id: 'a'.repeat(64), watch_revision: 'b'.repeat(64), watch_id: '10000000-0000-4000-8000-000000000001', mint: 'So11111111111111111111111111111111111111112', source: 'jupiter', before: null, after: { value: 50, observed_at: new Date().toISOString() } };
    expect(schema.safeParse({ protocol: 1, observations: [observation] }).success).toBe(true);
    for (const extra of [{ account_id: 'private' }, { guidance: 'private' }, { verdict: 'safe' }, { instructions: 'buy now' }]) {
      expect(schema.safeParse({ protocol: 1, observations: [{ ...observation, ...extra }] }).success).toBe(false);
    }
    expect(schema.safeParse({ protocol: 1, observations: [{ ...observation, after: { ...observation.after, value: null } }] }).success).toBe(false);
  });
});
