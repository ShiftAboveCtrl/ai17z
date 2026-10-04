import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { envString } from '@xbam/shared';
import { registerBackupStore, type BackupStore } from './runtimeBackup';

/**
 * A backup store on a filesystem, so backups are something that happened
 * rather than something designed.
 *
 * `runtimeBackup.ts` is deliberately a contract with no implementation: where
 * ciphertext goes depends on the deployment, and a default that silently wrote
 * somewhere would be worse than none. This is the simplest real one, and it
 * exists so the discipline around a backup, storing it, reading it back,
 * comparing a hash, refusing to restore from one nobody checked, is exercised
 * against real bytes on a real disk rather than against a fake.
 *
 * **It is not off-host, and that is the whole caveat.** A host failure takes
 * this disk with it, so for hosted tenants it is a step towards a backup
 * rather than one. `OFF_HOST` is false and the readiness line says so, because
 * a backup on the machine it is protecting is the kind of thing that reads as
 * solved on a status screen and is not.
 *
 * The ciphertext arriving here was encrypted by the runtime with its own key.
 * Nothing in this file decrypts anything and there is no key parameter to
 * accidentally log: possession of a backup is not authority to read it.
 */

export const OFF_HOST = false;

/**
 * Where backups go by default.
 *
 * Under the storage directory rather than beside the program, because the
 * program directory is replaced on every upgrade and emptied by the
 * uninstaller, and a backup that an upgrade deletes is not a backup. This is
 * the same rule the browser profiles already follow.
 */
export function backupRoot(): string {
  const configured = envString('AI17Z_BACKUP_DIR', '').trim();
  if (configured) return resolve(configured);
  return resolve(envString('AI17Z_STORAGE_DIR', './storage'), 'backups');
}

/**
 * Turns a key into a path under the root, refusing one that would escape.
 *
 * A key is composed by `backupKeyFor`, which already validates the runtime id,
 * and this is the second check at the place it matters: a format with nowhere
 * to put a `..` is what the agent package chose on purpose, and a filesystem
 * store is exactly where forgetting that costs something.
 */
export function pathFor(key: string, root = backupRoot()): string {
  if (!key || isAbsolute(key) || key.includes('\0')) {
    throw new Error(`${key || '(empty)'} is not a usable backup key.`);
  }
  const target = resolve(root, key);
  const inside = relative(root, target);
  if (inside.startsWith('..') || isAbsolute(inside) || inside.split(sep).includes('..')) {
    throw new Error(`${key} would be written outside the backup root.`);
  }
  return target;
}

/**
 * A store rooted at one directory.
 *
 * `location` is the absolute path, which is what the record keeps, and `get`
 * re-checks that the location is still inside the root: a row is data, and a
 * row that has been edited is not permission to read an arbitrary file.
 */
export function filesystemBackupStore(root = backupRoot()): BackupStore {
  const base = resolve(root);

  const within = (location: string): string => {
    const target = resolve(location);
    const inside = relative(base, target);
    if (!location || inside.startsWith('..') || isAbsolute(inside) || inside.split(sep).includes('..')) {
      throw new Error('That backup location is outside the backup root.');
    }
    return target;
  };

  return {
    id: `filesystem:${base}`,

    async put(key, bytes) {
      const target = pathFor(key, base);
      await mkdir(dirname(target), { recursive: true });
      // Written whole. A partial file that hashes to nothing is caught by
      // verification, but a partial file nobody verified is the worst case,
      // so the write is one call rather than a stream nobody is watching.
      await writeFile(target, bytes);
      return { location: target };
    },

    async get(location) {
      try {
        const bytes = await readFile(within(location));
        return new Uint8Array(bytes);
      } catch (error) {
        // Not there is an answer; anything else is a failure worth seeing.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },

    async remove(location) {
      await rm(within(location), { force: true });
    },
  };
}

/**
 * Registers it, and says plainly what it is and is not.
 *
 * Deliberately not called on import. A store that registered itself would make
 * `backupReadiness` say a hosted runtime is recoverable on the strength of a
 * directory on the machine that is holding it.
 */
export function useFilesystemBackupStore(root = backupRoot()): { id: string; offHost: boolean; detail: string } {
  const store = filesystemBackupStore(root);
  registerBackupStore(store);
  return {
    id: store.id,
    offHost: OFF_HOST,
    detail:
      'Backups are written to this machine. A host failure takes them with it, so for a hosted tenant this is a step towards a backup rather than one. The ciphertext is sealed with the runtime own key, so holding it is not authority to read it.',
  };
}

/** Where a key would land, for a status screen that wants to say so. */
export function describeBackupRoot(): string {
  return `${backupRoot()}${join(sep, '<runtime>', 'gen-<n>', '<when>.bin')}`;
}
