import { describe, expect, it } from 'vitest';
import { classifyItem, deriveProfile, type CorpusItem } from '@xbam/persona';

const item = (id: string, text: string): CorpusItem => {
  const c = classifyItem(text);
  return { id, text, styleScore: c.style, beliefScore: c.belief, classification: c.classification };
};

const terse = [
  'Builders keep building.',
  'People vote with their money.',
  'Not predicting. The pattern is clear.',
  'Markets shake out weak hands.',
  'Focus on users, not politics.',
  'Ship it.',
];

describe('deriving a persona profile', () => {
  it('returns an empty profile rather than failing on an empty corpus', () => {
    const profile = deriveProfile([]);
    expect(profile.traits).toEqual([]);
    expect(profile.summary.medianWords).toBe(0);
  });

  it('notices that someone writes short', () => {
    const profile = deriveProfile(terse.map((t, i) => item(`i${i}`, t)));
    expect(profile.summary.medianWords).toBeLessThanOrEqual(12);
    expect(profile.traits.some((t) => t.kind === 'style' && /Writes short/.test(t.content))).toBe(true);
    expect(profile.traits.some((t) => /terse, declarative/.test(t.content))).toBe(true);
  });

  it('notices that someone writes at length', () => {
    const long = Array.from({ length: 5 }, (_, i) =>
      item(
        `l${i}`,
        'There is a longer argument to make here about how adoption compounds over time, and it deserves more than a single line because the mechanism matters as much as the outcome does in practice.',
      ),
    );
    expect(deriveProfile(long).traits.some((t) => /at length/.test(t.content))).toBe(true);
  });

  it('records that hashtags and emoji are rare', () => {
    const profile = deriveProfile(terse.map((t, i) => item(`i${i}`, t)));
    expect(profile.traits.some((t) => /never uses hashtags/i.test(t.content))).toBe(true);
    expect(profile.traits.some((t) => /Rarely uses emoji/i.test(t.content))).toBe(true);
  });

  it('surfaces recurring topics with the items that support them', () => {
    const corpus = [
      item('a', 'Markets shake out weak hands every cycle.'),
      item('b', 'Markets do not care about your timeline.'),
      item('c', 'The markets reward patience over noise.'),
      item('d', 'Ship it.'),
    ];
    const topics = deriveProfile(corpus).traits.filter((t) => t.kind === 'topic');
    expect(topics.some((t) => t.content === 'markets')).toBe(true);
    expect(topics.find((t) => t.content === 'markets')!.evidence.length).toBeGreaterThan(1);
  });

  it('keeps a stated position verbatim, with the item it came from', () => {
    const opinion = 'I think most short-term narratives are noise, because adoption is what actually compounds.';
    const profile = deriveProfile([item('op', opinion), ...terse.map((t, i) => item(`i${i}`, t))]);
    const belief = profile.traits.find((t) => t.kind === 'belief');
    expect(belief?.content).toBe(opinion);
    expect(belief?.evidence).toEqual(['op']);
  });

  it('picks varied examples rather than repeating one opening', () => {
    const repetitive = [
      item('r1', 'Markets shake out weak hands.'),
      item('r2', 'Markets shake out the impatient.'),
      item('r3', 'Markets shake out everyone eventually.'),
      item('r4', 'Focus on users, not politics.'),
    ];
    const examples = deriveProfile(repetitive).traits.filter((t) => t.kind === 'example');
    // Three of those share an opening, so only one of them earns a slot.
    expect(examples.length).toBe(2);
  });

  it('gives every trait evidence or none, never a fabricated id', () => {
    const profile = deriveProfile(terse.map((t, i) => item(`i${i}`, t)));
    const ids = new Set(terse.map((_, i) => `i${i}`));
    for (const trait of profile.traits) {
      for (const id of trait.evidence) expect(ids.has(id), `${trait.content} cited ${id}`).toBe(true);
    }
  });

  it('produces a compact summary rather than the whole corpus', () => {
    const big = Array.from({ length: 400 }, (_, i) => item(`b${i}`, `Statement number ${i} about markets and risk.`));
    const profile = deriveProfile(big);
    expect(profile.summary.examples.length).toBeLessThanOrEqual(8);
    expect(profile.traits.filter((t) => t.kind === 'example').length).toBeLessThanOrEqual(12);
    expect(profile.traits.length).toBeLessThan(40);
  });
});
