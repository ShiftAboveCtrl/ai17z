import { describe, expect, it } from 'vitest';
import { inbox } from '@xbam/database';

const item = (over: Partial<Parameters<typeof inbox.bucketOf>[0]> = {}) => ({
  state: 'NOT_ACTIONED' as const,
  type: 'MENTION',
  text: 'nice work on this',
  ...over,
});

/**
 * The Activity table already lists everything that happened, and that is its
 * problem: it answers "what occurred" and an owner is asking "what do I need to
 * do". A reply that went out perfectly is the most interesting row in a log and
 * the least interesting thing in an inbox.
 */
describe('which bucket something belongs in', () => {
  it('puts anything waiting on a person first, whatever else it is', () => {
    // The only bucket with an action in it, so it outranks the kind of message.
    expect(inbox.bucketOf(item({ state: 'NEEDS_REVIEW', type: 'REPLY', text: 'how do I do this?' }))).toBe('NEEDS_REVIEW');
  });

  it('puts a failure next, for the same reason', () => {
    expect(inbox.bucketOf(item({ state: 'FAILED', type: 'MENTION' }))).toBe('ERRORS');
  });

  it('separates a post the agent went looking for from one it was sent', () => {
    // Approaching a stranger and answering somebody are different acts and an
    // owner reviews them differently.
    expect(inbox.bucketOf(item({ type: 'KEYWORD_MATCH' }))).toBe('OUTREACH');
  });

  it('calls an unanswered question a question', () => {
    expect(inbox.bucketOf(item({ text: 'how do I connect an account?' }))).toBe('QUESTIONS');
    expect(inbox.bucketOf(item({ text: 'what happened to the launch' }))).toBe('QUESTIONS');
  });

  it('stops calling it a question once it has been answered', () => {
    // Nobody is waiting on it any more, and an inbox that keeps showing
    // answered questions is one people stop opening.
    expect(inbox.bucketOf(item({ text: 'how do I do this?', state: 'REPLIED' }))).not.toBe('QUESTIONS');
  });

  it('tells a reply from a mention', () => {
    expect(inbox.bucketOf(item({ type: 'REPLY', text: 'thanks' }))).toBe('REPLIES');
    expect(inbox.bucketOf(item({ type: 'MENTION', text: 'thanks' }))).toBe('MENTIONS');
  });

  it('counts every item exactly once', () => {
    const items = [
      item({ state: 'NEEDS_REVIEW' }),
      item({ state: 'FAILED' }),
      item({ type: 'KEYWORD_MATCH' }),
      item({ text: 'why?' }),
      item({ type: 'REPLY' }),
      item(),
    ].map((i) => ({ ...i, eventId: '', agentId: null, agentName: null, authorHandle: null, url: null, occurredAt: null, ingestedAt: '', jobId: null, jobStatus: null, errorClass: null, draftText: null, replyText: null, replyUrl: null, repliedAt: null }));

    const counts = inbox.countBuckets(items);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(items.length);
  });
});
