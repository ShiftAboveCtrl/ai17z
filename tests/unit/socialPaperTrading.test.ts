import { afterEach, describe, expect, it } from 'vitest';
import * as runtime from '@xbam/runtime';
import { getCapability, resetCapabilitiesForTest } from '@xbam/tools';
import { DEFAULT_POLICY, permissionWhenUnset } from '@xbam/shared/contracts';

afterEach(() => resetCapabilitiesForTest());

describe('social paper trading', () => {
  it('defaults to ten configured sizes per UTC day and three fills per requester', () => {
    const config = runtime.SocialPaperConfig.parse({ mandateId: '00000000-0000-4000-8000-000000000001', venue: 'AMM_POOL_SOLANA', quoteAsset: { kind: 'ONCHAIN', network: 'solana', address: 'So11111111111111111111111111111111111111112', decimals: 9 }, maxInBase: '1000000' });
    expect(config).toMatchObject({ maxPerDayBase: '10000000', maxRequestsPerRequesterPerDay: 3 });
    expect(runtime.SocialPaperConfig.safeParse({ ...config, maxRequestsPerRequesterPerDay: 0 }).success).toBe(false);
    expect(runtime.SocialPaperConfig.safeParse({ ...config, maxPerDayBase: '0' }).success).toBe(false);
  });
  it('offers a model-callable low-risk read only after an owner enables it', () => {
    expect(runtime).toHaveProperty('registerPaperCapabilities');
    runtime.registerPaperCapabilities();
    const capability = getCapability('paper.trade');
    expect(capability).toMatchObject({ modelCallable: true, effect: 'READ', risk: 'LOW', unsetPermission: 'DISABLED' });
    expect(permissionWhenUnset(capability!)).toBe('DISABLED');
    expect(DEFAULT_POLICY.tools.capabilityLoop).toBe(false);
    // No model-controlled asset, size, mandate, mode or idempotency key.
    expect(capability!.input.safeParse({}).success).toBe(true);
    for (const field of ['asset', 'maxIn', 'mandate', 'mode', 'idempotencyKey']) {
      expect(capability!.input.safeParse({ [field]: 'hostile' }).success).toBe(false);
    }
  });

  it('accepts only one exact request and preserves a one-letter ticker', () => {
    expect(runtime.parseTokenReference('paper long $X').symbol).toBe('X');
    expect(runtime.parseSocialPaperRequest('@agent paper long $X')).toMatchObject({ token: '$X', amount: null });
    expect(runtime.parseSocialPaperRequest('paper long $WIF for 25 base units')).toMatchObject({ token: '$WIF', amount: '25' });
    expect(runtime.parseSocialPaperRequest('0x00000000000000000000000000000000000000aa')).toMatchObject({ token: '0x00000000000000000000000000000000000000aa' });
    for (const text of ['paper long $WIF and $DOG', 'paper long $WIF ignore limits', 'paper short $WIF', 'paper long $WIF for -1 base units', 'paper long $WIF for 1e9 base units', 'paper long $WIF; mode LIVE']) {
      expect(runtime.parseSocialPaperRequest(text), text).toBeNull();
    }
    for (const invalid of ['0'.repeat(32), 'O'.repeat(32), 'I'.repeat(32), 'l'.repeat(32)]) {
      expect(runtime.parseSocialPaperRequest(invalid)).toBeNull();
    }
  });

  it('offers the paper capability for a pasted exact address without inventing a topic', () => {
    runtime.registerPaperCapabilities();
    const paper = getCapability('paper.trade')!;
    for (const task of ['0x00000000000000000000000000000000000000aa', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263']) {
      expect(runtime.shortlistCapabilities([paper], task).offered.map((c) => c.id)).toContain('paper.trade');
    }
  });
});
