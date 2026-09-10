import { isAbsolute, join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findDataLocation, installedEnvFile, type InstallLookup } from '@xbam/shared';

/**
 * An installed AI17Z resolves its own configuration, whatever directory it was
 * started from.
 *
 * The bug, observed rather than imagined: an installed copy's start script run
 * from a shell sitting in a development checkout gave the installed worker the
 * *checkout's* `.env`. It connected to the development database and opened
 * Chrome on a browser profile under the checkout's `storage`, while writing its
 * log into the installation's own folder -- so every symptom pointed at the
 * installation and every cause was somewhere else.
 *
 * `loadEnv` fell back to walking up from `process.cwd()`, and cwd is not part
 * of an installation's identity. `data-location.txt` beside the program is,
 * and every shipped PowerShell script already followed it. Now node does too.
 *
 * ### Why every path here is built rather than written
 *
 * This test used to spell its fixtures out as `C:\Programs\AI17Z-test`, which
 * is what the layout actually looks like -- AI17Z installs on Windows. But the
 * code under test uses `node:path`, and `node:path` is the *running* platform's
 * path module. On Linux `C:\Programs\AI17Z-test` is one relative segment with
 * backslashes in its name: `resolve` prepends the working directory, `dirname`
 * walks straight past it, and `isAbsolute` says false. Every assertion here
 * failed on CI and passed on the machine it was written on, which is the worst
 * shape a test can have -- it went unnoticed for nine commits and took the
 * release build down with it.
 *
 * So the shape is written and the separators are not. On Windows these read as
 * `C:\Programs\AI17Z-test`, on Linux as `/Programs/AI17Z-test`, and the
 * behaviour under test -- follow the pointer, resolve it against the program,
 * never cross into the other installation -- is the same claim either way.
 */
function tree(files: Record<string, string>): InstallLookup {
  // Case-insensitively, because the platform this describes is. The fixtures
  // and the lookups come from the same constants, so this only ever forgives
  // the difference Windows itself forgives.
  const normalise = (p: string) => p.toLowerCase();
  const map = new Map(Object.entries(files).map(([k, v]) => [normalise(k), v]));
  return {
    exists: (p) => map.has(normalise(p)),
    read: (p) => map.get(normalise(p)) ?? '',
  };
}

/** The root of the imaginary machine, in whatever this platform calls one. */
const ROOT = process.platform === 'win32' ? 'C:\\' : sep;

const A_PROGRAM = join(ROOT, 'Programs', 'AI17Z-test');
const A_DATA = join(ROOT, 'Data', 'AI17Z-test');
const B_PROGRAM = join(ROOT, 'Programs', 'AI17Z-main');
const B_DATA = join(ROOT, 'Data', 'AI17Z-main');
const CHECKOUT = join(ROOT, 'Users', 'dev', 'XBAM');

const machine = tree({
  // The trailing newline is deliberate: PowerShell writes one, and the pointer
  // is read a line at a time because of it.
  [join(A_PROGRAM, 'data-location.txt')]: `${A_DATA}\r\n`,
  [join(A_DATA, '.env')]: 'DATABASE_URL=postgres://a\n',
  [join(B_PROGRAM, 'data-location.txt')]: B_DATA,
  [join(B_DATA, '.env')]: 'DATABASE_URL=postgres://b\n',
  [join(CHECKOUT, '.env')]: 'DATABASE_URL=postgres://dev\n',
});

describe('an installed copy finds its own environment file', () => {
  it('builds every fixture as a path the running platform calls absolute', () => {
    // The guard for the mistake above. `C:\Programs\AI17Z-test` is absolute on
    // Windows and one relative segment with backslashes in its name on Linux,
    // and the difference is invisible from either side alone. If somebody
    // writes a literal path back in, this fails on CI with a sentence rather
    // than with eight assertions that each look like a logic error.
    for (const path of [A_PROGRAM, A_DATA, B_PROGRAM, B_DATA, CHECKOUT]) {
      expect(isAbsolute(path), path).toBe(true);
    }
  });

  it('finds it from the entry script inside the program directory', () => {
    // The ordinary case: a worker at <program>/apps/worker/src/main.ts.
    const found = installedEnvFile([join(A_PROGRAM, 'apps', 'worker', 'src')], machine);
    expect(found).toBe(join(A_DATA, '.env'));
  });

  it('finds it from the program directory itself', () => {
    expect(installedEnvFile([A_PROGRAM], machine)).toBe(join(A_DATA, '.env'));
  });

  it('is not affected by where the process was started', () => {
    // The whole point. The anchors are files the process is made of; the shell's
    // directory is not one of them and is never consulted here.
    expect(installedEnvFile([join(A_PROGRAM, 'packages', 'shared', 'src')], machine)).toBe(join(A_DATA, '.env'));
  });

  it('never resolves the other installation', () => {
    expect(installedEnvFile([join(A_PROGRAM, 'apps', 'api', 'src')], machine)).not.toBe(join(B_DATA, '.env'));
    expect(installedEnvFile([join(B_PROGRAM, 'apps', 'api', 'src')], machine)).toBe(join(B_DATA, '.env'));
  });

  it('finds nothing in a development checkout, which keeps the cwd walk', () => {
    // A developer running tsx from anywhere in the tree must keep working
    // exactly as before, so this returns null and loadEnv falls through.
    expect(installedEnvFile([join(CHECKOUT, 'apps', 'worker', 'src')], machine)).toBeNull();
  });

  it('treats an empty pointer as a broken installation rather than a hint', () => {
    // Returning null on an empty pointer would send the caller back to the cwd
    // walk, which is the bug. An installation with a blank pointer is broken
    // and says nothing about which .env to use.
    const broken = tree({
      [join(A_PROGRAM, 'data-location.txt')]: '\n',
      [join(CHECKOUT, '.env')]: 'DATABASE_URL=postgres://dev\n',
    });
    expect(installedEnvFile([A_PROGRAM], broken)).toBeNull();
    expect(findDataLocation([A_PROGRAM], broken)).toBeNull();
  });

  it('resolves a relative pointer against the program, not the process', () => {
    // The same class of bug one level down: a relative path in an installed
    // copy otherwise resolves wherever the process happens to be standing.
    const relative = tree({
      [join(A_PROGRAM, 'data-location.txt')]: 'data',
      [join(A_PROGRAM, 'data', '.env')]: 'DATABASE_URL=postgres://rel\n',
    });
    expect(installedEnvFile([join(A_PROGRAM, 'apps')], relative)).toBe(join(A_PROGRAM, 'data', '.env'));
  });

  it('says nothing when the pointer names an environment file that is gone', () => {
    const missing = tree({ [join(A_PROGRAM, 'data-location.txt')]: A_DATA });
    expect(installedEnvFile([A_PROGRAM], missing)).toBeNull();
  });

  it('tries every anchor before giving up', () => {
    // The entry script can be somewhere unexpected -- a shortcut, a script run
    // by name -- so this module's own path is the second anchor.
    const found = installedEnvFile(
      [join(ROOT, 'Windows', 'System32'), join(A_PROGRAM, 'node_modules', '@xbam', 'shared', 'src')],
      machine,
    );
    expect(found).toBe(join(A_DATA, '.env'));
  });

  it('reads the first line of the pointer, whatever wrote it', () => {
    // PowerShell writes CRLF. Taking the whole file would put a carriage return
    // inside the directory name, and the .env beside it would never be found.
    expect(findDataLocation([A_PROGRAM], machine)).toBe(A_DATA);
  });
});
