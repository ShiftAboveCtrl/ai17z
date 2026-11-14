import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY, EasySetup, PolicyConfig } from '@xbam/shared/contracts';
import { CHECK_LINK_PREFIX, renderEvidenceCard, type CardReading } from '@xbam/prompts';
import { toPolicy } from '../../packages/runtime/src/easyMode';

type Linked = { ok: false; why: string } | { where: { origin: string; unsafeDev: boolean } };
let linked: Linked = { ok: false, why: 'This installation is not linked to Studio.' };
vi.mock('../../packages/runtime/src/studioLink', () => ({ studioLinkedContext: async () => linked }));

const { checkLinkUrl, linkedCheckOrigin, studioCheckLink, tokenResolved } = await import('../../packages/runtime/src/studioCheckLink');

const mint = 'So11111111111111111111111111111111111111112';
const evm = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const origin = 'https://studio.example.invalid';
const now = new Date().toISOString();
const reading = (value: number | boolean | null, patch: Partial<CardReading> = {}): CardReading =>
  ({ label: 'Liquidity', value, unit: 'USD', source: 'solana_tokens.jupiter', fetchedAt: now, observedAt: now, maxAgeMs: 300_000, ...patch });

beforeEach(() => { linked = { where: { origin, unsafeDev: false } }; });

describe('checkLinkUrl', () => {
  it('builds the permalink on the given origin for a Solana mint, a lowercased EVM address and Robinhood', () => {
    expect(checkLinkUrl(origin, 'solana', mint)).toBe(`${origin}/check/solana/${mint}`);
    expect(checkLinkUrl(origin, 'ethereum', evm)).toBe(`${origin}/check/ethereum/${evm.toLowerCase()}`);
    expect(checkLinkUrl(origin, 'robinhood', evm)).toBe(`${origin}/check/robinhood/${evm.toLowerCase()}`);
  });

  it('refuses a chain with no check page, and anything that is not exactly one address', () => {
    expect(checkLinkUrl(origin, 'bnb', evm)).toBeNull();
    expect(checkLinkUrl(origin, 'solana', evm)).toBeNull();
    expect(checkLinkUrl(origin, 'ethereum', mint)).toBeNull();
    for (const address of ['', 'evil.example/x', `${mint}/../x`, `${mint}?next=https://evil.example`, `${mint}#`, `//evil.example/${mint}`]) {
      expect(checkLinkUrl(origin, 'solana', address), address).toBeNull();
    }
  });

  it('never produces a host other than the origin it was given', () => {
    for (const bad of ['', 'not a url', 'ftp://studio.example.invalid', 'https://studio.example.invalid/path', 'https://studio.example.invalid/?x=1']) {
      expect(checkLinkUrl(bad, 'solana', mint), bad).toBeNull();
    }
    expect(new URL(checkLinkUrl(origin, 'solana', mint)!).origin).toBe(origin);
  });
});

describe('studioCheckLink', () => {
  it('links a resolved mint to the linked Studio and nothing else', async () => {
    expect(await studioCheckLink({ chain: 'solana', address: mint, readings: [reading(12000)] })).toBe(`${origin}/check/solana/${mint}`);
  });

  it('gives no link for a mint the card did not resolve', async () => {
    for (const readings of [[], [reading(null)], [reading(100, { fetchedAt: '2000-01-01T00:00:00Z' })], [reading(NaN)], [reading(-1)]]) {
      expect(tokenResolved(readings)).toBe(false);
      expect(await studioCheckLink({ chain: 'solana', address: mint, readings })).toBeNull();
    }
  });

  it('gives no link when Studio is not linked, was revoked, or is a development origin', async () => {
    linked = { ok: false, why: 'This installation is not linked to Studio.' };
    expect(await studioCheckLink({ chain: 'solana', address: mint, readings: [reading(12000)] })).toBeNull();
    linked = { where: { origin: 'http://127.0.0.1:4000', unsafeDev: true } };
    expect(await linkedCheckOrigin()).toBeNull();
    expect(await studioCheckLink({ chain: 'solana', address: mint, readings: [reading(12000)] })).toBeNull();
  });

  it('takes its host from the link and never from a message: no input can name one', async () => {
    const url = await studioCheckLink({ chain: 'solana', address: `${mint}`, readings: [reading(1)] });
    expect(new URL(url!).host).toBe('studio.example.invalid');
    expect(await studioCheckLink({ chain: 'solana', address: 'https://evil.example/' + mint, readings: [reading(1)] })).toBeNull();
  });
});

describe('the card text', () => {
  it('is unchanged without a link and ends with exactly one link line with one', () => {
    const readings = [reading(12000)];
    const plain = renderEvidenceCard(readings, '');
    expect(plain).not.toContain(CHECK_LINK_PREFIX);
    expect(plain).not.toMatch(/https?:/);
    const url = `${origin}/check/solana/${mint}`;
    const text = renderEvidenceCard(readings, 'Owner: watch this.', undefined, url);
    expect(text.startsWith(renderEvidenceCard(readings, 'Owner: watch this.'))).toBe(true);
    expect(text.endsWith(`\n${CHECK_LINK_PREFIX}${url}`)).toBe(true);
    expect(text.match(/https?:\/\/\S+/g)).toEqual([url]);
    expect(text).toContain('not a verdict, reads can be wrong');
  });
});

describe('the owner switch', () => {
  it('defaults off, is reachable only from Advanced, and an Easy Mode save leaves it as it was', () => {
    expect(DEFAULT_POLICY.tools.evidenceCardLink).toBe(false);
    for (const on of [false, true]) {
      const base = PolicyConfig.parse({ ...DEFAULT_POLICY, tools: { ...DEFAULT_POLICY.tools, evidenceCards: true, evidenceCardLink: on } });
      const saved = toPolicy(EasySetup.parse({ character: { name: 'Observer' }, replies: { evidenceCards: true } }), base);
      expect(saved.tools.evidenceCardLink).toBe(on);
      const again = toPolicy(EasySetup.parse({ character: { name: 'Observer' }, replies: { evidenceCards: true } }), saved);
      expect(again.tools).toEqual(saved.tools);
    }
  });
});
