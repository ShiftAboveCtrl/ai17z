import { afterEach, describe, expect, it } from 'vitest';
import {
  RESTORE_CAVEATS,
  backupKeyFor,
  backupReadiness,
  fetchForRestore,
  mayRecoverElsewhere,
  registerBackupStore,
  resetBackupStoreForTest,
  sha256Of,
  storeBackup,
  verifyBackup,
  type BackupStore,
} from '@xbam/runtime';

/**
 * Whether a hosted agent survives the machine holding it.
 *
 * The store is a fake, because where ciphertext goes depends on the
 * deployment. What is being proved is the discipline around it: an empty
 * backup is refused, a corrupt one is told apart from a missing one, and a
 * restore from a copy nobody read back is refused outright.
 */

afterEach(() => resetBackupStoreForTest());

/** A store whose behaviour a test chooses, holding bytes in memory. */
function fakeStore(options: { putFails?: boolean; getFails?: boolean; corrupt?: boolean; absent?: boolean } = {}): BackupStore {
  const held = new Map<string, Uint8Array>();
  return {
    id: 'fake-store',
    async put(key, bytes) {
      if (options.putFails) throw new Error('the bucket said no');
      held.set(key, bytes);
      return { location: `fake://${key}` };
    },
    async get(location) {
      if (options.getFails) throw new Error('the bucket is unreachable');
      if (options.absent) return null;
      const key = location.replace('fake://', '');
      const bytes = held.get(key) ?? null;
      if (bytes && options.corrupt) return new Uint8Array([...bytes, 0]);
      return bytes;
    },
    async remove(location) {
      held.delete(location.replace('fake://', ''));
    },
  };
}

const plan = (over: Partial<Parameters<typeof storeBackup>[0]> = {}) => ({
  runtimeId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  generation: 1,
  ciphertext: new TextEncoder().encode('pretend this is sealed tenant state'),
  ...over,
});

describe('a backup needs somewhere to go', () => {
  it('says so rather than silently succeeding when nothing is configured', async () => {
    expect(backupReadiness().ready).toBe(false);
    const out = await storeBackup(plan());
    expect(out.outcome).toBe('NO_STORE');
  });

  it('reports where backups go once there is a store', () => {
    registerBackupStore(fakeStore());
    expect(backupReadiness().ready).toBe(true);
    expect(backupReadiness().detail).toContain('fake-store');
  });
});

describe('storing one', () => {
  it('records the digest of the ciphertext and its size', async () => {
    registerBackupStore(fakeStore());
    const p = plan();
    const out = await storeBackup(p);
    expect(out.outcome).toBe('STORED');
    if (out.outcome !== 'STORED') return;
    expect(out.sha256).toBe(sha256Of(p.ciphertext));
    expect(out.sizeBytes).toBe(p.ciphertext.byteLength);
  });

  it('refuses an empty backup', async () => {
    // An empty file verifies cleanly and restores nothing, which is the worst
    // kind of backup because it inspires confidence.
    registerBackupStore(fakeStore());
    const out = await storeBackup(plan({ ciphertext: new Uint8Array() }));
    expect(out.outcome).toBe('REFUSED');
    if (out.outcome !== 'REFUSED') return;
    expect(out.detail).toContain('verify cleanly');
  });

  it('reports a failed write rather than claiming success', async () => {
    registerBackupStore(fakeStore({ putFails: true }));
    const out = await storeBackup(plan());
    expect(out.outcome).toBe('FAILED');
    if (out.outcome !== 'FAILED') return;
    expect(out.detail).toContain('bucket said no');
  });

  it('keys a backup so a listing sorts by runtime and generation', () => {
    const key = backupKeyFor({ runtimeId: 'r-1', generation: 3 }, new Date('2026-10-04T12:00:00.000Z'));
    expect(key.startsWith('r-1/gen-3/')).toBe(true);
    // No colons: they are illegal or awkward in several stores and on Windows.
    expect(key).not.toContain(':');
  });
});

