import { describe, expect, it } from 'vitest';
import { DevUpdateSubmissionInput, checkPostText, splitDevUpdate } from '../../packages/runtime/src/devUpdateSafety';
import { replyTargetAllowed, verifyAnchoredAction } from '../../packages/channels/src/x/targets';

describe('development update parts', () => {
  it('preserves paragraph breaks and prefers complete sentences', () => {
    const first = 'Readers can follow the complete change. '.repeat(4).trim();
    const second = 'The next paragraph explains how recovery keeps the published sections in order. '.repeat(2).trim();
    expect(splitDevUpdate(`${first}\n\n${second}`)).toEqual([first, second]);
    expect(splitDevUpdate('A short paragraph.\n\nAnother paragraph.')).toEqual(['A short paragraph.\n\nAnother paragraph.']);
    expect(splitDevUpdate(`${'A complete sentence. '.repeat(10)}${'More detail follows. '.repeat(8)}`.trim())[0]).toMatch(/[.!?]$/);
  });
  it('splits on words without losing text or splitting code points', () => {
    const text = 'Published improvements make longer conversations easier to follow. '.repeat(8).trim();
    const parts = splitDevUpdate(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join(' ')).toBe(text);
    expect(parts.every((part) => [...part].length <= 280)).toBe(true);
    expect(splitDevUpdate('😀'.repeat(280))).toEqual(['😀'.repeat(280)]);
  });
  it('refuses more than six parts and unsplittable words', () => {
    expect(() => splitDevUpdate('word '.repeat(400))).toThrow('one to six parts');
    expect(() => splitDevUpdate('x'.repeat(281))).toThrow('280 code points');
  });
  it('accepts one to six parts and refuses competing post inputs', () => {
    const base = { projectKey: 'demo', kind: 'FEATURE', title: 'Readable updates', summary: 'Detailed updates explain the shipped changes to their readers.', why: 'Readers can follow the work.', evidence: [{ type: 'TEST', detail: 'Verified thread order' }], disclosure: 'PUBLIC' };
    expect(DevUpdateSubmissionInput.parse({ ...base, parts: ['A detailed update makes the shipped work easier to follow.'] }).parts).toHaveLength(1);
    expect(DevUpdateSubmissionInput.safeParse({ ...base, parts: [] }).success).toBe(false);
    expect(DevUpdateSubmissionInput.safeParse({ ...base, parts: Array(7).fill('text') }).success).toBe(false);
    expect(DevUpdateSubmissionInput.safeParse({ ...base, post: 'text', parts: ['text'] }).success).toBe(false);
    expect(checkPostText('😀'.repeat(280)).some((r) => r.code === 'TOO_LONG')).toBe(false);
    expect(checkPostText('😀'.repeat(281)).some((r) => r.code === 'TOO_LONG')).toBe(true);
  });
});

describe('exact reply target decision without an adapter', () => {
  const base = { type: 'REPLY', targetStatusId: '123456', anchoredStatusId: '123456', authorHandle: 'self', selfHandles: ['self'] };
  it('allows only the recorded previous part as a self continuation', () => {
    expect(replyTargetAllowed({ ...base, previousPartStatusId: '123456' })).toBe(true);
  });
  it('refuses every other self reply, including a different recorded part', () => {
    expect(replyTargetAllowed(base)).toBe(false);
    expect(replyTargetAllowed({ ...base, previousPartStatusId: '987654' })).toBe(false);
  });
  it('allows someone else with the same exact target verification', () => {
    expect(replyTargetAllowed({ ...base, authorHandle: 'reader' })).toBe(true);
  });
  it('refuses an anchor mismatch even for the recorded continuation', () => {
    expect(replyTargetAllowed({ ...base, anchoredStatusId: '987654', previousPartStatusId: '123456' })).toBe(false);
  });
  it('refuses a like or a repost even when the previous part id matches', () => {
    for (const type of ['LIKE', 'REPOST']) {
      expect(replyTargetAllowed({ ...base, type, previousPartStatusId: '123456' })).toBe(false);
    }
  });
  it('passes request.threadContinuation through the check verifyAction applies to the article', () => {
    const snapshot = { statusId: '123456', authorHandle: 'self', text: 'The previous part.' };
    const reply = verifyAnchoredAction({
      request: { type: 'REPLY', threadContinuation: { previousPartStatusId: '123456' } },
      statusId: '123456', selfHandles: ['self'], snapshot,
    });
    expect(reply.verified).toBe(true);
    expect(reply.evidence.previousPartStatusId).toBe('123456');
    for (const type of ['LIKE', 'REPOST'] as const) {
      const refused = verifyAnchoredAction({
        request: { type, threadContinuation: { previousPartStatusId: '123456' } },
        statusId: '123456', selfHandles: ['self'], snapshot,
      });
      expect(refused.verified).toBe(false);
      expect(refused.evidence.previousPartStatusId).toBe('123456');
    }
  });
});
