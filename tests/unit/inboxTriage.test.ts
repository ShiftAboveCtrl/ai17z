import { describe, expect, it } from 'vitest';
import { readsAsQuestion, inboxTriage, type InboxTriageInput } from '@xbam/runtime';

/**
 * Inbox triage. What is pinned: somebody who wrote in and asked something
 * ranks above something the radar found; a held reply needs the owner; spam
 * and settled rows are left, never acted on; age counts against; and nothing
 * here reads an audience.
 */

const NOW = new Date('2026-10-09T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const row = (over: Partial<InboxTriageInput> = {}): InboxTriageInput => ({
  type: 'MENTION',
  text: 'nice',
  state: 'NOT_ACTIONED',
  occurredAt: hoursAgo(1),
  ingestedAt: hoursAgo(1),
  decision: null,
  threadMessages: 1,
  ourTurns: 0,
  priorFromPerson: 0,
  spamVerdict: 'CLEAN',
  ...over,
});

describe('inbox triage', () => {
  it('suggests answering somebody who asked the agent something, with the reasons', () => {
    const t = inboxTriage(row({ text: 'how does the bridge work?' }), NOW);
    expect(t.suggestion).toBe('ANSWER');
    expect(t.factors.map((f) => f.factor)).toEqual(['wrote_to_agent', 'question']);
    expect(t.summary).toMatch(/^Worth answering\./);
  });

  it('ranks a conversation in progress above a stranger, and a held reply above both', () => {
    const stranger = inboxTriage(row({ text: 'what is this?' }), NOW);
    const ongoing = inboxTriage(row({ text: 'what is this?', ourTurns: 2 }), NOW);
    const held = inboxTriage(row({ text: 'what is this?', state: 'NEEDS_REVIEW', ourTurns: 2 }), NOW);
    expect(ongoing.score).toBeGreaterThan(stranger.score);
    expect(held).toMatchObject({ suggestion: 'REVIEW', priority: 'HIGH' });
  });

  it('leaves spam and found-by-search noise, and never suggests anything for a settled row', () => {
    expect(inboxTriage(row({ spamVerdict: 'SPAM', state: 'FILTERED' }), NOW)).toMatchObject({ suggestion: 'LEAVE', priority: 'LOW' });
    expect(inboxTriage(row({ type: 'KEYWORD_MATCH', text: 'gm' }), NOW).suggestion).toBe('LEAVE');
    for (const state of ['REPLIED', 'DECLINED', 'DRY_RUN', 'WORKING']) {
      expect(inboxTriage(row({ state, text: 'why?' }), NOW).suggestion).toBe('NOTHING');
    }
  });

  it('counts age against a message, and past three days stops suggesting an answer', () => {
    const fresh = inboxTriage(row({ text: 'why?' }), NOW);
    const day = inboxTriage(row({ text: 'why?', occurredAt: hoursAgo(30) }), NOW);
    const old = inboxTriage(row({ text: 'why?', type: 'DIRECT_MESSAGE', ourTurns: 3, occurredAt: hoursAgo(80) }), NOW);
    expect(day.score).toBeLessThan(fresh.score);
    expect(old.suggestion).toBe('LEAVE');
  });

  it('reads no audience, so a row cannot carry one into the decision', () => {
    const t = inboxTriage({ ...row({ text: 'why?' }), followers: 1_000_000 } as InboxTriageInput, NOW);
    expect(t).toEqual(inboxTriage(row({ text: 'why?' }), NOW));
  });

  it('recognises a question by shape', () => {
    expect(readsAsQuestion('is the pool live')).toBe(true);
    expect(readsAsQuestion('Great work. How long did it take')).toBe(true);
    expect(readsAsQuestion('this is how it goes')).toBe(false);
  });
});
