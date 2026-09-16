import { describe, expect, it } from 'vitest';
import { emptyFingerprint } from '@xbam/shared/contracts';
import { compileVoice, longerThanUsual } from '@xbam/persona';
import type { VoiceFingerprint } from '@xbam/shared/contracts';

/**
 * A reply is never cut off in the middle of a thought.
 *
 * The defect these exist for, measured on the live agent: drafts of 196 to 230
 * characters were landing as published replies of 170 to 175, cut at a word
 * boundary mid-sentence. "a different risk class than". "why no official X API
 * key is". The configured limit was 280 the whole time.
 *
 * The cause was a second ceiling in the voice compiler, derived from the voice
 * fingerprint: `p90Chars * 1.3` or `medianChars * 2.5`. With no stored samples
 * a fingerprint is derived from the persona's **style examples**, and this
 * agent had thirty-two of them running from "ha. okay that's fair" upwards.
 * Those show a register, not an extent. Taking a maximum from them produced
 * about 175, and the compiler chopped to it.
 */

/** A fingerprint shaped like the live agent's: short examples, enough of them. */
function shortVoice(over: Partial<VoiceFingerprint> = {}): VoiceFingerprint {
  return {
    ...emptyFingerprint(),
    sampleCount: 32,
    medianChars: 53,
    p90Chars: 130,
    medianSentences: 1,
    ...over,
  };
}

const policy = {
  enabled: true,
  acceptAt: 0,
  lightRewriteAt: 0,
  allowModelRewrite: false,
  genericRewriteAbove: 100,
  repetitionRewriteAbove: 100,
} as never;

/** 214 characters, one complete thought, well under the 280 X allows. */
const LONG_BUT_FINE =
  'The useful part is not that it can write a reply, because everything can write a reply now. ' +
  'It is that the thing writing it remembers what you said last week and can tell you where it got that from.';

describe('the voice compiler and length', () => {
  it('does not cut a draft that is longer than the agent usually writes', () => {
    // This is the exact shape that was being chopped: comfortably inside the
    // policy limit, comfortably outside what the style examples suggest.
    expect(LONG_BUT_FINE.length).toBeGreaterThan(175);
    expect(LONG_BUT_FINE.length).toBeLessThan(280);

    const got = compileVoice({
      draft: LONG_BUT_FINE,
      fingerprint: shortVoice(),
      policy,
      maxCharacters: 280,
    });

    expect(got.text.length).toBe(LONG_BUT_FINE.length);
    expect(got.text.endsWith('from.')).toBe(true);
    expect(got.changes.join(' ')).not.toMatch(/shortened/);
  });

  it('never ends a reply mid-word', () => {
    const got = compileVoice({ draft: LONG_BUT_FINE, fingerprint: shortVoice(), policy, maxCharacters: 280 });
    // The old failure ended on a dangling preposition because the fallback cut
    // at the last space it could find.
    expect(got.text).toMatch(/[.!?]$/);
  });

  it('still respects the policy limit, which is the one hard ceiling', () => {
    const enormous = `${LONG_BUT_FINE} ${LONG_BUT_FINE}`;
    const got = compileVoice({ draft: enormous, fingerprint: shortVoice(), policy, maxCharacters: 280 });
    expect(got.text.length).toBeLessThanOrEqual(280);
    // And even there the cut is sentence-aware rather than mid-word.
    expect(got.changes.join(' ')).toMatch(/280 character limit/);
  });

  it('leaves a short reply completely alone', () => {
    const short = 'ha. okay that is fair';
    const got = compileVoice({ draft: short, fingerprint: shortVoice(), policy, maxCharacters: 280 });
    expect(got.text).toBe(short);
  });
});

describe('telling the rewriter rather than cutting', () => {
  it('says a draft is longer than usual, and says not to cut it', () => {
    const said = longerThanUsual(LONG_BUT_FINE, shortVoice());
    expect(said).toBeTruthy();
    expect(said).toMatch(/fewer words/);
    // The instruction that matters: shorter, not shortened.
    expect(said).toMatch(/finish the thought/);
  });

  it('says nothing about a reply that is the usual length', () => {
    expect(longerThanUsual('Nice. First contribution?', shortVoice())).toBeNull();
  });

  it('says nothing when there are too few samples to mean anything', () => {
    // An agent with four style examples has no measured habit, and inventing
    // one from four lines is how the original defect happened.
    expect(longerThanUsual(LONG_BUT_FINE, shortVoice({ sampleCount: 4 }))).toBeNull();
  });
});

describe('the lengths the live agent was actually producing', () => {
  it.each([196, 206, 217, 229, 230])('leaves a %i character draft intact', (length) => {
    // Every one of these was generated and then published at 170 to 175.
    const draft = `${'Something worth saying that runs on for a while and finishes properly. '.repeat(6)}`.slice(
      0,
      length - 1,
    );
    const whole = `${draft}.`;
    const got = compileVoice({ draft: whole, fingerprint: shortVoice(), policy, maxCharacters: 280 });
    expect(got.text.length).toBe(whole.length);
  });
});
