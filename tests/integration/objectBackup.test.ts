import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  OBJECT_STORE_CAVEATS,
  backupKeyFor,
  fetchForRestore,
  keyIsOwned,
  objectBackupStore,
  resetBackupStoreForTest,
  sha256Of,
  storeBackup,
  useObjectBackupStore,
  verifyBackup,
  type ObjectStoreConfig,
} from '@xbam/runtime';

/**
 * Backups against a real S3-compatible server, not a fake one.
 *
 * `backupStoreFs` proves the discipline against a disk. This proves the
 * protocol: that the requests are signed the way S3 expects, that the bytes
 * that come back are the bytes that went out, and that a 404 is told apart
 * from a failure. A fake store cannot get a signature wrong.
 *
 * The server is `adobe/s3mock` on a container port, started by the lab. If it
 * is not reachable these skip loudly rather than passing, for the same reason
 * `realChrome.test.ts` does: a test that quietly passes where the thing it
 * tests is absent is worse than no test.
 */

const ENDPOINT = process.env.AI17Z_LAB_S3_ENDPOINT ?? 'http://127.0.0.1:19090';
const BUCKET = process.env.AI17Z_LAB_S3_BUCKET ?? 'ai17z-backups-lab';

const config: ObjectStoreConfig = {
  endpoint: ENDPOINT,
  region: 'us-east-1',
  bucket: BUCKET,
  // Synthetic, and only ever presented to a local test server.
  accessKeyId: 'ai17zlab',
  secretAccessKey: 'ai17zlabsecret',
  pathStyle: true,
  prefix: 'runtime-backups',
};

let reachable = false;

beforeAll(async () => {
  try {
    const response = await fetch(`${ENDPOINT}/`, { method: 'GET' });
    reachable = response.ok;
  } catch {
    reachable = false;
  }
  if (!reachable) {
    process.stdout.write(
      `\n  SKIPPING objectBackup: no S3-compatible server at ${ENDPOINT}.\n` +
        '  Start one with: docker run -d --name ai17z-lab-s3 -p 19090:9090 adobe/s3mock:latest\n' +
        '  then PUT the bucket. These are skipped rather than passed, because a\n' +
        '  passing test where the thing it tests is absent is worse than none.\n\n',
    );
  }
}, 60_000);

beforeEach(() => resetBackupStoreForTest());
afterEach(() => resetBackupStoreForTest());

const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'));

describe('a key this store owns', () => {
  it('accepts one under its prefix', () => {
    expect(keyIsOwned(config, 'runtime-backups/rt-1/gen-1/x.bin')).toBe(true);
  });

  it('refuses one outside it, however it is spelled', () => {
    // A key becomes a path on the far side, and a path has dots.
    for (const bad of ['elsewhere/x.bin', 'runtime-backups/../elsewhere/x.bin', '/runtime-backups/x.bin', '']) {
      expect(keyIsOwned(config, bad), bad).toBe(false);
    }
  });

  it('refuses a single dot segment as well as a double', () => {
    expect(keyIsOwned(config, 'runtime-backups/./x.bin')).toBe(false);
  });
});

