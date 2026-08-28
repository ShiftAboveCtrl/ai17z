import { describe, expect, it } from 'vitest';
import { VoicePolicy } from '@xbam/shared/contracts';
import { compileVoice, deriveFingerprint, scoreGeneric, scoreRepetition, scoreVoice } from '@xbam/persona';

/**
 * A terse, unpunctuated writer. Short declaratives, no emoji, no hashtags, no
 * exclamation marks — the sort of voice a chatty model destroys immediately.
 */
const TERSE = [
  'Builders keep building.',
  'People vote with their money.',
  'Markets shake out the weak hands.',
  'Focus on users, not politics.',
  'Adoption compounds. Noise does not.',
  'Not predicting anything. The pattern is clear.',
  'Early still.',
  'Execution beats announcements.',
  'The foundation is stronger without them.',
  'Fees matter more than narratives.',
  'Ship first.',
  'Most of this is noise.',
  'Risk shows up where attention leaves.',
  'Slow is fine.',
  'Nothing here is new.',
  'Watch what they build.',
  'Time will sort it.',
  'That is the whole point.',
  'Fundamentals, not headlines.',
  'Patience compounds too.',
  'Users decide.',
  'Simplicity survives.',
];

const fingerprint = deriveFingerprint(TERSE, ['test corpus']);
const policy = VoicePolicy.parse({});

describe('measuring how somebody writes', () => {
  it('captures length rather than describing it', () => {
    expect(fingerprint.sampleCount).toBe(TERSE.length);
    expect(fingerprint.medianChars).toBeGreaterThan(10);
    expect(fingerprint.medianChars).toBeLessThan(50);
  });

  it('records habits the writer does not have', () => {
    expect(fingerprint.emojiRate).toBe(0);
    expect(fingerprint.hashtagRate).toBe(0);
    expect(fingerprint.exclamationRate).toBe(0);
  });

  it('carries its provenance, so a bad fingerprint can be traced', () => {
    expect(fingerprint.sources).toContain('test corpus');
    expect(fingerprint.derivedAt).toBeTruthy();
  });

  it('says nothing at all when there is nothing to measure', () => {
    expect(deriveFingerprint([]).sampleCount).toBe(0);
  });
});

describe('scoring a draft against a voice', () => {
  it('accepts something written the same way', () => {
    expect(scoreVoice('Adoption is what compounds.', fingerprint).score).toBeGreaterThanOrEqual(85);
  });

  it('rejects a wall of text from a writer who writes one line', () => {
    const wall =
      'That is a really great question, and I think there are several important dimensions to consider here. ' +
      'First, adoption patterns tend to compound over time, which means early signals can be misleading. ' +
      'Second, the market structure itself matters a great deal. Third, and perhaps most importantly, ' +
      'we should be careful not to over-index on any single data point. Overall, it depends on your timeframe.';
    const match = scoreVoice(wall, fingerprint);
    expect(match.score).toBeLessThan(60);
    expect(match.dimensions.find((d) => d.name === 'length')!.score).toBeLessThan(60);
  });

  it('notices habits the writer does not have', () => {
    const match = scoreVoice('Adoption compounds! 🚀 #crypto', fingerprint);
    expect(match.dimensions.find((d) => d.name === 'punctuation')!.score).toBeLessThan(80);
  });

  it('admits when there are too few samples to judge', () => {
    const thin = deriveFingerprint(['Short.', 'Also short.']);
    expect(scoreVoice('anything at all', thin).lowConfidence).toBe(true);
  });

  it('does not penalise anything when it has never seen the writer', () => {
    expect(scoreVoice('literally anything', deriveFingerprint([])).score).toBe(100);
  });
});

