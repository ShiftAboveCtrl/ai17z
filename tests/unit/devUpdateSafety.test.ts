import { describe, expect, it } from 'vitest';
import {
  DevUpdateSubmissionInput,
  POST_MAX_CHARS,
  checkFacts,
  checkPostText,
  composePost,
  entryNodeFor,
  evidenceKeys,
  factFingerprint,
  looksLikeRawCode,
  looksPrivateLocation,
  looksSecret,
  looksSensitive,
  textFingerprint,
} from '@xbam/runtime';
import { defaultPipelineDraft } from '../../packages/runtime/src/defaultPipeline';

// Assembled at runtime so no credential-shaped literal sits in a tracked file
// for the release check (or anybody's scanner) to find.
const FAKE_GITHUB_TOKEN = ['gh', 'p_0123456789abcdefghijABCDEFGHIJ012345'].join('');
const FAKE_KEY_HEADER = ['-----BEGIN OPENSSH', 'PRIVATE KEY-----'].join(' ');

/**
 * What a development update may say.
 *
 * Every case here is one where getting it wrong publishes something that
 * cannot be taken back, or posts something that reads as a bot, so the tests
 * are written from the refusing side: the dangerous input first, then the
 * ordinary developer sentence that must still get through.
 */

function submission(overrides: Partial<DevUpdateSubmissionInput> = {}): DevUpdateSubmissionInput {
  return DevUpdateSubmissionInput.parse({
    projectKey: 'ai17z',
    kind: 'FIX',
    title: 'Replies keep their thread after a restart',
    summary: 'A worker restart used to drop the conversation a reply belonged to, so the next answer started from nothing.',
    why: 'Long conversations no longer lose their context halfway.',
    evidence: [
      { type: 'COMMIT', ref: '3b724fe', detail: 'Thread binding survives lease recovery' },
      { type: 'TEST', detail: 'Recovery suite passes, 42 cases' },
    ],
    disclosure: 'PUBLIC',
    ...overrides,
  });
}

const codes = (refusals: { code: string }[]) => refusals.map((r) => r.code);

describe('secrets never pass', () => {
  it.each([
    ['an OpenAI style key', 'rotated sk-proj-abcdefghijklmnop1234567890 today'],
    ['a GitHub token', FAKE_GITHUB_TOKEN],
    ['an AWS key', 'AKIAIOSFODNN7EXAMPLE was leaked'],
    ['a private key header', FAKE_KEY_HEADER],
    ['a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc'],
    ['an assignment', 'set API_KEY=supersecretvalue in prod'],
    ['a password in a connection string', 'postgres://xbam:hunter2@example.com/xbam'],
    ['our own sender token', 'ai17z_dus_Q2hhbmdlTWVQbGVhc2VUaGlzSXNOb3RSZWFs'],
    ['a high entropy blob', 'token Zx8Kq2LmN4pR7sT1vW3yB6dF9hJ0kM5nQ'],
    ['a 64 hex private key', '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'],
  ])('refuses %s', (_label, text) => {
    expect(looksSecret(text)).toBe(true);
  });

  it('lets a commit sha and ordinary prose through', () => {
    expect(looksSecret('fixed in 3b724fe5c1d2e3f4a5b6c7d8e9f00112233445566 after review')).toBe(false);
    expect(looksSecret('Replies keep their thread after a worker restart')).toBe(false);
    expect(looksSecret('released v1.0.0-beta.87 with the new cadence engine')).toBe(false);
  });
});

describe('private places never pass', () => {
  it.each([
    'see http://localhost:8787/api/jobs',
    'deployed to https://build.internal/status',
    'logs at 10.0.4.12',
    'C:\\Users\\owner\\project\\notes.txt',
    'lives in /home/someone/ai17z/storage',
    'mail me at owner@example.org',
    'https://user:pass@example.org/owner/repo',
    'https://example.com/download?token=abc123',
  ])('refuses %s', (text) => {
    expect(looksPrivateLocation(text)).toBe(true);
  });

  it('allows a public link', () => {
    expect(looksPrivateLocation('notes at https://github.com/ShiftAboveCtrl/ai17z/releases')).toBe(false);
  });
});

