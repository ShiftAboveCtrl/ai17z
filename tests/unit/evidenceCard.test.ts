import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, EasySetup, PolicyConfig } from '@xbam/shared/contracts';
import { toPolicy } from '../../packages/runtime/src/easyMode';
import * as research from '../../packages/runtime/src/research';
import { registerTokenRiskCapabilities } from '../../packages/runtime/src/tokenRiskCapabilities';
import { getCapability } from '@xbam/tools';
import { renderEvidenceCard, type CardReading } from '@xbam/prompts';

const mint = 'So11111111111111111111111111111111111111112';
const evm = '0x1111111111111111111111111111111111111111';
const api = research as unknown as { evidenceCardRequest(text: string): { address?: string; chain?: string; refusal?: string } | null };

describe('evidence card opt in and identity', () => {
  it('defaults off and preserves the owner setting on an old Easy Mode save', () => {
    expect((DEFAULT_POLICY.tools as unknown as { evidenceCards: boolean }).evidenceCards).toBe(false);
    const policy = PolicyConfig.parse({ ...DEFAULT_POLICY, tools: { ...DEFAULT_POLICY.tools, evidenceCards: true } });
    expect((toPolicy(EasySetup.parse({ character: { name: 'Observer' } }), policy).tools as unknown as { evidenceCards: boolean }).evidenceCards).toBe(true);
  });
  it('maps an explicit Easy Mode choice to the real policy', () => {
    expect((toPolicy(EasySetup.parse({ character: { name: 'Observer' }, replies: { evidenceCards: true } })).tools as unknown as { evidenceCards: boolean }).evidenceCards).toBe(true);
  });
  it('parses one exact mint deterministically and ignores ordinary conversation', () => {
    expect(typeof api.evidenceCardRequest).toBe('function');
    expect(api.evidenceCardRequest(`@agent check ${mint}`)).toEqual({ address: mint, chain: 'solana' });
    expect(api.evidenceCardRequest(`@agent ${mint}`)).toEqual({ address: mint, chain: 'solana' });
    expect(api.evidenceCardRequest('hello there')).toBeNull();
  });
  it('refuses multiple identities, ticker ambiguity and an EVM address without a chain', () => {
    expect(typeof api.evidenceCardRequest).toBe('function');
    for (const text of [`check ${mint} ${evm}`, 'check $DOG', `check ${evm}`]) {
      expect(api.evidenceCardRequest(text)?.refusal).toMatch(/^Please .+\.$/);
    }
    expect(api.evidenceCardRequest(`check ${evm} on base`)).toEqual({ address: evm, chain: 'base' });
  });
  it('extends the existing risk capability to accept a Solana mint', () => {
    registerTokenRiskCapabilities();
    expect(getCapability('token.inspect_risk')!.input.safeParse({ chain: 'solana', address: mint }).success).toBe(true);
  });
});

it('renders missing, stale, invalid and failed readings as unavailable without advice or a verdict', () => {
  const base: CardReading = { label: 'Liquidity', value: null, unit: 'USD', source: 'solana_tokens.jupiter',
    fetchedAt: new Date().toISOString(), observedAt: new Date().toISOString(), maxAgeMs: 300_000 };
  for (const reading of [base, { ...base, value: 0, observedAt: null }, { ...base, value: 100, fetchedAt: '2000-01-01T00:00:00Z' },
    { ...base, value: NaN }, { ...base, value: -1 }]) {
    const result = renderEvidenceCard([reading], '');
    expect(result).toContain('Liquidity: unavailable');
    expect(result).toContain('evidence not found');
    expect(result).not.toMatch(/\b(?:safe|rug proof|buy|sell|bullish|price|moon)\b/i);
  }
  expect(renderEvidenceCard([{ ...base, value: 0 }], '')).toContain('Liquidity: 0 USD');
});

