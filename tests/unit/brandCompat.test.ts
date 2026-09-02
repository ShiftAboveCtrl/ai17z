import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyBrandCompatibility, getMasterKey, openSecret, resetMasterKeyCache, sealSecret } from '@xbam/shared';

const KEYS = ['AI17Z_MASTER_KEY', 'XBAM_MASTER_KEY', 'AI17Z_API_PORT', 'XBAM_API_PORT'];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  resetMasterKeyCache();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetMasterKeyCache();
});

/**
 * The rename must never cost anyone a credential. These are the cases that would
 * make that happen.
 */
describe('XBAM to AI17Z environment compatibility', () => {
  it('exposes a legacy variable under the new prefix', () => {
    process.env.XBAM_API_PORT = '8787';
    applyBrandCompatibility();
    expect(process.env.AI17Z_API_PORT).toBe('8787');
  });

  it('exposes a new variable under the legacy prefix, so old code paths still read it', () => {
    process.env.AI17Z_API_PORT = '9000';
    applyBrandCompatibility();
    expect(process.env.XBAM_API_PORT).toBe('9000');
  });

  it('never overwrites a value that was set explicitly', () => {
    process.env.XBAM_API_PORT = '1111';
    process.env.AI17Z_API_PORT = '2222';
    applyBrandCompatibility();
    expect(process.env.XBAM_API_PORT).toBe('1111');
    expect(process.env.AI17Z_API_PORT).toBe('2222');
  });
});

describe('master key continuity', () => {
  it('decrypts a secret sealed under XBAM_MASTER_KEY after the rename', () => {
    const key = randomBytes(32).toString('base64');

    // Sealed by the old build, which only knew the legacy name.
    process.env.XBAM_MASTER_KEY = key;
    resetMasterKeyCache();
    const sealed = sealSecret('sk-live-do-not-lose-me');

    // Read back by the new build, which prefers the new name and finds none.
    resetMasterKeyCache();
    expect(openSecret(sealed)).toBe('sk-live-do-not-lose-me');
  });

  it('decrypts the same secret once the environment is bridged to the new name', () => {
    const key = randomBytes(32).toString('base64');
    process.env.XBAM_MASTER_KEY = key;
    resetMasterKeyCache();
    const sealed = sealSecret('sk-live-do-not-lose-me');

    applyBrandCompatibility();
    expect(process.env.AI17Z_MASTER_KEY).toBe(key);
    resetMasterKeyCache();
    expect(openSecret(sealed)).toBe('sk-live-do-not-lose-me');
  });

  it('prefers the new name when both are set', () => {
    const preferred = randomBytes(32).toString('base64');
    process.env.AI17Z_MASTER_KEY = preferred;
    process.env.XBAM_MASTER_KEY = randomBytes(32).toString('base64');
    resetMasterKeyCache();
    expect(getMasterKey().toString('base64')).toBe(preferred);
  });

  it('names the new variable when neither is set', () => {
    resetMasterKeyCache();
    expect(() => getMasterKey()).toThrow(/AI17Z_MASTER_KEY is not set/);
  });
});

/**
 * A variable that is set but empty is not a value.
 *
 * This is what a container gets when compose interpolates a name that is not in
 * `.env`, and nobody chose it. Counting it as a value meant an empty
 * `XBAM_MASTER_KEY` blocked the mirror from a perfectly good
 * `AI17Z_MASTER_KEY`: both names present, no key anywhere, and the first thing
 * a new user does -- storing a provider API key -- failed with "AI17Z_MASTER_KEY
 * is not set".
 */
describe('an empty value is treated as absent', () => {
  it('does not let an empty legacy name shadow a real branded one', () => {
    const env = { AI17Z_MASTER_KEY: 'a-real-key', XBAM_MASTER_KEY: '' } as NodeJS.ProcessEnv;
    applyBrandCompatibility(env);
    expect(env.XBAM_MASTER_KEY).toBe('a-real-key');
  });

  it('does not let an empty branded name shadow a real legacy one', () => {
    const env = { XBAM_MASTER_KEY: 'a-real-key', AI17Z_MASTER_KEY: '' } as NodeJS.ProcessEnv;
    applyBrandCompatibility(env);
    expect(env.AI17Z_MASTER_KEY).toBe('a-real-key');
  });

  it('leaves both empty when neither was ever set', () => {
    const env = { AI17Z_MASTER_KEY: '', XBAM_MASTER_KEY: '' } as NodeJS.ProcessEnv;
    applyBrandCompatibility(env);
    expect(env.AI17Z_MASTER_KEY).toBe('');
    expect(env.XBAM_MASTER_KEY).toBe('');
  });

  it('still never overwrites a value somebody actually set', () => {
    const env = { AI17Z_MASTER_KEY: 'new', XBAM_MASTER_KEY: 'old' } as NodeJS.ProcessEnv;
    applyBrandCompatibility(env);
    expect(env.XBAM_MASTER_KEY).toBe('old');
    expect(env.AI17Z_MASTER_KEY).toBe('new');
  });
});