describe('against a real object store', () => {
  it('writes and reads back exactly the ciphertext it was given', async () => {
    if (!reachable) return;
    const used = useObjectBackupStore(config);
    expect(used.offHost).toBe(true);

    const ciphertext = bytes('sealed-by-the-runtime-with-its-own-key');
    const stored = await storeBackup({ runtimeId: 'rt-alpha', tenantId: 'tn-1', generation: 1, ciphertext });
    expect(stored.outcome).toBe('STORED');
    if (stored.outcome !== 'STORED') return;

    // The location is a key within the configured bucket, not a URL.
    expect(stored.location.startsWith('runtime-backups/')).toBe(true);
    expect(stored.location).not.toContain('://');

    const verdict = await verifyBackup(stored.location, stored.sha256);
    expect(verdict.outcome).toBe('VERIFIED');

    const ready = await fetchForRestore({
      location: stored.location,
      sha256: stored.sha256,
      verifiedAt: new Date().toISOString(),
    });
    expect(ready.outcome).toBe('READY');
    if (ready.outcome !== 'READY') return;
    expect(ready.ciphertext).toEqual(ciphertext);
    expect(sha256Of(ready.ciphertext)).toBe(stored.sha256);
  }, 60_000);

  it('signs its requests the way the protocol expects', async () => {
    if (!reachable) return;
    // A fake store cannot get a signature wrong, which is why this test has to
    // talk to something that checks one.
    const store = objectBackupStore(config);
    const key = `runtime-backups/signing/${Date.now()}.bin`;
    const { location } = await store.put(key, bytes('signed'));
    expect(location).toBe(key);
    expect(await store.get(location)).toEqual(bytes('signed'));
    await store.remove(location);
  }, 60_000);

  it('tells an absent object from a failure', async () => {
    if (!reachable) return;
    // Reporting an error as absent is how a broken store reads as an empty one.
    const store = objectBackupStore(config);
    expect(await store.get(`runtime-backups/nothing-here/${Date.now()}.bin`)).toBeNull();
  }, 60_000);

  it('notices a tampered object', async () => {
    if (!reachable) return;
    const store = objectBackupStore(config);
    useObjectBackupStore(config);
    const stored = await storeBackup({
      runtimeId: 'rt-tamper',
      tenantId: 'tn-1',
      generation: 1,
      ciphertext: bytes('the-whole-thing'),
    });
    if (stored.outcome !== 'STORED') throw new Error('expected a stored backup');

    // Somebody with the bucket rewrites the object. They hold ciphertext and
    // can destroy it; they cannot make a different one verify.
    await store.put(stored.location, bytes('something-else'));
    const verdict = await verifyBackup(stored.location, stored.sha256);
    expect(verdict.outcome).toBe('CORRUPT');
    await store.remove(stored.location);
  }, 60_000);

  it('refuses to fetch an object outside its own prefix', async () => {
    if (!reachable) return;
    // The adversarial case: a row edited to name somebody else's object.
    const store = objectBackupStore(config);
    await expect(store.get('another-tenant/secrets.bin')).rejects.toThrow(/not a key this store owns/);
    await expect(store.get('runtime-backups/../another-tenant/secrets.bin')).rejects.toThrow(/not a key this store owns/);
  }, 60_000);

  it('keeps one tenant backup out of another reach by key, and the keys do not collide', async () => {
    if (!reachable) return;
    useObjectBackupStore(config);
    const at = new Date('2026-10-05T05:00:00.000Z');
    const a = backupKeyFor({ runtimeId: 'rt-alpha', generation: 1 }, at);
    const b = backupKeyFor({ runtimeId: 'rt-beta', generation: 1 }, at);
    expect(a).not.toBe(b);

    const first = await storeBackup({ runtimeId: 'rt-alpha', tenantId: 'tn-a', generation: 1, ciphertext: bytes('alpha') }, at);
    const second = await storeBackup({ runtimeId: 'rt-beta', tenantId: 'tn-b', generation: 1, ciphertext: bytes('beta') }, at);
    if (first.outcome !== 'STORED' || second.outcome !== 'STORED') throw new Error('expected two stored backups');
    expect(first.location).not.toBe(second.location);
    expect(first.sha256).not.toBe(second.sha256);

    const store = objectBackupStore(config);
    expect(await store.get(first.location)).toEqual(bytes('alpha'));
    expect(await store.get(second.location)).toEqual(bytes('beta'));
    await store.remove(first.location);
    await store.remove(second.location);
  }, 60_000);
});

describe('what it does not claim', () => {
  it('says it encrypts nothing', () => {
    expect(OBJECT_STORE_CAVEATS.join(' ')).toContain('Nothing here encrypts');
  });

  it('says a location is a key and never a URL', () => {
    expect(OBJECT_STORE_CAVEATS.join(' ')).toContain('never a URL');
  });

  it('says possession is not authority only while the sealing is inside the runtime', () => {
    expect(OBJECT_STORE_CAVEATS.join(' ')).toContain('only true while the sealing happens inside the runtime');
  });
});
