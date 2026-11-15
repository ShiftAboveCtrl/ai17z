import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { MintExtensions } from '@xbam/prompts';
import { TokenExtensionsAnswer, tokenExtensionsAnswer, TOKEN_EXTENSIONS_PATH } from '../../packages/runtime/src/studioTokenExtensions';
import { CARD_FIELD_LABELS } from '../../packages/runtime/src/studioEvidenceCardImage';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/studioTokenExtensions.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const mint = 'So11111111111111111111111111111111111111112';
const base = { source: 'solana_mainnet.official', fetchedAt: '2026-11-14T11:59:30.000Z', maxAgeMs: 300_000 };

describe('the Token-2022 extension answer for Studio', () => {
  it('is exactly the shared fixture', () => {
    const ext: MintExtensions = { status: 'read', ...base, transferFee: { bps: 500, maxFee: '1000000' },
      permanentDelegate: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', transferHookProgram: null, defaultAccountState: null, otherTypeIds: [3, 18] };
    expect(TokenExtensionsAnswer.parse(fixture)).toEqual(fixture);
    expect(tokenExtensionsAnswer(mint, ext)).toEqual(fixture);
    expect(TOKEN_EXTENSIONS_PATH).toBe('/api/v1/installation/token-extensions');
  });

  it('carries every field of the contract and nothing beyond it', () => {
    expect(Object.keys(fixture).sort()).toEqual(['address', 'chain', 'defaultAccountState', 'disclaimer', 'fetched_at', 'isToken2022',
      'maxFee', 'permanentDelegate', 'protocol', 'source', 'status', 'transferFeeBps', 'transferHookProgram', 'unparsedExtensionTypeIds']);
    expect(TokenExtensionsAnswer.safeParse({ ...fixture, handle: 'alice' }).success).toBe(false);
    expect(TokenExtensionsAnswer.safeParse({ ...fixture, job_id: 'x' }).success).toBe(false);
  });

  it('says not a Token-2022 mint for the original program, and nothing is a zero', () => {
    const answer = tokenExtensionsAnswer(mint, { status: 'not_applicable', ...base })!;
    expect(answer).toMatchObject({ status: 'not_applicable', isToken2022: false, transferFeeBps: null, maxFee: null, permanentDelegate: null });
  });

  it('is unread with every field null and isToken2022 unknown, never a zero fee', () => {
    const answer = tokenExtensionsAnswer(mint, { status: 'unread', ...base })!;
    expect(answer).toMatchObject({ status: 'unread', isToken2022: null, transferFeeBps: null, maxFee: null, unparsedExtensionTypeIds: [] });
  });

  it('keeps a present zero fee apart from an absent fee extension', () => {
    const zero = tokenExtensionsAnswer(mint, { status: 'read', ...base, transferFee: { bps: 0, maxFee: '0' }, permanentDelegate: null, transferHookProgram: null, defaultAccountState: null, otherTypeIds: [] })!;
    const none = tokenExtensionsAnswer(mint, { status: 'read', ...base, transferFee: null, permanentDelegate: null, transferHookProgram: null, defaultAccountState: null, otherTypeIds: [] })!;
    expect([zero.transferFeeBps, zero.maxFee]).toEqual([0, '0']);
    expect([none.transferFeeBps, none.maxFee]).toEqual([null, null]);
  });

  it('refuses a mint that is not an address rather than shaping an answer for it', () => {
    expect(tokenExtensionsAnswer('0x1111111111111111111111111111111111111111', { status: 'unread', ...base })).toBeNull();
  });

  it('does not widen the frozen evidence card picture: its labels are still the five', () => {
    expect([...CARD_FIELD_LABELS]).toEqual(['Liquidity', 'Top holders', 'Mint authority', 'Freeze authority', 'Pool age']);
  });
});