describe('code and diffs never pass', () => {
  it.each([
    'diff --git a/x.ts b/x.ts',
    '@@ -1,4 +1,6 @@',
    '+const token = read()\n+send(token)',
    '```ts\nconst x = 1\n```',
    "import { readFile } from 'node:fs'",
    'function claim(job) { return job }',
    'at runJob (packages/runtime/src/pipeline.ts:120:5)',
    'failed in pipeline.ts:120 after retry',
  ])('refuses %s', (text) => {
    expect(looksLikeRawCode(text)).toBe(true);
  });

  it('allows a bulleted description and prose that says select', () => {
    expect(looksLikeRawCode('- faster replies\n- fewer retries')).toBe(false);
    expect(looksLikeRawCode('you can now select a model from the list when creating an agent')).toBe(false);
  });
});

describe('the facts', () => {
  it('accepts an ordinary, specific update', () => {
    expect(checkFacts(submission())).toEqual([]);
  });

  it('refuses without an explicit public disclosure', () => {
    expect(codes(checkFacts(submission({ disclosure: 'true' })))).toContain('NOT_PUBLIC');
    expect(codes(checkFacts(submission({ disclosure: 'public' })))).toContain('NOT_PUBLIC');
  });

  it('refuses something that says nothing', () => {
    const vague = checkFacts(submission({ title: 'Bug fixes', summary: 'Various improvements and minor fixes here.', why: 'better' }));
    expect(codes(vague)).toContain('NOT_MEANINGFUL');
    expect(vague.map((r) => r.field)).toEqual(expect.arrayContaining(['title', 'summary', 'why']));
  });

  it('refuses housekeeping and dependency bumps', () => {
    expect(codes(checkFacts(submission({ title: 'chore: tidy the scripts folder' })))).toContain('NOT_MEANINGFUL');
    expect(
      codes(checkFacts(submission({ summary: 'Bumped dependencies across the workspace and refreshed the lockfile today.' }))),
    ).toContain('NOT_MEANINGFUL');
  });

  it('refuses evidence that is only notes', () => {
    expect(codes(checkFacts(submission({ evidence: [{ type: 'NOTE', detail: 'trust me' }] })))).toContain('NOT_MEANINGFUL');
  });

  it('checks evidence fields for secrets and code too, and never repeats them', () => {
    const secret = FAKE_GITHUB_TOKEN;
    const refusals = checkFacts(submission({ evidence: [{ type: 'COMMIT', ref: 'abc1234', detail: `uses ${secret}` }] }));
    expect(codes(refusals)).toContain('SECRET');
    expect(JSON.stringify(refusals)).not.toContain(secret);
  });
});

describe('the post', () => {
  it('accepts a developer saying what shipped', () => {
    expect(checkPostText('replies keep their thread after a worker restart now. long conversations stop losing context halfway.')).toEqual([]);
  });

  it.each([
    ['naming the assistant', 'shipped thread recovery today, Claude did most of the heavy lifting on it'],
    ['an attribution phrase', 'new cadence engine is out, built with an AI assistant over the weekend'],
    ['an AI generated label', 'release notes for 1.4 below, AI-generated summary of the week'],
    ['auto-posted', 'auto-posted: the scheduler now respects quiet hours properly'],
    ['co-authored-by', 'fixed the lease bug. Co-authored-by: someone at the keyboard'],
    ['the robot', 'fixed the reply lag that people kept hitting 🤖'],
  ])('refuses %s', (_label, text) => {
    expect(codes(checkPostText(text))).toContain('ATTRIBUTION');
  });

  it('still lets a project about automation talk about its features', () => {
    expect(checkPostText('scheduled posts now respect quiet hours, so nothing goes out at 3am by accident')).toEqual([]);
    expect(checkPostText('added an Anthropic provider, so agents can run on whichever model you prefer')).toEqual([]);
  });

  it('refuses hashtag spam, mentions, filler and length', () => {
    expect(codes(checkPostText('fixed the reply lag people kept hitting #buildinpublic #devlog #ai'))).toContain('HASHTAG_SPAM');
    expect(checkPostText('fixed the reply lag people kept hitting today #buildinpublic')).toEqual([]);
    expect(codes(checkPostText('fixed the reply lag people kept hitting, thanks @someone'))).toContain('MENTION');
    expect(codes(checkPostText('so excited to announce our new scheduler, a total game changer!!!'))).toContain('FILLER');
    expect(codes(checkPostText('word '.repeat(70)))).toContain('TOO_LONG');
    expect(codes(checkPostText('fixed it'))).toContain('NOT_MEANINGFUL');
  });
});

