import { describe, expect, it } from 'vitest';
import { extractUserFacts } from '@xbam/memory';

/**
 * The extractor is deliberately conservative: a heuristic that fires too often
 * poisons every future prompt for that person.
 */
describe('extractUserFacts', () => {
  it('captures an explicit request to remember something', () => {
    const facts = extractUserFacts('Hey, remember that my favorite number is 41.', 0.5);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.content).toBe('my favorite number is 41');
    expect(facts[0]?.rule).toBe('explicit-remember-request');
    expect(facts[0]?.importance).toBeGreaterThan(0.8);
  });

  it('captures a stated favourite as a preference', () => {
    const facts = extractUserFacts('By the way my favourite colour is blue.', 0.5);
    expect(facts[0]?.memoryType).toBe('PREFERENCE');
    expect(facts[0]?.content).toContain('favourite colour is blue');
  });

  it('captures a stated name', () => {
    const facts = extractUserFacts('Hello there. My name is Dana.', 0.5);
    expect(facts.some((f) => f.content.toLowerCase().includes('my name is dana'))).toBe(true);
  });

  it('ignores questions, which are not facts about the person', () => {
    expect(extractUserFacts('What is my favorite number?', 0.5)).toHaveLength(0);
    expect(extractUserFacts('Do you remember what I like?', 0.5)).toHaveLength(0);
  });

  it('ignores small talk with nothing durable in it', () => {
    expect(extractUserFacts('lol nice one', 0.5)).toHaveLength(0);
    expect(extractUserFacts('gm', 0.5)).toHaveLength(0);
  });

  it('respects the configured importance floor', () => {
    const low = extractUserFacts('I like long walks on the beach.', 0.5);
    expect(low.length).toBeGreaterThan(0);
    const strict = extractUserFacts('I like long walks on the beach.', 0.8);
    expect(strict).toHaveLength(0);
  });

  it('never returns duplicates of the same statement', () => {
    const facts = extractUserFacts('My name is Dana. My name is Dana.', 0.5);
    expect(facts).toHaveLength(1);
  });

  it('caps how much it will take from one message', () => {
    const wordy = Array.from({ length: 12 }, (_, i) => `I prefer option number ${i} above all.`).join(' ');
    expect(extractUserFacts(wordy, 0.5).length).toBeLessThanOrEqual(5);
  });
});
