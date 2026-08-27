import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { UnsafeConfigurationError } from './errors';

const ALGO = 'aes-256-gcm';

let cachedKey: Buffer | null = null;

/**
 * The master key encrypts every provider API key at rest. It is read from the
 * environment only, never persisted, never logged, never returned by the API.
 */
export function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  // AI17Z_MASTER_KEY is preferred; XBAM_MASTER_KEY is honoured unchanged so that
  // secrets sealed before the rename stay readable. Same bytes either way.
  const raw = (process.env.AI17Z_MASTER_KEY ?? process.env.XBAM_MASTER_KEY)?.trim();
  if (!raw) {
    throw new UnsafeConfigurationError(
      'AI17Z_MASTER_KEY is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, 'base64');
  } catch {
    throw new UnsafeConfigurationError('The master key must be base64-encoded.');
  }
  if (key.length !== 32) {
    throw new UnsafeConfigurationError(`The master key must decode to exactly 32 bytes (got ${key.length}).`);
  }
  cachedKey = key;
  return key;
}

/** Only for tests that need to swap keys between cases. */
export function resetMasterKeyCache(): void {
  cachedKey = null;
}

/** Encrypts a secret to a self-describing string: v1.<iv>.<tag>.<ciphertext>. */
export function sealSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, getMasterKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('.');
}

export function openSecret(sealed: string): string {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new UnsafeConfigurationError('Stored secret is malformed or was written by a different XBAM version.');
  }
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  const decipher = createDecipheriv(ALGO, getMasterKey(), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new UnsafeConfigurationError('Stored secret could not be decrypted with the current XBAM_MASTER_KEY.');
  }
}

/** Non-reversible label so the UI can distinguish two keys without showing either. */
export function secretFingerprint(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex').slice(0, 8);
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, 'base64url');
  const derived = scryptSync(password, Buffer.from(saltB64, 'base64url'), expected.length, {
    N: Number(nStr),
    r: Number(rStr),
    p: Number(pStr),
  });
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
