import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, EVIDENCE_FOLLOW_UP_STATES, PolicyConfig, isEvidenceFollowUpEvent } from '@xbam/shared/contracts';
import type { CardReading } from '@xbam/prompts';
import { evidenceFollowUpText } from '../../packages/runtime/src/evidenceFollowUp';
import type { FollowUpObservation } from '../../packages/runtime/src/evidenceFollowUpOffer';

const now = Date.parse('2026-11-14T10:30:00Z');
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const card = (over: Partial<CardReading> = {}): CardReading => ({
  label: 'Liquidity', value: 12000, unit: 'USD', source: 'solana_tokens.jupiter', fetchedAt: iso(180), observedAt: iso(181), maxAgeMs: 300_000, ...over,
});
const observation = (over: Partial<FollowUpObservation> = {}): FollowUpObservation => ({
  kind: 'LIQUIDITY_BELOW', mint: 'So11111111111111111111111111111111111111112', source: 'jupiter',
  before: { value: 15000, observedAt: iso(30) }, now: { value: 900, observedAt: iso(5) }, ...over,
});
const watch = { kind: 'LIQUIDITY_BELOW' as const, threshold: 1000 };
const BANNED = /\b(?:safe|rug|rugged|buy|sell|bullish|bearish|prediction|moon|guaranteed)\b/i;

describe('evidenceFollowUpText', () => {
  it('states before, at the card and now, each with a source and a time, and the confirmed condition', () => {
    const text = evidenceFollowUpText({ watch, observation: observation(), cardReadings: [card()], now })!;
    expect(text).toContain('Before: 15000 USD (jupiter, 2026-11-14T10:00Z)');
    expect(text).toContain('At card: 12000 USD (solana_tokens.jupiter, 2026-11-14T07:30Z)');
    expect(text).toContain('Now: 900 USD (jupiter, 2026-11-14T10:25Z)');
    expect(text).toContain('Condition: liquidity below 1000 USD.');
    expect(text).toContain('Not a verdict, reads can be wrong.');
  });

  it('says unavailable, never zero, for a missing before read, a card reading that was not valid, and a missing card reading', () => {
    const none = evidenceFollowUpText({ watch, observation: observation({ before: null }), cardReadings: [], now })!;
    expect(none).toContain('Before: unavailable');
    expect(none).toContain('At card: unavailable');
    expect(none).not.toMatch(/: 0\b/);
    const invalid = evidenceFollowUpText({ watch, observation: observation(), cardReadings: [card({ value: null })], now })!;
    expect(invalid).toContain('At card: unavailable');
    const expired = evidenceFollowUpText({ watch, observation: observation(), cardReadings: [card({ observedAt: iso(300) })], now })!;
    expect(expired).toContain('At card: unavailable');
    const noTime = evidenceFollowUpText({ watch, observation: observation({ before: { value: 5, observedAt: '' } }), cardReadings: [card()], now })!;
    expect(noTime).toContain('Before: unavailable');
  });

  it('writes nothing when the current reading has no time, is in the future, or is not a measurement', () => {
    for (const bad of [{ value: 900, observedAt: '' }, { value: 900, observedAt: iso(-60) }, { value: Number.NaN, observedAt: iso(5) }, { value: -1, observedAt: iso(5) }]) {
      expect(evidenceFollowUpText({ watch, observation: observation({ now: bad }), cardReadings: [card()], now })).toBeNull();
    }
  });

  it('carries the share kinds with percent units, and a developer share has no card reading to compare', () => {
    const shares = evidenceFollowUpText({ watch: { kind: 'TOP_HOLDERS_ABOVE', threshold: 40 },
      observation: observation({ kind: 'TOP_HOLDERS_ABOVE', before: { value: 31.234, observedAt: iso(20) }, now: { value: 44.5, observedAt: iso(2) } }),
      cardReadings: [card({ label: 'Top holders', value: 30.5, unit: '%' })], now })!;
    expect(shares).toContain('Before: 31.23 % (jupiter');
    expect(shares).toContain('At card: 30.5 % (solana_tokens.jupiter');
    expect(shares).toContain('Condition: top holder share above 40 %.');
    const dev = evidenceFollowUpText({ watch: { kind: 'DEVELOPER_SHARE_ABOVE', threshold: 5 },
      observation: observation({ kind: 'DEVELOPER_SHARE_ABOVE' }), cardReadings: [card(), card({ label: 'Top holders', value: 3, unit: '%' })], now })!;
    expect(dev).toContain('At card: unavailable');
  });

  it('uses no word of advice or alarm, no dash used as punctuation, no address and fits the default output limit', () => {
    for (const kind of ['LIQUIDITY_BELOW', 'TOP_HOLDERS_ABOVE', 'DEVELOPER_SHARE_ABOVE'] as const) {
      const text = evidenceFollowUpText({ watch: { kind, threshold: kind === 'LIQUIDITY_BELOW' ? 1000 : 40 }, observation: observation({ kind }), cardReadings: [card()], now })!;
      expect(text).not.toMatch(BANNED);
      expect(text).not.toMatch(/ [-–—] |--|[–—]/);
      expect(text).not.toContain('So11111');
      expect(text.length).toBeLessThanOrEqual(DEFAULT_POLICY.output.maxCharacters);
    }
  });

  it('is the same text every time it is rebuilt from the same record', () => {
    const a = evidenceFollowUpText({ watch, observation: observation(), cardReadings: [card()], now });
    const b = evidenceFollowUpText({ watch, observation: observation(), cardReadings: [card()], now: now + 20_000 });
    expect(a).toBe(b);
  });
});

describe('evidence follow-up contract', () => {
  it('is off by default and its own choice, not part of the card or link switches', () => {
    const parsed = PolicyConfig.parse({});
    expect(parsed.tools.evidenceFollowUps).toBe(false);
    expect(PolicyConfig.parse({ tools: { evidenceCards: true, evidenceCardLink: true } }).tools.evidenceFollowUps).toBe(false);
  });
  it('names the four states the table check allows', () => {
    expect([...EVIDENCE_FOLLOW_UP_STATES]).toEqual(['pending', 'queued', 'rehearsed', 'skipped']);
  });
  it('recognises only the sweep marker in an event payload', () => {
    expect(isEvidenceFollowUpEvent({ origin: 'evidence-follow-up' })).toBe(true);
    expect(isEvidenceFollowUpEvent({ origin: 'self' })).toBe(false);
    expect(isEvidenceFollowUpEvent(null)).toBe(false);
    expect(isEvidenceFollowUpEvent({ text: 'origin: evidence-follow-up' })).toBe(false);
  });
});
