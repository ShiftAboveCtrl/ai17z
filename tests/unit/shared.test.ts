import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  actionIdempotencyKey,
  backoffMs,
  contentSignature,
  hashPassword,
  openSecret,
  resetMasterKeyCache,
  sealSecret,
  secretFingerprint,
  slugify,
  truncateTail,
  verifyPassword,
} from '@xbam/shared';

beforeAll(() => {
  // Both names resolve to the master key, with AI17Z_ taking precedence. Tests
  // that rotate the key must clear the other, or the old key silently wins.
  delete process.env.XBAM_MASTER_KEY;
  process.env.AI17Z_MASTER_KEY = randomBytes(32).toString('base64');
  resetMasterKeyCache();
});

describe('secret sealing', () => {
  it('round-trips a value without ever storing it in the clear', () => {
    const key = 'sk-test-abcdef1234567890';
    const sealed = sealSecret(key);
    expect(sealed).not.toContain(key);
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(openSecret(sealed)).toBe(key);
  });

  it('produces a different ciphertext each time, so equal keys are not linkable', () => {
    expect(sealSecret('same')).not.toBe(sealSecret('same'));
  });

  it('refuses to decrypt under a different master key', () => {
    const sealed = sealSecret('secret-value');
    process.env.AI17Z_MASTER_KEY = randomBytes(32).toString('base64');
    resetMasterKeyCache();
    expect(() => openSecret(sealed)).toThrow(/could not be decrypted/i);
  });

  it('fingerprints are stable, short, and not reversible to the key', () => {
    const fingerprint = secretFingerprint('sk-test-abcdef');
    expect(fingerprint).toHaveLength(8);
    expect(secretFingerprint('sk-test-abcdef')).toBe(fingerprint);
    expect('sk-test-abcdef').not.toContain(fingerprint);
  });
});

describe('passwords', () => {
  it('verifies the right password and rejects the wrong one', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(stored).not.toContain('correct horse');
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(verifyPassword('wrong', stored)).toBe(false);
  });

  it('rejects malformed stored hashes rather than throwing', () => {
    expect(verifyPassword('anything', 'not-a-hash')).toBe(false);
  });
});

describe('idempotency keys', () => {
  it('is identical for the same event regardless of when it is computed', () => {
    const parts = {
      channel: 'x',
      accountId: 'acc-1',
      remoteEventId: '1234567890',
      actionType: 'REPLY',
      agentId: 'agent-1',
    };
    expect(actionIdempotencyKey(parts)).toBe(actionIdempotencyKey({ ...parts }));
  });

  it('separates two agents acting on the same event', () => {
    const base = { channel: 'x', accountId: 'acc-1', remoteEventId: '1', actionType: 'REPLY' };
    expect(actionIdempotencyKey({ ...base, agentId: 'a' })).not.toBe(actionIdempotencyKey({ ...base, agentId: 'b' }));
  });

  it('signs content per target so the same text elsewhere is still allowed', () => {
    const a = contentSignature('https://x.com/u/status/1', 'hello');
    const b = contentSignature('https://x.com/u/status/2', 'hello');
    expect(a).not.toBe(b);
    expect(contentSignature('https://x.com/u/status/1', '  hello  ')).toBe(a);
  });
});

describe('backoff', () => {
  it('grows with each attempt and stays inside the cap', () => {
    const first = Array.from({ length: 40 }, () => backoffMs(1));
    const later = Array.from({ length: 40 }, () => backoffMs(6));
    expect(Math.max(...first)).toBeLessThan(Math.max(...later));
    expect(Math.max(...Array.from({ length: 60 }, () => backoffMs(20)))).toBeLessThanOrEqual(5 * 60_000);
    expect(Math.min(...first)).toBeGreaterThan(0);
  });
});

describe('helpers', () => {
  it('slugifies names and never returns an unusable slug', () => {
    expect(slugify('AI4CZ Agent')).toBe('ai4cz-agent');
    expect(slugify('   ')).toMatch(/^agent-[0-9a-f]{6}$/);
    expect(slugify('!!!')).toMatch(/^agent-[0-9a-f]{6}$/);
  });

  it('keeps the newest content when trimming a transcript', () => {
    expect(truncateTail('abcdefghij', 4)).toBe('ghij');
    expect(truncateTail('abc', 10)).toBe('abc');
  });
});