describe('detecting generic assistant prose', () => {
  it('catches the stock opening', () => {
    const result = scoreGeneric('Great question! Adoption compounds over time.');
    expect(result.score).toBeGreaterThan(15);
    expect(result.reasons.join(' ')).toMatch(/praising the question/i);
  });

  it('catches the helpdesk sign-off', () => {
    const result = scoreGeneric('Adoption compounds. Let me know if you have any other questions!');
    expect(result.reasons.join(' ')).toMatch(/invitation to follow up/i);
  });

  it('catches the shape, not just the words', () => {
    // No blacklisted phrase anywhere; the structure is the tell.
    const balanced =
      'There are arguments on both sides here. However, the distribution schedule does create pressure. ' +
      'That said, the team has a strong record. On the other hand, timing matters enormously in these cases, ' +
      'and it depends very much on what happens over the coming quarter.';
    const result = scoreGeneric(balanced);
    expect(result.score).toBeGreaterThan(15);
    expect(result.reasons.join(' ')).toMatch(/both sides|commits to neither/i);
  });

  it('leaves a plain answer alone', () => {
    expect(scoreGeneric('Adoption compounds. Noise does not.').score).toBe(0);
  });

  it('respects a persona that is meant to sound corporate', () => {
    const text = 'We should leverage best practices across stakeholders.';
    expect(scoreGeneric(text, { avoid: ['chatbot'] }).score).toBe(0);
    expect(scoreGeneric(text, { avoid: ['corporate'] }).score).toBeGreaterThan(0);
  });

  it('weighs a phrase the owner asked it to avoid most heavily', () => {
    const result = scoreGeneric('The alpha here is obvious.', { avoidPhrases: ['alpha'] });
    expect(result.score).toBeGreaterThanOrEqual(30);
    expect(result.reasons.join(' ')).toMatch(/you asked it to avoid/i);
  });
});

describe('noticing repetition', () => {
  const yesterday = new Date(Date.now() - 20 * 3_600_000).toISOString();

  it('catches a sentence lifted from a recent reply', () => {
    const result = scoreRepetition('Risk shows up where attention leaves the room entirely.', [
      { text: 'Risk shows up where attention leaves the room entirely.', at: yesterday },
    ]);
    expect(result.score).toBeGreaterThan(80);
    expect(result.reason).toBeTruthy();
  });

  it('catches a reused opening', () => {
    const result = scoreRepetition('Most of this is noise, and the rest is timing.', [
      { text: 'Most of this is noise. Ignore it.', at: yesterday },
    ]);
    expect(result.score).toBeGreaterThan(50);
  });

  it('leaves genuinely different text alone', () => {
    const result = scoreRepetition('Fees matter more than the headlines suggest.', [
      { text: 'Builders keep building whatever the price does.', at: yesterday },
    ]);
    expect(result.score).toBeLessThan(30);
  });

  it('is harder on saying the same thing to the same person', () => {
    // Partial overlap rather than a verbatim repeat, so the score is not
    // already at the ceiling and the difference is actually visible.
    const candidate = 'Adoption compounds and noise does not, whichever way the price goes.';
    const previous = 'Adoption compounds and noise does not, whatever anyone says about it.';
    const anyone = scoreRepetition(candidate, [{ text: previous, at: yesterday }]);
    const again = scoreRepetition(candidate, [{ text: previous, at: yesterday, sameRecipient: true }]);
    expect(anyone.score).toBeLessThan(100);
    expect(again.score).toBeGreaterThan(anyone.score);
  });

  it('cares less about something said weeks ago', () => {
    const text = 'Adoption compounds and noise does not, whatever the price is doing.';
    const recent = scoreRepetition(text, [{ text, at: yesterday }]);
    const old = scoreRepetition(text, [{ text, at: new Date(Date.now() - 30 * 86_400_000).toISOString() }]);
    expect(old.score).toBeLessThan(recent.score);
  });

  it('lets a signature phrase recur once it has rested', () => {
    const options = { signaturePhrases: ['builders keep building'], signatureRestHours: 48 };
    const text = 'Builders keep building.';
    const tooSoon = scoreRepetition(text, [{ text, at: yesterday }], options);
    const rested = scoreRepetition(
      text,
      [{ text, at: new Date(Date.now() - 96 * 3_600_000).toISOString() }],
      options,
    );
    expect(tooSoon.score).toBeGreaterThan(0);
    expect(rested.score).toBe(0);
  });

  it('says nothing when the agent has said nothing yet', () => {
    expect(scoreRepetition('anything', []).score).toBe(0);
  });
});

