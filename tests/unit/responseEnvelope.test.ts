import { describe, expect, it } from 'vitest';
import { envelopeFor, lengthInstruction } from '@xbam/shared';

/**
 * How much of a reply a message is actually asking for.
 *
 * The failure behind this: the envelope was a property of the persona and
 * nothing else, so a persona set to MEDIUM answered the word "nice" with two to
 * four sentences. Every reply the live agent published came out between 110 and
 * 175 characters, including the ones answering jokes, and a timeline of
 * uniformly-sized paragraphs reads as a machine whatever the words are.
 *
 * The strongest signal is how much the other person said, which is why most of
 * these are about length rather than about vocabulary. A verdict that depends
 * on detecting mood from wording is one that will be wrong often enough to be
 * worse than the default.
 */

describe('what a short message is asking for', () => {
  it('answers a joke with a line, and does not ask a question back', () => {
    const got = envelopeFor('haha the worker died mid-job again');
    expect(got.register).toBe('BANTER');
    expect(got.sentences).toBe(1);
    // Explaining a joke is worse than not landing one.
    expect(got.inviteQuestion).toBe(false);
  });

  it('takes a compliment without writing an essay about it', () => {
    for (const kind of ['nice one', 'thanks!', 'this is great', 'congrats']) {
      const got = envelopeFor(kind);
      expect(got.register).toBe('PRAISE');
      expect(got.sentences).toBe(1);
      expect(got.inviteQuestion).toBe(false);
    }
  });

  it('answers four words with one line, whatever the words were', () => {
    // No vocabulary involved, and no punctuation either. Somebody who wrote
    // four words is not asking for four sentences, and that holds in any
    // language and on any subject.
    const got = envelopeFor('is it on github');
    expect(got.sentences).toBe(1);
    expect(got.because).toMatch(/wrote 4 words/);
  });

  it('answers a short question with one line too', () => {
    const got = envelopeFor('is it on github?');
    expect(got.register).toBe('QUESTION');
    expect(got.sentences).toBe(1);
    expect(got.because).toMatch(/short question/i);
  });

  it('says why, so the reason travels into the prompt', () => {
    expect(envelopeFor('lol').because).toBeTruthy();
    expect(envelopeFor('it broke again on my machine after the update last night').because).toBeTruthy();
  });
});

describe('what a real question is asking for', () => {
  it('gives a technical question room to actually help', () => {
    const got = envelopeFor('Does `acquireTab` recycle the renderer, or just the page? Asking about v1.0.0-beta.24.');
    expect(got.register).toBe('TECHNICAL');
    expect(got.sentences).toBe(4);
  });

  it('answers an ordinary question and stops', () => {
    const got = envelopeFor('So how does it decide when to actually post something on its own, out of interest?');
    expect(got.register).toBe('QUESTION');
    expect(got.sentences).toBe(2);
    // The paragraph after the answer is the model explaining itself.
    expect(got.inviteQuestion).toBe(false);
  });

  it('is specific back when somebody is being specific', () => {
    const got = envelopeFor('I pointed it at https://github.com/example/proj and it recorded forty events at once');
    expect(got.register).toBe('TECHNICAL');
    // The one case where asking something focused is usually the useful part.
    expect(got.inviteQuestion).toBe(true);
  });
});

describe('what a substantial message is asking for', () => {
  it('engages properly with somebody who wrote something substantial', () => {
    const long = Array.from({ length: 45 }, (_, i) => `word${i}`).join(' ');
    const got = envelopeFor(long);
    expect(got.sentences).toBe(4);
    expect(got.inviteQuestion).toBe(true);
  });

  it('gives an ordinary remark an ordinary reply', () => {
    const got = envelopeFor('I have been running one of these on a spare laptop for about a week now');
    expect(got.register).toBe('PLAIN');
    expect(got.sentences).toBe(2);
  });

  it('falls back sensibly when there is nothing to answer', () => {
    // An original post has no incoming message. The persona's own setting is
    // the only guide there is.
    const got = envelopeFor('');
    expect(got.register).toBe('PLAIN');
    expect(got.inviteQuestion).toBe(false);
  });
});

describe('the owner’s setting is a ceiling', () => {
  it('never writes more than the owner allowed, however much somebody wrote', () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const envelope = envelopeFor(long);
    expect(envelope.sentences).toBe(4);
    // An owner who asked for terse replies keeps them.
    expect(lengthInstruction(envelope, 1)).toMatch(/^One sentence\./);
    expect(lengthInstruction(envelope, 2)).toMatch(/^One or two sentences\./);
  });

  it('narrows within the ceiling rather than always using it', () => {
    // This is the whole point: a MEDIUM persona should still answer a joke
    // with one line.
    expect(lengthInstruction(envelopeFor('lol nice'), 4)).toMatch(/^One sentence\./);
    expect(lengthInstruction(envelopeFor('why does it do that?'), 4)).toMatch(/^One sentence\./);
  });

  it('carries the reason and the question guidance into the instruction', () => {
    const said = lengthInstruction(envelopeFor('haha'), 4);
    expect(said).toMatch(/joking/);
    expect(said).toMatch(/Do not end with a question/);

    const technical = lengthInstruction(envelopeFor('I set `maxLiveTabs` to 2 and it still opened four'), 4);
    expect(technical).toMatch(/ask one specific thing/);
  });

  it('never produces a ceiling below one sentence', () => {
    expect(lengthInstruction(envelopeFor('anything at all here'), 0)).toMatch(/^One sentence\./);
  });
});
