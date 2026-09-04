import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '@xbam/shared';
import type { EngagementPolicy, OutreachPolicy } from '@xbam/shared/contracts';
import { decideEngagement } from '@xbam/runtime';

const engagement = (over: Partial<EngagementPolicy> = {}): EngagementPolicy => ({
  ...DEFAULT_POLICY.engagement,
  ...over,
});
const outreach = (over: Partial<OutreachPolicy> = {}): OutreachPolicy => ({
  ...DEFAULT_POLICY.outreach,
  ...over,
});

const post = (over: Partial<Parameters<typeof decideEngagement>[0]> = {}) =>
  decideEngagement({
    text: 'The hard part of local-first agents is memory, not inference. What do people do about it?',
    directlyAddressed: false,
    relationship: null,
    threadDepth: 0,
    recentRepliesToPerson: 0,
    alreadyRepliedInThread: false,
    hasParent: true,
    topics: ['local-first', 'agents', 'memory'],
    policy: engagement(),
    ...over,
  });

/**
 * Speaking first is not answering.
 *
 * Every engagement strategy is written about mentions -- ALWAYS_REPLY says
 * "anything that mentions the agent gets an answer". Applied to a watched
 * keyword, which is a search that returns strangers' posts, it means replying
 * to every post containing a word. That is a spam machine with a good persona,
 * and it was reachable from a single checkbox.
 */
describe('a post the agent went looking for', () => {
  it('is left alone when the agent does not approach people unprompted', () => {
    const verdict = post({ unprompted: true, outreach: outreach({ enabled: false }) });
    expect(verdict.decision).toBe('IGNORE');
    expect(verdict.reason).toContain('Nobody asked');
  });

  it('is left alone by default, because outreach is off by default', () => {
    expect(DEFAULT_POLICY.outreach.enabled).toBe(false);
    expect(post({ unprompted: true, outreach: DEFAULT_POLICY.outreach }).decision).toBe('IGNORE');
  });

  it('is still left alone when the agent answers every mention', () => {
    // The trap: ALWAYS_REPLY is about mentions and says nothing about strangers.
    const verdict = post({
      unprompted: true,
      policy: engagement({ strategy: 'ALWAYS_REPLY' }),
      outreach: outreach({ enabled: false }),
    });
    expect(verdict.decision).toBe('IGNORE');
  });

  it('is still left alone when the agent answers every question', () => {
    const verdict = post({
      unprompted: true,
      policy: engagement({ strategy: 'QUESTIONS_ONLY' }),
      outreach: outreach({ enabled: false }),
    });
    expect(verdict.decision).toBe('IGNORE');
  });

  it('has to clear a higher bar than a reply would', () => {
    // A score that comfortably answers a mention is not enough to butt in.
    const between = post({
      unprompted: true,
      policy: engagement({ minimumReplyValue: 35 }),
      outreach: outreach({ enabled: true, minimumValue: 95 }),
    });
    expect(between.decision).toBe('IGNORE');
    expect(between.reason).toContain('95');
  });

  it('is shown to a person first by default', () => {
    expect(DEFAULT_POLICY.outreach.mode).toBe('REVIEW');
    const verdict = post({ unprompted: true, outreach: outreach({ enabled: true, minimumValue: 0 }) });
    expect(verdict.decision).toBe('REVIEW');
  });

  it('goes out on its own only when somebody chose that', () => {
    const verdict = post({
      unprompted: true,
      outreach: outreach({ enabled: true, minimumValue: 0, mode: 'AUTONOMOUS' }),
    });
    expect(verdict.decision).toBe('ENGAGE');
  });

  it('still answers a mention normally while outreach is off', () => {
    // The outreach branch must not change how the agent answers people.
    const verdict = post({ unprompted: false, directlyAddressed: true, policy: engagement() });
    expect(verdict.decision).toBe('ENGAGE');
  });
});

/**
 * A setting that nothing reads is a capability the product does not have.
 *
 * `requireTopicMatch` sat in the contract for one commit with no code path
 * behind it, which is the same shape as "Only verified accounts" before the
 * audience gate existed.
 */
describe('only approaching people about things it follows', () => {
  const football = (over: Partial<Parameters<typeof decideEngagement>[0]> = {}) =>
    decideEngagement({
      text: 'Absolutely no excuse for that second half, the whole midfield went missing again.',
      directlyAddressed: false,
      relationship: null,
      threadDepth: 0,
      recentRepliesToPerson: 0,
      alreadyRepliedInThread: false,
      hasParent: true,
      topics: ['local-first', 'agents', 'memory'],
      unprompted: true,
      policy: engagement(),
      outreach: outreach({ enabled: true, minimumValue: 0, mode: 'AUTONOMOUS' }),
      ...over,
    });

  it('says nothing under a post about something else', () => {
    // Off-topic already costs points, but a deduction can be outweighed and
    // this is a rule rather than a weight.
    const verdict = football();
    expect(verdict.decision).toBe('IGNORE');
    expect(verdict.reason).toContain('not about anything this agent follows');
  });

  it('lets it through when the owner turned the requirement off', () => {
    expect(football({ outreach: outreach({ enabled: true, minimumValue: 0, mode: 'AUTONOMOUS', requireTopicMatch: false }) }).decision).toBe('ENGAGE');
  });

  it('does not read an empty topic list as "nothing"', () => {
    // An agent with no topics has not said what it follows, and refusing
    // everything on that basis is reading silence as a decision.
    expect(football({ topics: [] }).decision).toBe('ENGAGE');
  });

  it('still approaches when the post is about what it follows', () => {
    const verdict = decideEngagement({
      text: 'Memory is the hard part of local-first agents, not inference. Nobody has solved retrieval.',
      directlyAddressed: false,
      relationship: null,
      threadDepth: 0,
      recentRepliesToPerson: 0,
      alreadyRepliedInThread: false,
      hasParent: true,
      topics: ['local-first', 'agents', 'memory'],
      unprompted: true,
      policy: engagement(),
      outreach: outreach({ enabled: true, minimumValue: 0, mode: 'AUTONOMOUS' }),
    });
    expect(verdict.decision).toBe('ENGAGE');
  });
});