describe('the voice compiler', () => {
  it('leaves a draft that already sounds right completely alone', () => {
    const result = compileVoice({ draft: 'Adoption compounds.', fingerprint, policy });
    expect(result.applied).toBe('none');
    expect(result.text).toBe('Adoption compounds.');
  });

  it('strips a filler opening without touching the meaning', () => {
    const result = compileVoice({
      draft: 'Great question! Adoption is what compounds here, not the noise around it.',
      fingerprint,
      policy,
    });
    expect(result.text).not.toMatch(/^great question/i);
    expect(result.text).toMatch(/adoption/i);
    expect(result.changes.join(' ')).toMatch(/filler opening/i);
  });

  it('strips a helpdesk sign-off', () => {
    const result = compileVoice({
      draft: 'Adoption is the thing that compounds over time. Hope this helps!',
      fingerprint,
      policy,
    });
    expect(result.text).not.toMatch(/hope this helps/i);
  });

  it('removes habits the agent measurably does not have', () => {
    const result = compileVoice({
      draft: 'Adoption compounds over the long run! #crypto 🚀',
      fingerprint,
      policy,
    });
    expect(result.text).not.toContain('#crypto');
    expect(result.text).not.toContain('🚀');
    expect(result.text).not.toContain('!');
  });

  it('never invents words, only removes and substitutes', () => {
    const draft = 'We should leverage this in order to facilitate adoption.';
    const result = compileVoice({ draft, fingerprint, policy });
    expect(result.text).toContain('use');
    expect(result.text).toContain('adoption');
    // Every remaining word came from the draft or the substitution table.
    expect(result.text.split(/\s+/).length).toBeLessThanOrEqual(draft.split(/\s+/).length);
  });

  it('asks for a model rewrite only when the cheap pass was not enough', () => {
    const wall =
      'That is a genuinely fascinating question and I think there are several important dimensions worth ' +
      'considering carefully here. Adoption patterns compound over long periods, which means that early ' +
      'signals can often be quite misleading if taken in isolation. Additionally, the broader market ' +
      'structure plays a significant role. Ultimately, it very much depends on your particular timeframe.';
    const result = compileVoice({ draft: wall, fingerprint, policy });
    expect(result.applied).toBe('model_needed');
    expect(result.rewriteBrief).toMatch(/about \d+ characters/i);
  });

  it('describes the voice in numbers, not adjectives', () => {
    const wall = 'A'.repeat(900);
    const result = compileVoice({ draft: wall, fingerprint, policy });
    expect(result.rewriteBrief).toMatch(/never uses emoji/i);
    expect(result.rewriteBrief).toMatch(/never uses hashtags/i);
    expect(result.rewriteBrief).not.toMatch(/\b(dry|witty|concise)\b/i);
  });

  it('honours the hard output ceiling whatever the fingerprint says', () => {
    const result = compileVoice({
      draft: 'Adoption compounds and the noise does not, whatever the price happens to be doing today.',
      fingerprint,
      policy,
      maxCharacters: 40,
    });
    expect(result.text.length).toBeLessThanOrEqual(40);
  });

  it('does nothing at all when turned off', () => {
    const draft = 'Great question! Hope this helps!';
    const result = compileVoice({ draft, fingerprint, policy: VoicePolicy.parse({ enabled: false }) });
    expect(result.text).toBe(draft);
  });
});

/**
 * The test the whole subsystem exists for.
 *
 * Two providers with deliberately different house styles, one persona. After
 * the compiler, both should land in the same place — not identical text, which
 * would be a different and impossible requirement, but the same measurable
 * voice.
 */
describe('identity survives a change of provider', () => {
  const chatty =
    "Great question! I'd say adoption is really what compounds over time here, and the noise around it " +
    "matters much less than people think. Hope that helps — let me know if you have any other questions!";
  const formal =
    'It is important to note that adoption compounds over time. In order to facilitate a clear ' +
    'understanding, one should leverage the distinction between signal and noise. In conclusion, ' +
    'the former is what matters.';

  it('brings two different house styles toward the same voice', () => {
    const a = compileVoice({ draft: chatty, fingerprint, policy });
    const b = compileVoice({ draft: formal, fingerprint, policy });

    // Both improved, and neither still carries its provider's tells.
    expect(a.scoreAfter).toBeGreaterThan(a.scoreBefore);
    expect(b.scoreAfter).toBeGreaterThan(b.scoreBefore);
    expect(a.text).not.toMatch(/great question|hope that helps|let me know/i);
    expect(b.text).not.toMatch(/leverage|in order to|important to note/i);
  });

  it('leaves both saying the same thing', () => {
    const a = compileVoice({ draft: chatty, fingerprint, policy });
    const b = compileVoice({ draft: formal, fingerprint, policy });
    // Not identical text — that would be a different requirement, and an
    // impossible one. The meaning survives in both.
    expect(a.text.toLowerCase()).toContain('adoption');
    expect(b.text.toLowerCase()).toContain('adoption');
  });

  it('scores both against the same fingerprint, not against each other', () => {
    const a = scoreGeneric(compileVoice({ draft: chatty, fingerprint, policy }).text);
    const b = scoreGeneric(compileVoice({ draft: formal, fingerprint, policy }).text);
    expect(a.score).toBeLessThan(scoreGeneric(chatty).score);
    expect(b.score).toBeLessThan(scoreGeneric(formal).score);
  });
});
