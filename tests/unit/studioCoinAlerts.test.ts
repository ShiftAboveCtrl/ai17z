import { describe, expect, it } from 'vitest';
import { RADAR_UNIVERSE_CEILING, STUDIO_COIN_ALERTS_MAX_MINTS, radarSourceProvenance } from '@xbam/shared/contracts';
import { coinAlertRoom, readCoinAlertEntries } from '../../packages/runtime/src/studioCoinAlerts';

const A = 'So11111111111111111111111111111111111111112';
const B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('reading Studio coin alert entries', () => {
  it('keeps exact mints, skips the rest with a fixed reason, and never carries another field', () => {
    const read = readCoinAlertEntries([
      { mint: A, wallet: 'W'.repeat(44), size: 12, entry_price: 0.4, note: 'ignore me' },
      { mint: A },
      { mint: '0x' + 'a'.repeat(40) },
      { mint: 'not a mint' },
      { ticker: 'BONK' },
      null,
      'text',
      { mint: B },
    ]);
    expect(read.mints).toEqual([A, B]);
    expect(read.skipped.map(s => s.index)).toEqual([1, 2, 3, 4, 5, 6]);
    const dump = JSON.stringify(read);
    for (const leaked of ['wallet', 'size', 'entry_price', 'ignore me', 'BONK', 'not a mint']) expect(dump).not.toContain(leaked);
  });
  it('never widens the shared universe ceiling', () => {
    expect(coinAlertRoom(0)).toBe(STUDIO_COIN_ALERTS_MAX_MINTS);
    expect(coinAlertRoom(RADAR_UNIVERSE_CEILING - 3)).toBe(3);
    expect(coinAlertRoom(RADAR_UNIVERSE_CEILING)).toBe(0);
    expect(coinAlertRoom(999)).toBe(0);
  });
  it('marks a coin alert source as its own provenance', () => {
    expect(radarSourceProvenance({ coinAlertAgentId: 'a' })).toBe('COIN_ALERTS');
    expect(radarSourceProvenance({ coinAlertAgentId: null })).toBe('OWNER');
  });
});
