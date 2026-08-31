import { describe, expect, it } from 'vitest';
import { fingerprint } from '@xbam/channels';

/**
 * Recognising its own reply after posting it.
 *
 * Not cosmetic. This match is the only thing that tells "X refused the reply"
 * apart from "X accepted it and left the composer up", and retrying the second
 * posts twice. Two near-duplicate replies sitting on the live account are what
 * that looked like from outside.
 *
 * The pairs below are real: the left is what AI17Z submitted, the right is what
 * X rendered back, read with innerText.
 */
const asSubmitted = 'Not surprised, @mastrxyz\u2014August wasn\u2019t just degens being reckless, it was governance failing.';
const asRendered = 'Not surprised, @mastrxyz \u2014August wasn\u2019t just degens being reckless, it was governance failing.';

describe('matching a reply to what X rendered', () => {
  it('survives the space X inserts around a mention link', () => {
    // The exact failure: X wraps every @mention in an anchor, and innerText
    // puts whitespace around a link, so the raw strings differ by one space in
    // the middle of the first forty characters.
    expect(asSubmitted).not.toEqual(asRendered);
    expect(fingerprint(asRendered)).toContain(fingerprint(asSubmitted).slice(0, 60));
  });

  it('survives smart quotes, non-breaking spaces and zero-width characters', () => {
    const submitted = 'Fees are a moat only if they don\u2019t need a subsidy';
    const rendered = "Fees\u00a0are a moat only if they don't\u200b need a subsidy";
    expect(fingerprint(rendered)).toContain(fingerprint(submitted).slice(0, 40));
  });

  it('still refuses a different reply', () => {
    const other = 'Completely unrelated text about something else entirely today';
    expect(fingerprint(other)).not.toContain(fingerprint(asSubmitted).slice(0, 60));
  });

  it('is not fooled by a short needle matching the wrong post', () => {
    // Sixty characters of fingerprint rather than forty of raw text, because
    // stripping punctuation costs length and a short needle matches anything.
    const short = fingerprint('Agreed.');
    expect(short.length).toBeLessThan(60);
    expect(fingerprint('Agreed. Completely different reply.')).toContain(short);
  });
});
