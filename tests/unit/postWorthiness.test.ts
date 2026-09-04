import { describe, expect, it } from 'vitest';
import { asksAboutTheAgent, questionKey, spokenQuestion, textStandsAlone } from '@xbam/shared';

/**
 * These are the shapes found in a real backlog of twenty-seven captured ideas,
 * of which eighteen could never have become a post. The wording is rewritten so
 * strangers' messages are not carried in the repository; what is preserved is
 * the grammar the rules actually key on, which is the part that was failing.
 */
describe('whether a question could be the subject of a post', () => {
  const couldBeAPost = (q: string) => textStandsAlone(spokenQuestion(q)) && !asksAboutTheAgent(spokenQuestion(q));

  it('rejects a question that only meant something in its thread', () => {
    // Captured verbatim, all of them, and none of them mean anything alone.
    expect(couldBeAPost("what's your thoughts on this?")).toBe(false);
    expect(couldBeAPost('is this the one you meant?')).toBe(false);
    expect(couldBeAPost('Do you think it can run much further? If so, why?')).toBe(false);
  });

  it('rejects a question too short to be about anything', () => {
    expect(couldBeAPost('Like one of the big models?')).toBe(false);
    expect(couldBeAPost('Is the listing paid?')).toBe(false);
  });

  it('rejects a question aimed at the agent rather than at a topic', () => {
    // Conversation, support and small talk. Real, all four shapes.
    expect(couldBeAPost('hey, I hear you just came to life. How are you feeling and what is your purpose?')).toBe(false);
    expect(couldBeAPost('why is your website link broken on the chart site?')).toBe(false);
    expect(couldBeAPost('when are you gonna get a listing and update your terminal page?')).toBe(false);
    expect(couldBeAPost('are you going to let everybody down like the last one did? If so then when?')).toBe(false);
  });

  it('keeps a question about something, which is what the backlog is for', () => {
    expect(couldBeAPost('Does the token provide any utility, and what are the token and the software used for?')).toBe(true);
    expect(couldBeAPost('How do you weigh throughput against finality when both are constrained?')).toBe(true);
  });

  it('does not mistake a statement containing "you" for a question about the agent', () => {
    // The rule is about questions. A sentence that merely says "you" is not one.
    expect(asksAboutTheAgent('The attribution gap is solvable if you separate attestation from identity.')).toBe(false);
  });
});

/**
 * A mention carries the handle it was aimed at and whatever line breaks the
 * client inserted. Keeping them made the duplicate check useless and made an
 * idea read as a screenshot of somebody's tweet rather than a note to self.
 */
describe('normalising a question', () => {
  it('drops the handle and the line breaks', () => {
    expect(spokenQuestion('@someagent\n how are ya?')).toBe('how are ya?');
    expect(spokenQuestion('hey  @someagent   @someone_else  what now?')).toBe('hey what now?');
  });

  it('gives the same key to the same question typed differently', () => {
    // Four near-identical copies of one question sat in the real backlog,
    // because exact lowercase equality never matched any of them.
    const asked = ['@theagent\nwhat are your thoughts on this?', "What are your thoughts on this?", '  what are your   thoughts on this ? '];
    const keys = new Set(asked.map(questionKey));
    expect(keys.size).toBe(1);
  });

  it('still tells two different questions apart', () => {
    expect(questionKey('what is the plan?')).not.toBe(questionKey('what was the plan?'));
  });
});
