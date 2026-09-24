import { describe, expect, it } from 'vitest';
import { asksToBeLeftAlone } from '@xbam/runtime';

/**
 * Somebody asking to be left alone.
 *
 * Deterministic on purpose. "Did they ask us to stop" is exactly the judgement
 * an owner most needs to be able to inspect and correct, and a model deciding
 * it would cost a call to produce an opinion nobody can audit that answers
 * differently on different days. The same reasoning `salience.ts` gives for
 * not letting a model decide what is worth attending to.
 *
 * The asymmetry matters more than the accuracy. Missing one means carrying on
 * approaching somebody who asked twice. Over-reading one means leaving
 * somebody alone who did not quite mean it, and the agent can still answer
 * them when they write in.
 */
describe('a request to stop', () => {
  const clear = [
    'stop replying to me',
    'Please stop tagging me in these',
    "don't reply to me again",
    'dont message me',
    'Leave me alone.',
    'not interested, stop',
    'opting out',
    'stop spamming me',
  ];

  for (const text of clear) {
    it(`reads "${text}" as a request to stop`, () => {
      const asked = asksToBeLeftAlone(text);
      expect(asked, text).not.toBeNull();
      // The evidence has to come back: a durable record that somebody asked to
      // be left alone is worth nothing if nobody can see what they wrote.
      expect(asked!.evidence.length).toBeGreaterThan(0);
      expect(asked!.reason).toMatch(/stop contacting/i);
    });
  }

  it('finds one buried in a longer message, and quotes only that sentence', () => {
    const asked = asksToBeLeftAlone(
      'I liked the earlier thread about memory. Anyway, please stop tagging me in these. Cheers.',
    );
    expect(asked).not.toBeNull();
    expect(asked!.evidence).toMatch(/stop tagging me/i);
    expect(asked!.evidence, 'the sentence, not the essay').not.toMatch(/Cheers/);
  });
});

describe('things that look like one and are not', () => {
  const innocent = [
    'stop it, that is too funny',
    'I could not stop laughing',
    "don't stop, this is great",
    'never stop shipping',
    'stop me if you have heard this one',
    'this is annoying',
    'what happens if someone says stop replying to me?',
    'the agent replied to me twice',
  ];

  for (const text of innocent) {
    it(`leaves "${text}" alone`, () => {
      expect(asksToBeLeftAlone(text), text).toBeNull();
    });
  }

  it('is not fooled by nothing at all', () => {
    expect(asksToBeLeftAlone(null)).toBeNull();
    expect(asksToBeLeftAlone('')).toBeNull();
    expect(asksToBeLeftAlone('   ')).toBeNull();
  });
});
