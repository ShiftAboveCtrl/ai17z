import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '@xbam/shared/contracts';
import { decideEngagement, replyValue } from '@xbam/runtime';

/**
 * Knowing when a conversation is over.
 *
 * An agent that never follows up is a doorbell; an agent that always follows up
 * is the person who has to have the last word. The old rule had only two
 * settings between those -- a boolean "have I spoken here" and a cliff at six
 * messages -- so answering somebody's follow-up and being five turns deep in a
 * thread nobody is reading scored identically.
 *
 * What actually decays is the value of the next turn, so that is what these
 * pin: each turn the agent has already taken costs more than the last, and a
 * message that closes an exchange is recognised as closing it.
 */

const base = {
  relationship: null,
  threadDepth: 2,
  recentRepliesToPerson: 0,
  alreadyRepliedInThread: false,
  ourRepliesInThread: 0,
  policy: DEFAULT_POLICY.engagement,
  directlyAddressed: true,
  hasParent: true,
};

const value = (over: Partial<typeof base> & { text: string }) =>
  replyValue({ ...base, ...over }).value;

describe('following up in a thread', () => {
  it('answers the first reply to something it said', () => {
    // The case that was impossible: somebody answers the agent, and the agent
    // answers back. Worth doing, and worth doing without hesitation.
    const verdict = decideEngagement({
      ...base,
      text: '@agent so does that mean the fee goes up for everyone or only for new pairs?',
      alreadyRepliedInThread: true,
      ourRepliesInThread: 1,
    });

    expect(verdict.decision).toBe('ENGAGE');
  });

  it('gets less willing with every turn it has taken', () => {
    const text = '@agent right, but what about the second order effect on liquidity providers?';
    const first = value({ text, ourRepliesInThread: 1, alreadyRepliedInThread: true });
    const third = value({ text, ourRepliesInThread: 3, alreadyRepliedInThread: true });
    const fifth = value({ text, ourRepliesInThread: 5, alreadyRepliedInThread: true });

    expect(first).toBeGreaterThan(third);
    expect(third).toBeGreaterThan(fifth);
  });

  it('stops on its own once it has said enough', () => {
    // Nobody configured this and no ceiling was reached. The same question, on
    // the fifth turn, is simply not worth the sixth answer.
    const text = '@agent and what about the case where the pair is illiquid?';
    const early = decideEngagement({ ...base, text, ourRepliesInThread: 1, alreadyRepliedInThread: true });
    const late = decideEngagement({ ...base, text, ourRepliesInThread: 5, alreadyRepliedInThread: true });

    expect(early.decision).toBe('ENGAGE');
    expect(late.decision).toBe('IGNORE');
  });

  it('says which turn it was on when it stopped', () => {
    const verdict = decideEngagement({
      ...base,
      text: '@agent and one more thing about the fee',
      ourRepliesInThread: 4,
      alreadyRepliedInThread: true,
    });

    expect(verdict.factors.map((f) => f.label).join(' ')).toContain('4 times in this thread');
  });
});

describe('a conversation that has run its course', () => {
  const closers = ['makes sense', 'ok cool', 'fair enough', 'agreed', 'got it, thanks', '👍', 'gg'];

  for (const text of closers) {
    it(`does not answer "${text}" after it has already spoken`, () => {
      const verdict = decideEngagement({
        ...base,
        text: `@agent ${text}`,
        alreadyRepliedInThread: true,
        ourRepliesInThread: 1,
      });

      expect(verdict.decision).toBe('IGNORE');
    });
  }

  it('still answers the same words from somebody opening a conversation', () => {
    // "agreed" as the first thing anybody has said to the agent is a person
    // being friendly, not the end of an exchange. There is no last word to
    // insist on having.
    const opening = value({ text: '@agent agreed', ourRepliesInThread: 0, alreadyRepliedInThread: false });
    const closing = value({ text: '@agent agreed', ourRepliesInThread: 1, alreadyRepliedInThread: true });

    expect(opening).toBeGreaterThan(closing);
  });

  it('keeps answering when they are still actually asking', () => {
    // The distinction that matters: "fair enough" ends a thread, "fair enough,
    // but what about..." does not, and an anchored pattern is what tells them
    // apart.
    const verdict = decideEngagement({
      ...base,
      text: '@agent fair enough, but what about the accounts that never migrated?',
      alreadyRepliedInThread: true,
      ourRepliesInThread: 1,
    });

    expect(verdict.decision).toBe('ENGAGE');
  });
});
