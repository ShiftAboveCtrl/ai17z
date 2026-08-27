import { describe, expect, it } from 'vitest';
import { analyse, classifyItem, contentFingerprint, normalizeText, scoreItem } from '@xbam/persona';

/**
 * The legacy system dumped every scraped post into memory and the persona came
 * out noisy. These are the specific distinctions that stops.
 */
describe('normalisation', () => {
  it('collapses scraping whitespace without flattening paragraphs', () => {
    expect(normalizeText('a   b\n\n\n\nc')).toBe('a b\n\nc');
  });

  it('removes shortener links, which differ per post and defeat dedupe', () => {
    expect(normalizeText('Shipping today https://t.co/abc123')).toBe('Shipping today');
  });

  it('treats a repost and its original as the same content', () => {
    const a = contentFingerprint(normalizeText('Builders keep building.'));
    const b = contentFingerprint(normalizeText('@someone builders keep building!!'));
    expect(a).toBe(b);
  });

  it('keeps genuinely different statements apart', () => {
    expect(contentFingerprint('Builders keep building.')).not.toBe(contentFingerprint('Traders keep trading.'));
  });

  it('counts words after mentions and links are removed', () => {
    // Shortener links are stripped during normalisation, so what remains is the
    // one real word. A post that was only a t.co link therefore has nothing left.
    const item = analyse('@a @b look https://t.co/x');
    expect(item.wordCount).toBe(1);
    expect(item.mentionCount).toBe(2);
    expect(item.hasLink).toBe(false);
    expect(analyse('check this https://example.com/report').hasLink).toBe(true);
  });
});

describe('persona scoring', () => {
  it('rates a short characteristic remark highly, despite its length', () => {
    const scores = scoreItem('People vote with their money.');
    expect(scores.style).toBeGreaterThan(0.5);
    expect(scores.noise).toBeLessThan(0.2);
    expect(classifyItem('People vote with their money.').excluded).toBe(false);
  });

  it('does not exclude a two-word reply for being short', () => {
    const result = classifyItem('Not predicting.');
    expect(result.excluded).toBe(false);
  });

  it('marks a giveaway as promotional and says why', () => {
    const result = classifyItem('Huge giveaway! Retweet to enter and follow @someone for $50,000 in prizes.');
    expect(result.excluded).toBe(true);
    expect(result.classification).toBe('promotional');
    expect(result.exclusionReason).toMatch(/promotional/i);
  });

  it('excludes a bare link with no commentary', () => {
    const result = classifyItem('https://example.com/announcement');
    expect(result.excluded).toBe(true);
    expect(result.noise).toBeGreaterThan(0.5);
  });

  it('excludes hashtag stuffing', () => {
    const result = classifyItem('#crypto #bitcoin #web3 #defi #moon');
    expect(result.excluded).toBe(true);
  });

  it('recognises a stated position as an opinion', () => {
    const result = classifyItem('I think most short-term narratives are noise, because adoption is what actually compounds.');
    expect(result.classification).toBe('opinion');
    expect(result.belief).toBeGreaterThan(0.6);
    expect(result.excluded).toBe(false);
  });

  it('treats a long factual post as reference rather than voice', () => {
    const text = 'Quarterly volume reached 42% growth across 18 markets, with $2,400,000,000 settled through the network in the period covered by this report and audited by an external firm.';
    expect(classifyItem(text).classification).toBe('reference');
  });

  it('scores an empty or link-only item as pure noise', () => {
    expect(scoreItem('   ').noise).toBe(1);
    expect(classifyItem('   ').excluded).toBe(true);
  });

  it('always explains itself', () => {
    const result = classifyItem('Massive airdrop, use my code to sign up now!');
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.exclusionReason).toBeTruthy();
  });
});
