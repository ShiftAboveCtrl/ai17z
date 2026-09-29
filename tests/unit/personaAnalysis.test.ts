import { describe, expect, it } from 'vitest';
import { semanticTopics, voiceProfile } from '@xbam/persona';
import { bilingualPersona, builderPersona, lowDataPersona, spammyPersona } from '../support/syntheticPersonas';

/**
 * Reading a persona from what it wrote: subjects rather than word counts, and a
 * voice measured separately for posts and replies, casual and technical.
 */

describe('what somebody talks about', () => {
  it('finds the project and the chain, not the words every sentence has', () => {
    const topics = semanticTopics(builderPersona());
    const labels = topics.map((t) => t.label.toLowerCase());
    expect(labels).toContain('pons');
    expect(labels).toContain('robinhood chain');
    for (const stopword of ['will', 'have', 'just', 'the', 'you']) expect(labels, stopword).not.toContain(stopword);
  });

  it('cites the posts each topic rests on', () => {
    const pons = semanticTopics(builderPersona()).find((t) => t.label.toLowerCase() === 'pons')!;
    expect(pons.evidence.length).toBeGreaterThan(0);
    expect(pons.items).toBeGreaterThanOrEqual(pons.evidence.length);
    expect(pons.confidence).toBeGreaterThan(0.4);
  });

  it('treats "robinhood" as part of "robinhood chain" rather than a second topic', () => {
    const labels = semanticTopics(builderPersona()).map((t) => t.label.toLowerCase());
    expect(labels).not.toContain('robinhood');
  });

  it('keeps a subject mentioned twice in a small share as a small share, not a headline', () => {
    const topics = semanticTopics(builderPersona());
    const faith = topics.find((t) => t.label.toLowerCase() === 'faith');
    const pons = topics.find((t) => t.label.toLowerCase() === 'pons')!;
    if (faith) expect(faith.share).toBeLessThan(pons.share);
  });

  it('returns nothing it cannot support from a tiny corpus', () => {
    expect(semanticTopics(lowDataPersona())).toEqual([]);
  });
});

describe('how somebody writes', () => {
  it('sees short by default and long when technical', () => {
    const profile = voiceProfile(builderPersona());
    expect(profile.words.technical.median).toBeGreaterThan(profile.words.casual.median * 3);
    const register = profile.statements.find((s) => s.area === 'REGISTER');
    expect(register?.text).toMatch(/Short by default, longer when technical/);
    expect(register!.evidence.length).toBeGreaterThan(0);
  });

  it('measures replies on their own', () => {
    const profile = voiceProfile(builderPersona());
    expect(profile.sample.replies).toBeGreaterThan(0);
    expect(profile.chars.replies.n).toBe(profile.sample.replies);
    expect(profile.statements.some((s) => s.area === 'LENGTH' && /Replies are usually short/.test(s.text))).toBe(true);
  });

  it('notices the lowercase starts, the missing full stops and the slang', () => {
    const areas = voiceProfile(builderPersona()).statements.map((s) => s.area);
    expect(areas).toEqual(expect.arrayContaining(['CASE', 'PUNCTUATION', 'SLANG']));
  });

  it('sees a second language', () => {
    const lang = voiceProfile(bilingualPersona()).statements.find((s) => s.area === 'LANGUAGE');
    expect(lang?.text).toMatch(/zh/);
    expect(voiceProfile(bilingualPersona()).languages[0]!.share).toBeCloseTo(0.5, 1);
  });

  it('says nothing about a voice it has too little of', () => {
    expect(voiceProfile(lowDataPersona()).statements).toEqual([]);
  });

  it('does not learn a topic from reposted promotion', () => {
    // The persona source excludes reposts before this runs; what is left must
    // still not turn one repeated pitch into a hashtag "interest" of theirs
    // without saying how much of the corpus it is.
    const topics = semanticTopics(spammyPersona());
    const airdrop = topics.find((t) => t.label.toLowerCase() === '#airdrop');
    if (airdrop) expect(airdrop.share).toBeGreaterThan(0.8);
  });
});
