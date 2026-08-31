import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '@xbam/shared/contracts';
import { decideEngagement, touchesTopics } from '@xbam/runtime';

/**
 * An agent should not reply to everything it happens to see.
 *
 * Found by running real posts through the pipeline: an agent whose subjects are
 * governance and token distribution engaged with a stranger's post about
 * personal hardship and offered sympathy. Kind, well written, and exactly what
 * makes an account read as a bot.
 *
 * The rule is narrow on purpose. Somebody who asks a question deserves an
 * answer whatever the subject; a post the agent merely came across through a
 * keyword or account monitor is a different matter.
 */

const base = {
  relationship: null,
  threadDepth: 1,
  recentRepliesToPerson: 0,
  alreadyRepliedInThread: false,
  policy: DEFAULT_POLICY.engagement,
  topics: ['governance', 'token distribution', 'incentives'],
};

describe('recognising the subject', () => {
  it('matches on any meaningful word of a topic', () => {
    expect(touchesTopics('the distribution changed again', ['token distribution'])).toBe(true);
    expect(touchesTopics('a vote on governance today', ['governance'])).toBe(true);
  });

  it('does not match on nothing', () => {
    expect(touchesTopics('my grandmother is unwell and I am tired', ['governance', 'incentives'])).toBe(false);
  });

  it('ignores short words that would match everything', () => {
    // A topic of "the fee" must not match on "the".
    expect(touchesTopics('nothing relevant here at all', ['the fee'])).toBe(false);
  });

  it('treats an agent with no declared topics as interested in anything', () => {
    expect(touchesTopics('literally anything', [])).toBe(true);
  });

  it('is not confused by punctuation', () => {
    expect(touchesTopics('governance, again?!', ['governance'])).toBe(true);
  });
});

describe('a post it merely came across', () => {
  it('declines something with nothing to do with its subjects', () => {
    const verdict = decideEngagement({
      ...base,
      text: 'I have been carrying this alone for months and I do not know what to do any more',
      directlyAddressed: false,
    });
    expect(verdict.factors.some((f) => f.label.includes('nothing to do with'))).toBe(true);
    expect(verdict.decision).toBe('IGNORE');
  });

  it('engages with something on its subjects', () => {
    const verdict = decideEngagement({
      ...base,
      text: 'the governance vote passed but the token distribution did not change at all',
      directlyAddressed: false,
    });
    expect(verdict.factors.some((f) => f.label.includes('something this agent follows'))).toBe(true);
    expect(verdict.decision).toBe('ENGAGE');
  });
});

describe('a message addressed to it', () => {
  it('answers an off-topic question anyway', () => {
    // Being asked is different from happening to see. Refusing to answer
    // somebody who addressed you directly is rude, not focused.
    const verdict = decideEngagement({
      ...base,
      text: '@agent what do you think about the new football season?',
      directlyAddressed: true,
    });
    expect(verdict.factors.some((f) => f.label.includes('nothing to do with'))).toBe(false);
    expect(verdict.decision).toBe('ENGAGE');
  });

  it('applies no topic factor at all when it was addressed', () => {
    const verdict = decideEngagement({
      ...base,
      text: '@agent hello, a question about governance for you here',
      directlyAddressed: true,
    });
    expect(verdict.factors.some((f) => f.label.includes('this agent follows'))).toBe(false);
  });
});

describe('an agent that has not said what it cares about', () => {
  it('is not penalised for anything', () => {
    const verdict = decideEngagement({
      ...base,
      topics: [],
      text: 'a perfectly ordinary post about absolutely anything at all in the world',
      directlyAddressed: false,
    });
    expect(verdict.factors.some((f) => f.label.includes('nothing to do with'))).toBe(false);
  });
});

