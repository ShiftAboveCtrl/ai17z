import { describe, expect, it } from 'vitest';
import { PolicyConfig } from '@xbam/shared/contracts';
import {
  DevUpdateProjectInput,
  DevUpdateProjectPatch,
  DevUpdateSubmissionInput,
  POST_MAX_CHARS,
  POST_MAX_CHARS_CEILING,
  checkPostText,
  composePost,
  withPostLimit,
} from '@xbam/runtime';
import { validateOutput } from '../../packages/runtime/src/validator';
import { splitDevUpdate } from '../../tools/dev-update-parts.mjs';
import { POST_MAX_CHARS_CEILING as WEB_CEILING, parseMaxPostChars } from '../../apps/web/src/lib/devUpdates';

/**
 * A project's post length: 280 unless its owner raises it, and when raised, the
 * one ceiling every check holds the post to.
 */

const SENTENCE = 'replies keep their thread through a worker restart now, so long chats stop losing context halfway. ';

/** A plain developer post of exactly `chars` characters that breaks no other rule. */
function longPost(chars: number): string {
  let text = '';
  while ([...text].length < chars) text += SENTENCE;
  return [...text].slice(0, chars).join('').trim();
}

const codes = (text: string, limit?: number) => checkPostText(text, limit).map((r) => r.code);

describe('the length check follows the project', () => {
  it('accepts a 2,000 character post on a project set to 25,000', () => {
    const post = longPost(2000);
    expect([...post].length).toBeGreaterThan(1990);
    expect(checkPostText(post, 25_000)).toEqual([]);
  });

  it('refuses the same post with TOO_LONG on a default project', () => {
    const post = longPost(2000);
    expect(codes(post)).toContain('TOO_LONG');
    expect(codes(post, POST_MAX_CHARS)).toContain('TOO_LONG');
    const refusal = checkPostText(post).find((r) => r.code === 'TOO_LONG')!;
    expect(refusal.message).toMatch(/2000 characters and the most this project allows is 280/);
  });

  it('draws the line at the project limit and no other', () => {
    expect(codes(longPost(1000), 1000)).not.toContain('TOO_LONG');
    expect(codes(longPost(1001), 1000)).toContain('TOO_LONG');
  });

  it('counts per code point, with a link at its full length', () => {
    expect(codes('😀'.repeat(300), 300)).not.toContain('TOO_LONG');
    expect(codes('😀'.repeat(301), 300)).toContain('TOO_LONG');
    // X would count this link as 23 characters; here it is all of them.
    const link = `https://example.com/${'a'.repeat(40)}`;
    const text = `${longPost(250)} ${link}`;
    expect([...text].length).toBeGreaterThan(290);
    expect(codes(text, 280)).toContain('TOO_LONG');
    expect(codes(text, 1000)).not.toContain('TOO_LONG');
  });

  it('still applies every other rule to a long post', () => {
    expect(codes(`${longPost(2000)} thanks @someone`, 25_000)).toContain('MENTION');
    expect(codes(`${longPost(2000)} All of it was fixed with Claude.`, 25_000)).toContain('ATTRIBUTION');
  });

  it('accepts a post past the old 400 character schema bound, so the limit is judged by the project', () => {
    const parsed = DevUpdateSubmissionInput.safeParse({
      projectKey: 'demo',
      kind: 'FIX',
      title: 'Replies keep their thread',
      summary: 'A restart used to drop the conversation.',
      why: 'Chats stop losing context.',
      evidence: [{ type: 'COMMIT', ref: 'abc1234', detail: 'binding survives recovery' }],
      disclosure: 'PUBLIC',
      post: longPost(2000),
    });
    expect(parsed.success).toBe(true);
  });

  it('composes within the project limit', () => {
    const input = { kind: 'FIX' as const, title: 'Thread recovery', summary: 'A restart no longer drops a conversation.', why: 'Chats keep their context.' };
    expect([...composePost(input, 'AI17Z', 'ffffffff', 120)].length).toBeLessThanOrEqual(120);
  });
});

