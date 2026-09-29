import { describe, expect, it } from 'vitest';
import { EngagementPolicy, KNOWN_AUTOMATED_HANDLES } from '@xbam/shared/contracts';
import { decideEngagement, exchangeLimit } from '@xbam/runtime';

/**
 * How much an agent says to one person is a limit, not a weight.
 *
 * The case these replay: a live agent answered @grok eight times in eighteen
 * minutes. Its policy allowed twelve replies a person an hour and a reply floor
 * of 10, every Grok message was friendly and addressed to it, and the rendered
 * thread showed only one or two of its own turns because X collapses a long
 * chain. Each of the last four scored 13, 31, 13 and 31, and each went out.
 */

const meadgod = EngagementPolicy.parse({ minimumReplyValue: 10, maxRepliesPerPersonPerHour: 12 });

const known = {
  known: true,
  handle: 'grok',
  familiarity: 'KNOWN' as const,
  historyLine: '',
  topics: [],
  summary: null,
  ownerNote: null,
  disposition: 'NEUTRAL' as const,
  callback: null,
};

const grokTurn = {
  text: '@MEADGod17z Permanent blackout. The tough-guy act never survives the first real camera.',
  directlyAddressed: true,
  relationship: known,
  hasParent: true,
  alreadyRepliedInThread: true,
  policy: meadgod,
};

describe('the exchange that did not stop', () => {
  it('answered it under the old reading, where the thread showed two turns and nobody knew it was a bot', () => {
    // What the agent was actually told at 01:52. Kept to show the limits below
    // are what changed, not the scoring.
    const verdict = decideEngagement({ ...grokTurn, threadDepth: 3, recentRepliesToPerson: 7, ourRepliesInThread: 2 });
    expect(verdict.decision).toBe('ENGAGE');
  });

  it('stops once it knows it has already spoken seven times in this back-and-forth', () => {
    const verdict = decideEngagement({ ...grokTurn, threadDepth: 14, recentRepliesToPerson: 7, ourRepliesInThread: 7 });
    expect(verdict.decision).toBe('IGNORE');
  });

  it('answers an automated account once and then stops, whatever the thread limit is', () => {
    const first = decideEngagement({ ...grokTurn, threadDepth: 1, recentRepliesToPerson: 0, ourRepliesInThread: 0, counterpartAutomated: true });
    const second = decideEngagement({ ...grokTurn, threadDepth: 2, recentRepliesToPerson: 1, ourRepliesInThread: 1, counterpartAutomated: true });
    expect(first.decision).toBe('ENGAGE');
    expect(second.decision).toBe('IGNORE');
    expect(second.reason).toMatch(/automated account/);
  });

  it('knows grok is automated without being told', () => {
    expect(KNOWN_AUTOMATED_HANDLES.x).toContain('grok');
  });
});

describe('each limit is a stop, and says which one it was', () => {
  const policy = EngagementPolicy.parse({});
  const worthy = {
    text: '@agent what do you actually think about the unlock schedule and the second order effects?',
    directlyAddressed: true,
    relationship: null,
    hasParent: true,
    alreadyRepliedInThread: false,
    threadDepth: 1,
    recentRepliesToPerson: 0,
    ourRepliesInThread: 0,
    policy,
  };

  it('answers somebody the ordinary way when no limit is reached', () => {
    expect(decideEngagement(worthy).decision).toBe('ENGAGE');
  });

  it('stops at the hourly limit for one person however good the message is', () => {
    const verdict = decideEngagement({ ...worthy, recentRepliesToPerson: policy.maxRepliesPerPersonPerHour });
    expect(verdict.decision).toBe('IGNORE');
    expect(verdict.reason).toMatch(/limit for one person/);
  });

  it('stops at the thread limit', () => {
    const verdict = decideEngagement({
      ...worthy,
      alreadyRepliedInThread: true,
      ourRepliesInThread: policy.maxRepliesPerThread,
      threadDepth: 2 * policy.maxRepliesPerThread,
    });
    expect(verdict.decision).toBe('IGNORE');
    expect(verdict.reason).toMatch(/limit for one thread/);
  });

  it('stops past the depth limit', () => {
    const verdict = decideEngagement({ ...worthy, threadDepth: policy.maxThreadDepth + 1 });
    expect(verdict.decision).toBe('IGNORE');
    expect(verdict.reason).toMatch(/messages deep/);
  });

  it('holds under ALWAYS_REPLY and QUESTIONS_ONLY, which used to skip every limit', () => {
    for (const strategy of ['ALWAYS_REPLY', 'QUESTIONS_ONLY'] as const) {
      const p = EngagementPolicy.parse({ strategy });
      const verdict = decideEngagement({ ...worthy, policy: p, recentRepliesToPerson: p.maxRepliesPerPersonPerHour });
      expect(verdict.decision, strategy).toBe('IGNORE');
    }
  });

  it('keeps the score and its reasons on a stopped decision', () => {
    const verdict = decideEngagement({ ...worthy, recentRepliesToPerson: 5 });
    expect(verdict.value).toBeGreaterThan(0);
    expect(verdict.factors.length).toBeGreaterThan(0);
  });

  it('reports nothing when nothing is reached', () => {
    expect(exchangeLimit({ recentRepliesToPerson: 0, ourRepliesInThread: 2, threadDepth: 4, policy })).toBeNull();
  });
});