describe('patterns that have to look past the handle', () => {
  // Every mention on X starts with the handle it is addressed to, so an
  // anchored pattern never matched a real message. A bare "@agent hey" scored
  // as thin content rather than as a greeting and got a reply of "Hey."
  it('recognises a bare greeting that is addressed to it', () => {
    const verdict = decideEngagement({ ...base, text: '@agent hey', directlyAddressed: true });
    expect(verdict.factors.some((f) => f.label.includes('greeting with nothing in it'))).toBe(true);
    expect(verdict.decision).toBe('IGNORE');
  });

  it('recognises promotional text behind a handle', () => {
    const verdict = decideEngagement({
      ...base,
      text: '@agent free mint today, link in bio, guaranteed 100x',
      directlyAddressed: true,
    });
    expect(verdict.factors.some((f) => f.label.includes('promotional'))).toBe(true);
    expect(verdict.decision).toBe('IGNORE');
  });

  it('still answers a greeting that carries a real question', () => {
    const verdict = decideEngagement({
      ...base,
      text: '@agent hey, what did you make of the governance vote?',
      directlyAddressed: true,
    });
    expect(verdict.factors.some((f) => f.label.includes('greeting with nothing in it'))).toBe(false);
    expect(verdict.decision).toBe('ENGAGE');
  });
});

describe('handles longer than X allows', () => {
  // Fifteen is X's limit, and enforcing it here meant a longer handle on any
  // other channel was stripped to fourteen characters and left a fragment:
  // "@scenario_harness hey" became "s hey", which is not a greeting.
  it('strips a sixteen-character handle completely', () => {
    const verdict = decideEngagement({ ...base, text: '@scenario_harness hey', directlyAddressed: true });
    expect(verdict.factors.some((f) => f.label.includes('greeting with nothing in it'))).toBe(true);
  });

  it('counts long handles when deciding a post is a mass tag', () => {
    const verdict = decideEngagement({
      ...base,
      text: '@one_very_long_handle @another_long_one @a @b @c @d look at this',
      directlyAddressed: true,
    });
    expect(verdict.factors.some((f) => f.label.includes('tags 6 accounts'))).toBe(true);
  });
});

describe('a question with nothing to answer', () => {
  // Asked "@handle thoughts?" with no post above it, the agent produced a
  // review of a piece of software nobody had mentioned. A question mark is not
  // a subject, and answering one without a subject means inventing it.
  it('declines a bare "thoughts?" with nothing above it', () => {
    const verdict = decideEngagement({
      ...base,
      text: '@agent thoughts?',
      directlyAddressed: true,
      hasParent: false,
    });
    expect(verdict.decision).toBe('IGNORE');
    expect(verdict.factors.some((f) => f.label.includes('no subject'))).toBe(true);
  });

  it('answers the same words when a parent supplies the subject', () => {
    const verdict = decideEngagement({
      ...base,
      text: '@agent thoughts?',
      directlyAddressed: true,
      hasParent: true,
    });
    expect(verdict.decision).toBe('ENGAGE');
    expect(verdict.factors.some((f) => f.label.includes('no subject'))).toBe(false);
  });

  it('leaves a real question alone', () => {
    const verdict = decideEngagement({
      ...base,
      text: '@agent do you think low fees are a moat or a subsidy?',
      directlyAddressed: true,
      hasParent: false,
    });
    expect(verdict.factors.some((f) => f.label.includes('no subject'))).toBe(false);
  });
});

describe('a question about something else entirely', () => {
  // A live run posted this: a crypto agent replied to a stranger's football
  // transfer post about who would replace whose finishing. Off-topic scored
  // -30, "asks a direct question" scored +25, and 40-30+25 is exactly the
  // default threshold -- which engages.
  const football =
    'who would you rather have up front next season, David or Woltemade? genuinely torn on this one';

  it('does not answer a football question on a crypto account', () => {
    const verdict = decideEngagement({ ...base, text: football, directlyAddressed: false });
    expect(verdict.decision).toBe('IGNORE');
    expect(verdict.factors.some((f) => f.label.includes('asks a direct question'))).toBe(false);
  });

  it('still answers the same question when the agent was actually asked', () => {
    // Being addressed is what makes a subject somebody else's business or
    // yours. A question put to the agent gets an answer whatever it is about.
    const verdict = decideEngagement({ ...base, text: `@agent ${football}`, directlyAddressed: true });
    expect(verdict.decision).toBe('ENGAGE');
    expect(verdict.factors.some((f) => f.label.includes('asks a direct question'))).toBe(true);
  });

  it('still answers an on-topic question it came across', () => {
    const verdict = decideEngagement({
      ...base,
      text: 'is token distribution actually improving, or just being reported better?',
      directlyAddressed: false,
    });
    expect(verdict.decision).toBe('ENGAGE');
    expect(verdict.factors.some((f) => f.label.includes('asks a direct question'))).toBe(true);
  });
});
