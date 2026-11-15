import { describe, expect, it } from 'vitest';
import { renderEvidenceCompare, shortAddress, type CardReading } from '@xbam/prompts';
import { evidenceCardRequest, evidenceCompareRequest } from '../../packages/runtime/src/research';
import { validateOutput } from '../../packages/runtime/src/validator';
import { DEFAULT_POLICY, PolicyConfig } from '@xbam/shared/contracts';

const a = 'So11111111111111111111111111111111111111112';
const b = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const c = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const evmA = '0x1111111111111111111111111111111111111111';
const evmB = '0x2222222222222222222222222222222222222222';
const BANNED = /\b(?:safe|safer|better|best|worse|winner|wins|beats|rug|rug proof|buy|sell|bullish|bearish|price|moon|prediction|forecast|recommend|pick|prefer)\b/i;

function reading(label: string, value: number | boolean | null, source = 'solana_tokens.jupiter', at = new Date().toISOString()): CardReading {
  return { label, value, unit: label === 'Liquidity' ? 'USD' : label === 'Top holders' ? '%' : 'authority', source, fetchedAt: at, observedAt: at, maxAgeMs: 300_000 };
}

describe('evidenceCompareRequest', () => {
  it('accepts exactly two distinct mints on one chain, in the order written', () => {
    expect(evidenceCompareRequest(`@agent ${a} vs ${b}`)).toEqual({ a, b, chain: 'solana' });
    expect(evidenceCompareRequest(`@agent ${b} or ${a}?`)).toEqual({ a: b, b: a, chain: 'solana' });
    expect(evidenceCompareRequest(`check ${evmA} vs ${evmB} on base`)).toEqual({ a: evmA, b: evmB, chain: 'base' });
  });
  it('is not a comparison for one, a repeat of one, three, or none', () => {
    expect(evidenceCompareRequest(`check ${a}`)).toBeNull();
    expect(evidenceCompareRequest(`${a} vs ${a}`)).toBeNull();
    expect(evidenceCompareRequest(`${a} ${b} ${c}`)).toBeNull();
    expect(evidenceCompareRequest('which is better, $AAA or $BBB')).toBeNull();
  });
  it('still refuses three mints and a ticker pair with a sentence through the single card rules', () => {
    expect(evidenceCardRequest(`${a} ${b} ${c}`)?.refusal).toMatch(/^Please .+\.$/);
    expect(evidenceCardRequest('check $AAA vs $BBB')?.refusal).toMatch(/^Please .+\.$/);
  });
  it('refuses a pair that cannot be compared, with a sentence, and never guesses a chain', () => {
    for (const text of [`${a} vs ${evmA}`, `${evmA} vs ${evmB}`, `${a} vs ${b} on base`, `${evmA} vs ${evmB} on mars`, `${a} vs 0xabc123`]) {
      expect(evidenceCompareRequest(text), text).toEqual({ refusal: expect.stringMatching(/^Please .+\.$/) });
    }
  });
});

describe('renderEvidenceCompare', () => {
  const left = { short: shortAddress(a), readings: [reading('Liquidity', 12000), reading('Top holders', 20), reading('Mint authority', true)] };
  const right = { short: shortAddress(b), readings: [reading('Liquidity', 9000), reading('Top holders', 0), reading('Mint authority', false)] };

  it('puts the same fields side by side with source and time, and says there is no ranking', () => {
    const text = renderEvidenceCompare([left, right]);
    expect(text).toContain('Liquidity: A 12000 USD | B 9000 USD');
    expect(text).toContain('Top holders: A 20 % | B 0 %');
    expect(text).toContain('Mint authority: A disabled | B enabled');
    expect(text).toMatch(/A read: solana_tokens\.jupiter; fetched \d{4}-/);
    expect(text).toMatch(/B read: solana_tokens\.jupiter; fetched \d{4}-/);
    expect(text).toContain('no ranking, not a verdict, reads can be wrong');
    expect(text).not.toMatch(BANNED);
    expect(text).not.toContain(a);
  });
  it('orders by the asker, never by a value: swapping the mints swaps the columns and nothing else', () => {
    const swapped = renderEvidenceCompare([right, left]);
    expect(swapped).toContain('Liquidity: A 9000 USD | B 12000 USD');
    expect(swapped).toContain(`A: ${shortAddress(b)}`);
  });
  it('says unavailable for the side that failed and still renders the other; absent is not zero', () => {
    const text = renderEvidenceCompare([left, { short: shortAddress(b), readings: [] }]);
    expect(text).toContain('Liquidity: A 12000 USD | B unavailable');
    expect(text).toContain('B read: unavailable');
    expect(text).toContain('evidence not found for B');
    expect(text).not.toContain('evidence not found for A');
    expect(text).not.toMatch(/\bB 0\b/);
    const stale = renderEvidenceCompare([left, { short: shortAddress(b), readings: [reading('Liquidity', 5, undefined, '2000-01-01T00:00:00Z')] }]);
    expect(stale).toContain('Liquidity: A 12000 USD | B unavailable');
    expect(renderEvidenceCompare([left, { short: shortAddress(b), readings: [reading('Liquidity', 0)] }])).toContain('B 0 USD');
  });
  it('shows a real zero as zero and a null as unavailable', () => {
    const text = renderEvidenceCompare([{ short: 'x', readings: [reading('Liquidity', 0)] }, { short: 'y', readings: [reading('Liquidity', null)] }]);
    expect(text).toContain('Liquidity: A 0 USD | B unavailable');
  });
  it('carries each side check page line only for the side that has one', () => {
    const text = renderEvidenceCompare([left, right], undefined, [`https://studio.example.invalid/check/solana/${a}`, null]);
    expect(text).toContain(`Check A: https://studio.example.invalid/check/solana/${a}`);
    expect(text).not.toContain('Check B:');
  });
});

describe('the address rule and the comparison', () => {
  const policy = PolicyConfig.parse({ ...DEFAULT_POLICY, output: { ...DEFAULT_POLICY.output, maxCharacters: 2000 } });
  const links = [`Check A: https://studio.example.invalid/check/solana/${a}`, `Check B: https://studio.example.invalid/check/solana/${b}`];
  const text = renderEvidenceCompare([{ short: shortAddress(a), readings: [reading('Liquidity', 1)] }, { short: shortAddress(b), readings: [reading('Liquidity', 2)] }],
    undefined, [links[0]!.slice('Check A: '.length), links[1]!.slice('Check B: '.length)]);
  it('passes the proven link lines and the shortened addresses unchanged', () => {
    const result = validateOutput(text, policy, null, '', links);
    expect(result.violations.filter(v => v.severity !== 'REPAIRED')).toEqual([]);
    expect(result.output).toBe(text);
  });
  it('holds a full address a model wrote anywhere else', () => {
    const result = validateOutput(`${text}\nThe first one is ${a}`, policy, null, '', links);
    expect(result.violations.some(v => v.rule === 'unverified_address')).toBe(true);
  });
});