describe('security and unreleased work', () => {
  it.each([
    'Closed an authentication bypass in the login flow',
    'bypassing the login with an old cookie no longer works',
    'patched CVE-2026-12345 in the uploader',
    'fixed an XSS in the profile page',
    'a security fix for the session store',
    'the unreleased billing redesign handles refunds',
    'stays under embargo until next week',
    'internal-only dashboard for the team',
    'not yet public, but the new scheduler is done',
    'remote code execution through the importer',
  ])('refuses "%s" as a fact and as a post, whatever the disclosure says', (text) => {
    expect(looksSensitive(text)).toBe(true);
    const facts = checkFacts(submission({ summary: `${text}, and that is now different for people using it.` }));
    expect(codes(facts)).toContain('SENSITIVE');
    expect(codes(checkPostText(`${text}, and it is live for everyone now`))).toContain('SENSITIVE');
  });

  it('leaves ordinary work alone', () => {
    expect(looksSensitive('Replies keep their thread after a worker restart')).toBe(false);
    expect(looksSensitive('released v1.4 with faster cold starts')).toBe(false);
    expect(looksSensitive('sign-in now remembers the last account you used')).toBe(false);
  });

  it('accepts only an identifier as a request id', () => {
    expect(() => submission({ clientRequestId: 'req-2026-11-07:0001' })).not.toThrow();
    expect(() => submission({ clientRequestId: 'the staging password is hunter2' })).toThrow();
  });
});

describe('composing a post', () => {
  it('fits, passes its own rules, and never mentions who wrote it', () => {
    for (const kind of ['FEATURE', 'FIX', 'IMPROVEMENT', 'MILESTONE', 'RELEASE'] as const) {
      const input = submission({ kind });
      const post = composePost(input, 'AI17Z', factFingerprint(kind, input.title));
      expect([...post].length).toBeLessThanOrEqual(POST_MAX_CHARS);
      expect(checkPostText(post), post).toEqual([]);
      expect(post).not.toMatch(/claude|assistant|automat|#/i);
    }
  });

  it('is the same post for the same update and varies between updates', () => {
    const a = submission();
    const seed = factFingerprint(a.kind, a.title);
    expect(composePost(a, 'AI17Z', seed)).toBe(composePost(a, 'AI17Z', seed));
    const openers = new Set(
      Array.from({ length: 12 }, (_, i) => composePost(a, 'AI17Z', factFingerprint('FIX', `title ${i}`)).split(' ')[0]),
    );
    expect(openers.size).toBeGreaterThan(1);
  });

  it('shortens rather than overflowing', () => {
    const long = submission({ summary: `${'The reply path got a lot more careful about retries. '.repeat(10)}`.trim() });
    expect([...composePost(long, 'AI17Z', 'ffffffff')].length).toBeLessThanOrEqual(POST_MAX_CHARS);
  });
});

describe('identity of an update', () => {
  it('treats a reworded title as the same fact only when the words are the same', () => {
    expect(factFingerprint('FIX', 'Replies keep their thread!')).toBe(factFingerprint('FIX', 'replies keep their thread'));
    expect(factFingerprint('FIX', 'Replies keep their thread')).not.toBe(factFingerprint('FEATURE', 'Replies keep their thread'));
    expect(textFingerprint('Same text.')).toBe(textFingerprint('same text'));
  });

  it('keys a commit by its short sha and ignores unkeyed evidence', () => {
    expect(
      evidenceKeys([
        { type: 'COMMIT', ref: '3b724fe5c1d2e3f4a5b6c7d8e9f0011223344556', detail: 'x' },
        { type: 'PULL_REQUEST', ref: '#42', detail: 'x' },
        { type: 'TEST', ref: 'suite', detail: 'x' },
      ]),
    ).toEqual(['COMMIT:3b724fe', 'PULL_REQUEST:42']);
  });
});

describe('where a written post joins the pipeline', () => {
  it('enters at the approval gate of the default graph, so the agent can still ask first', () => {
    const draft = defaultPipelineDraft();
    expect(entryNodeFor(draft.nodes, draft.edges)).toBe('approval');
  });

  it('enters at the action when a graph has no gate', () => {
    const draft = defaultPipelineDraft();
    const nodes = draft.nodes.filter((n) => n.kind !== 'APPROVAL_GATE');
    expect(entryNodeFor(nodes, draft.edges)).toBe('execute');
    expect(entryNodeFor(nodes.filter((n) => n.kind !== 'EXECUTE_ACTION'), draft.edges)).toBeNull();
  });
});