describe('the policy carries the project limit', () => {
  const policy = PolicyConfig.parse({});

  it('leaves a default project under the agent policy exactly as it is', () => {
    expect(policy.output.maxCharacters).toBe(280);
    expect(withPostLimit(policy, POST_MAX_CHARS)).toBe(policy);
  });

  it('raises the ceiling for a long project without touching the stored policy', () => {
    const limited = withPostLimit(policy, 5000);
    expect(limited.output.maxCharacters).toBe(5000);
    expect(policy.output.maxCharacters).toBe(280);
    expect(withPostLimit(limited, 5000)).toBe(limited);
  });

  it('does not trim a long post, which the agent policy alone would', () => {
    const post = longPost(2000);
    const plain = validateOutput(post, policy, null, '');
    expect(plain.output.length).toBeLessThanOrEqual(280);
    expect(plain.violations.map((v) => v.rule)).toContain('max_length');

    const held = validateOutput(post, withPostLimit(policy, 25_000), null, '');
    expect(held.output).toBe(post);
    expect(held.violations.map((v) => v.rule)).not.toContain('max_length');
  });
});

describe('the setting', () => {
  const base = {
    projectKey: 'demo',
    displayName: 'Demo',
    agentId: '11111111-1111-4111-8111-111111111111',
    accountId: '22222222-2222-4222-8222-222222222222',
  };

  it('defaults to 280 on a new project', () => {
    expect(DevUpdateProjectInput.parse(base).maxPostChars).toBe(280);
  });

  it('accepts 280 through 25,000', () => {
    for (const maxPostChars of [280, 281, 4000, 25_000]) {
      expect(DevUpdateProjectPatch.safeParse({ maxPostChars }).success, String(maxPostChars)).toBe(true);
      expect(DevUpdateProjectInput.safeParse({ ...base, maxPostChars }).success, String(maxPostChars)).toBe(true);
    }
    expect(POST_MAX_CHARS_CEILING).toBe(25_000);
  });

  it('refuses under 280, over 25,000 and anything that is not a whole number', () => {
    for (const maxPostChars of [279, 0, -1, 25_001, 100_000, 280.5, '4000', null]) {
      expect(DevUpdateProjectPatch.safeParse({ maxPostChars }).success, String(maxPostChars)).toBe(false);
      expect(DevUpdateProjectInput.safeParse({ ...base, maxPostChars }).success, String(maxPostChars)).toBe(false);
    }
  });
});

describe('the settings field', () => {
  it('passes only what the server accepts, and says why for the rest', () => {
    expect(parseMaxPostChars('280')).toEqual({ value: 280 });
    expect(parseMaxPostChars(' 4000 ')).toEqual({ value: 4000 });
    expect(parseMaxPostChars('25000')).toEqual({ value: 25_000 });
    expect(parseMaxPostChars('279')).toMatchObject({ problem: expect.stringMatching(/least is 280/) });
    expect(parseMaxPostChars('25001')).toMatchObject({ problem: expect.stringMatching(/most is 25,000/) });
    for (const raw of ['', 'abc', '12.5', '-300', '4,000']) expect(parseMaxPostChars(raw), raw).toHaveProperty('problem');
    // The same ceiling as the server, so the box never offers a number the server refuses.
    expect(WEB_CEILING).toBe(POST_MAX_CHARS_CEILING);
  });
});

describe('splitting a thread', () => {
  it('splits at 280 unless told the project allows more', () => {
    const text = longPost(2000);
    const parts = splitDevUpdate(text, 1000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => [...part].length <= 1000)).toBe(true);
    expect(() => splitDevUpdate('x'.repeat(281))).toThrow('280 code points');
    expect(splitDevUpdate('x'.repeat(281), 300)).toEqual(['x'.repeat(281)]);
  });
});
