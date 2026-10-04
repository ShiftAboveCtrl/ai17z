import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OFF_HOST,
  backupKeyFor,
  fetchForRestore,
  filesystemBackupStore,
  pathFor,
  resetBackupStoreForTest,
  sha256Of,
  storeBackup,
  useFilesystemBackupStore,
  verifyBackup,
} from '@xbam/runtime';

/**
 * A backup that was actually written, read back and restored from.
 *
 * Everything else about backups is tested against a fake store, which is
 * right: where ciphertext goes depends on the deployment. This is the one that
 * puts real bytes on a real disk, because "an unverified backup is a belief"
 * is a claim about what happens when somebody tries, and a fake cannot lose a
 * file, truncate one, or be asked for a path outside its own root.
 */

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ai17z-backup-'));
  resetBackupStoreForTest();
});

afterEach(async () => {
  resetBackupStoreForTest();
  await rm(root, { recursive: true, force: true });
});

const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'));

describe('a backup goes to disk and comes back', () => {
  it('stores ciphertext, and the record is the path it went to', async () => {
    useFilesystemBackupStore(root);
    const plan = { runtimeId: 'rt-alpha', tenantId: 'tn-1', generation: 1, ciphertext: bytes('sealed-by-the-runtime') };
    const out = await storeBackup(plan, new Date('2026-10-04T05:00:00.000Z'));

    expect(out.outcome).toBe('STORED');
    if (out.outcome !== 'STORED') return;
    expect(out.location.startsWith(resolve(root))).toBe(true);
    expect(out.sizeBytes).toBe(plan.ciphertext.byteLength);
    // The bytes on disk are the bytes handed over. Nothing here encrypts or
    // re-encodes: the runtime sealed them with its own key already.
    expect(new Uint8Array(await readFile(out.location))).toEqual(plan.ciphertext);
  });

  it('verifies what it wrote', async () => {
    useFilesystemBackupStore(root);
    const ciphertext = bytes('sealed');
    const stored = await storeBackup({ runtimeId: 'rt-alpha', tenantId: 'tn-1', generation: 1, ciphertext });
    if (stored.outcome !== 'STORED') throw new Error('expected a stored backup');

    const verdict = await verifyBackup(stored.location, stored.sha256);
    expect(verdict.outcome).toBe('VERIFIED');
  });

  it('calls a truncated copy corrupt rather than missing', async () => {
    // Two different things to tell whoever has to fix it: one is a storage or
    // a path problem, the other is a write that completed and lied.
    useFilesystemBackupStore(root);
    const stored = await storeBackup({
      runtimeId: 'rt-alpha',
      tenantId: 'tn-1',
      generation: 1,
      ciphertext: bytes('the-whole-thing'),
    });
    if (stored.outcome !== 'STORED') throw new Error('expected a stored backup');

    await writeFile(stored.location, Buffer.from('the-whole', 'utf8'));
    const verdict = await verifyBackup(stored.location, stored.sha256);
    expect(verdict.outcome).toBe('CORRUPT');
  });

  it('calls a deleted copy missing', async () => {
    useFilesystemBackupStore(root);
    const stored = await storeBackup({ runtimeId: 'rt-alpha', tenantId: 'tn-1', generation: 1, ciphertext: bytes('x') });
    if (stored.outcome !== 'STORED') throw new Error('expected a stored backup');

    await rm(stored.location);
    expect((await verifyBackup(stored.location, stored.sha256)).outcome).toBe('MISSING');
  });

  it('restores the exact bytes, and only from a copy somebody checked', async () => {
    useFilesystemBackupStore(root);
    const ciphertext = bytes('sealed-and-whole');
    const stored = await storeBackup({ runtimeId: 'rt-alpha', tenantId: 'tn-1', generation: 2, ciphertext });
    if (stored.outcome !== 'STORED') throw new Error('expected a stored backup');

    // Unverified first: restoring from a copy nobody has read back is how a
    // tenant comes back as a partial version of itself.
    const unchecked = await fetchForRestore({ location: stored.location, sha256: stored.sha256, verifiedAt: null });
    expect(unchecked.outcome).toBe('NOT_VERIFIED');

    const ready = await fetchForRestore({
      location: stored.location,
      sha256: stored.sha256,
      verifiedAt: new Date().toISOString(),
    });
    expect(ready.outcome).toBe('READY');
    if (ready.outcome !== 'READY') return;
    expect(ready.ciphertext).toEqual(ciphertext);
    expect(sha256Of(ready.ciphertext)).toBe(stored.sha256);
  });

  it('refuses an empty backup before it reaches the disk', async () => {
    // An empty file that verifies cleanly is the worst kind of backup, because
    // it inspires confidence.
    useFilesystemBackupStore(root);
    const out = await storeBackup({ runtimeId: 'rt-alpha', tenantId: 'tn-1', generation: 1, ciphertext: new Uint8Array(0) });
    expect(out.outcome).toBe('REFUSED');
  });
});

describe('a key is a path, and a path has dots', () => {
  it('refuses a key that would climb out of the root', () => {
    for (const bad of [`..${sep}escape`, join('a', '..', '..', 'escape'), '', '/absolute']) {
      expect(() => pathFor(bad, root), bad).toThrow();
    }
  });

  it('accepts the keys backupKeyFor actually produces', () => {
    const key = backupKeyFor({ runtimeId: 'rt-alpha', generation: 3 }, new Date('2026-10-04T05:00:00.000Z'));
    expect(pathFor(key, root).startsWith(resolve(root))).toBe(true);
  });

  it('refuses a stored location that has been edited to point elsewhere', async () => {
    // A row is data. A row somebody changed is not permission to read an
    // arbitrary file off the host.
    const store = filesystemBackupStore(root);
    await expect(store.get(join(root, '..', 'elsewhere.bin'))).rejects.toThrow(/outside the backup root/);
    await expect(store.remove(resolve(sep, 'etc', 'passwd'))).rejects.toThrow(/outside the backup root/);
  });
});

describe('what it does not claim', () => {
  it('is not off host, and says so where somebody reads it', () => {
    expect(OFF_HOST).toBe(false);
    const used = useFilesystemBackupStore(root);
    expect(used.offHost).toBe(false);
    expect(used.detail).toContain('A host failure takes them with it');
    expect(used.detail).toContain('not authority to read it');
  });

  it('does not register itself, so readiness is not answered by a directory existing', async () => {
    // A store that registered on import would make backupReadiness say a
    // hosted runtime is recoverable because a folder is there.
    const { backupReadiness } = await import('@xbam/runtime');
    expect(backupReadiness().ready).toBe(false);
    useFilesystemBackupStore(root);
    expect(backupReadiness().ready).toBe(true);
  });
});
