import { describe, expect, it } from 'vitest';
import { DevUpdateSubmissionInput, checkPostText, splitDevUpdate } from '../../packages/runtime/src/devUpdateSafety';

describe('development update parts', () => {
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
