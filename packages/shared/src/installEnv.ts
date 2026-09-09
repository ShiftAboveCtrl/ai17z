import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Which installation is this process part of, and where does its data live?
 *
 * An installed AI17Z keeps its environment file with the owner's data, and
 * `data-location.txt` beside the program is the pointer to it. Every shipped
 * PowerShell script already follows that pointer. Node did not: `loadEnv` fell
 * back to walking up from the current working directory, so an installed
 * worker started from a directory inside a *different* AI17Z found that one's
 * `.env` instead of its own.
 *
 * That is not hypothetical. Launching an installed copy's start script from a
 * shell sitting in a development checkout gave the installed worker the
 * checkout's database and a browser profile under the checkout's `storage`,
 * while it wrote its log into the installation's own folder. Two installations
 * are supposed to be two installations, and cwd is not part of an
 * installation's identity.
 *
 * So the search is anchored to files this process is *made of* rather than to
 * where somebody happened to launch it: the entry script, and this module's own
 * location, which for an installed copy is inside the program directory through
 * the workspace link. Neither moves when a shell does.
 *
 * A development checkout has no `data-location.txt`, so this finds nothing and
 * the existing convenience -- walk up from cwd, find the repository's `.env` --
 * is untouched. That is deliberate: a developer running `tsx apps/api/src/main.ts`
 * from anywhere in the tree should keep working exactly as before.
 */
export const DATA_LOCATION_FILE = 'data-location.txt';

export interface InstallLookup {
  exists(path: string): boolean;
  read(path: string): string;
}

/**
 * Walks up from each starting point looking for the pointer.
 *
 * Eight levels, matching the cwd walk it sits beside. An installed copy's
 * program directory is one or two levels above any file this is called with;
 * anything deeper is a directory layout nobody has.
 */
export function findDataLocation(startDirs: string[], fs: InstallLookup): string | null {
  for (const start of startDirs) {
    if (!start) continue;
    let dir = resolve(start);
    for (let i = 0; i < 8; i += 1) {
      const pointer = join(dir, DATA_LOCATION_FILE);
      if (fs.exists(pointer)) {
        const first = fs.read(pointer).split(/\r?\n/)[0]?.trim() ?? '';
        // A pointer with nothing in it is a broken installation rather than a
        // signal to look elsewhere: answering null here would send the caller
        // back to the cwd walk, which is the bug this exists to prevent.
        return first || null;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/**
 * The environment file this installation owns, or null in a development tree.
 *
 * Relative pointers are resolved against the program directory that holds the
 * pointer, because a relative path in an installed copy resolves wherever the
 * process happens to be standing -- the same class of bug one level down.
 */
export function installedEnvFile(startDirs: string[], fs: InstallLookup): string | null {
  for (const start of startDirs) {
    if (!start) continue;
    let dir = resolve(start);
    for (let i = 0; i < 8; i += 1) {
      const pointer = join(dir, DATA_LOCATION_FILE);
      if (fs.exists(pointer)) {
        const first = fs.read(pointer).split(/\r?\n/)[0]?.trim() ?? '';
        if (!first) return null;
        const dataDir = isAbsolute(first) ? first : resolve(dir, first);
        const envFile = join(dataDir, '.env');
        return fs.exists(envFile) ? envFile : null;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}