describe('reading one back is what makes it a backup', () => {
  it('verifies a copy that is what was written', async () => {
    registerBackupStore(fakeStore());
    const p = plan();
    const stored = await storeBackup(p);
    if (stored.outcome !== 'STORED') throw new Error('setup failed');
    const out = await verifyBackup(stored.location, stored.sha256);
    expect(out.outcome).toBe('VERIFIED');
  });

  it('tells a missing copy from a corrupt one', async () => {
    // They mean different things to whoever fixes it: one is a path or storage
    // problem, the other is a write that completed and lied.
    registerBackupStore(fakeStore({ absent: true }));
    expect((await verifyBackup('fake://nothing/here.bin', 'a'.repeat(64))).outcome).toBe('MISSING');

    resetBackupStoreForTest();
    registerBackupStore(fakeStore({ corrupt: true }));
    const p = plan();
    const stored = await storeBackup(p);
    if (stored.outcome !== 'STORED') throw new Error('setup failed');
    const out = await verifyBackup(stored.location, stored.sha256);
    expect(out.outcome).toBe('CORRUPT');
    if (out.outcome !== 'CORRUPT') return;
    // And it says both digests, so the mismatch is checkable.
    expect(out.detail).toContain(stored.sha256.slice(0, 12));
  });

  it('reports a store that could not be read at all', async () => {
    registerBackupStore(fakeStore({ getFails: true }));
    const out = await verifyBackup('fake://x', 'b'.repeat(64));
    expect(out.outcome).toBe('FAILED');
  });
});

describe('restoring', () => {
  it('refuses a backup nobody has ever read back', async () => {
    // Restoring from an unverified copy is how a tenant returns as a partial
    // version of itself and then acts on a world it half remembers.
    registerBackupStore(fakeStore());
    const stored = await storeBackup(plan());
    if (stored.outcome !== 'STORED') throw new Error('setup failed');
    const out = await fetchForRestore({ location: stored.location, sha256: stored.sha256, verifiedAt: null });
    expect(out.outcome).toBe('NOT_VERIFIED');
    if (out.outcome !== 'NOT_VERIFIED') return;
    expect(out.detail).toContain('Verify it first');
  });

  it('re-checks even a previously verified copy before handing it over', async () => {
    // Verified once is not verified now: the bytes could have rotted since.
    registerBackupStore(fakeStore({ corrupt: true }));
    const stored = await storeBackup(plan());
    if (stored.outcome !== 'STORED') throw new Error('setup failed');
    const out = await fetchForRestore({
      location: stored.location,
      sha256: stored.sha256,
      verifiedAt: new Date().toISOString(),
    });
    expect(out.outcome).toBe('CORRUPT');
  });

  it('hands back ciphertext and never plaintext', async () => {
    // Decryption needs the runtime's own key, so a control plane holding every
    // backup holds nothing it can read.
    registerBackupStore(fakeStore());
    const p = plan();
    const stored = await storeBackup(p);
    if (stored.outcome !== 'STORED') throw new Error('setup failed');
    const out = await fetchForRestore({
      location: stored.location,
      sha256: stored.sha256,
      verifiedAt: new Date().toISOString(),
    });
    expect(out.outcome).toBe('READY');
    if (out.outcome !== 'READY') return;
    expect(out.ciphertext).toEqual(p.ciphertext);
  });
});

describe('starting a tenant on new hardware', () => {
  it('refuses while the old runtime might still be running', () => {
    // Two agents acting as one is worse than being down, for anything that
    // posts or trades.
    for (const state of ['ACTIVE', 'GRACE', 'READY', 'PROVISIONING']) {
      const out = mayRecoverElsewhere({ oldRuntimeState: state, hasVerifiedBackup: true });
      expect(out.ok, state).toBe(false);
      if (out.ok) continue;
      expect(out.why).toContain('two agents');
    }
  });

  it('refuses without a verified backup, even once the old one is gone', () => {
    const out = mayRecoverElsewhere({ oldRuntimeState: 'HOST_UNREACHABLE', hasVerifiedBackup: false });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.why).toContain('partial agent');
  });

  it('allows it once both halves are true', () => {
    for (const state of ['HOST_UNREACHABLE', 'FAILED', 'RETAINED', 'SUSPENDED']) {
      expect(mayRecoverElsewhere({ oldRuntimeState: state, hasVerifiedBackup: true }).ok, state).toBe(true);
    }
  });
});

describe('what a restore does not bring back', () => {
  it('says a browser session may need signing in again', () => {
    // AI17Z already knows profile seeding does not carry a login on Windows
    // because of App-Bound Encryption, so claiming the session travels would
    // be claiming something measured to be false.
    const all = RESTORE_CAVEATS.join(' ').toLowerCase();
    expect(all).toContain('browser session');
    expect(all).toContain('signing in again');
    // And is clear about what does travel.
    expect(all).toContain('memories');
    expect(all).toContain('reconciled rather than repeated');
  });
});
