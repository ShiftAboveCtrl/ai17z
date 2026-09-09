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
 */
function tree(files: Record<string, string>): InstallLookup {
  const normalise = (p: string) => p.replace(/\//g, '\\').toLowerCase();
  const map = new Map(Object.entries(files).map(([k, v]) => [normalise(k), v]));
  return {
    exists: (p) => map.has(normalise(p)),
    read: (p) => map.get(normalise(p)) ?? '',
  };
}

const A_PROGRAM = 'C:\\Programs\\AI17Z-test';
const A_DATA = 'C:\\Data\\AI17Z-test';
const B_PROGRAM = 'C:\\Programs\\AI17Z-main';
const B_DATA = 'C:\\Data\\AI17Z-main';
const CHECKOUT = 'C:\\Users\\dev\\XBAM';

const machine = tree({
  [`${A_PROGRAM}\\data-location.txt`]: `${A_DATA}\r\n`,
  [`${A_DATA}\\.env`]: 'DATABASE_URL=postgres://a\n',
  [`${B_PROGRAM}\\data-location.txt`]: B_DATA,
  [`${B_DATA}\\.env`]: 'DATABASE_URL=postgres://b\n',
  [`${CHECKOUT}\\.env`]: 'DATABASE_URL=postgres://dev\n',
});

describe('an installed copy finds its own environment file', () => {
  it('finds it from the entry script inside the program directory', () => {
    // The ordinary case: a worker at <program>\apps\worker\src\main.ts.
    const found = installedEnvFile([`${A_PROGRAM}\\apps\\worker\\src`], machine);
    expect(found).toBe(`${A_DATA}\\.env`);
  });

  it('finds it from the program directory itself', () => {
    expect(installedEnvFile([A_PROGRAM], machine)).toBe(`${A_DATA}\\.env`);
  });

  it('is not affected by where the process was started', () => {
    // The whole point. The anchors are files the process is made of; the shell's
    // directory is not one of them and is never consulted here.
    expect(installedEnvFile([`${A_PROGRAM}\\packages\\shared\\src`], machine)).toBe(`${A_DATA}\\.env`);
  });

  it('never resolves the other installation', () => {
    expect(installedEnvFile([`${A_PROGRAM}\\apps\\api\\src`], machine)).not.toBe(`${B_DATA}\\.env`);
    expect(installedEnvFile([`${B_PROGRAM}\\apps\\api\\src`], machine)).toBe(`${B_DATA}\\.env`);
  });

  it('finds nothing in a development checkout, which keeps the cwd walk', () => {
    // A developer running tsx from anywhere in the tree must keep working
    // exactly as before, so this returns null and loadEnv falls through.
    expect(installedEnvFile([`${CHECKOUT}\\apps\\worker\\src`], machine)).toBeNull();
  });

  it('treats an empty pointer as a broken installation rather than a hint', () => {
    // Returning null on an empty pointer would send the caller back to the cwd
    // walk, which is the bug. An installation with a blank pointer is broken
    // and says nothing about which .env to use.
    const broken = tree({
      [`${A_PROGRAM}\\data-location.txt`]: '\n',
      [`${CHECKOUT}\\.env`]: 'DATABASE_URL=postgres://dev\n',
    });
    expect(installedEnvFile([A_PROGRAM], broken)).toBeNull();
    expect(findDataLocation([A_PROGRAM], broken)).toBeNull();
  });

  it('resolves a relative pointer against the program, not the process', () => {
    // The same class of bug one level down: a relative path in an installed
    // copy otherwise resolves wherever the process happens to be standing.
    const relative = tree({
      [`${A_PROGRAM}\\data-location.txt`]: 'data',
      [`${A_PROGRAM}\\data\\.env`]: 'DATABASE_URL=postgres://rel\n',
    });
    expect(installedEnvFile([`${A_PROGRAM}\\apps`], relative)).toBe(`${A_PROGRAM}\\data\\.env`);
  });

  it('says nothing when the pointer names an environment file that is gone', () => {
    const missing = tree({ [`${A_PROGRAM}\\data-location.txt`]: A_DATA });
    expect(installedEnvFile([A_PROGRAM], missing)).toBeNull();
  });

  it('tries every anchor before giving up', () => {
    // The entry script can be somewhere unexpected -- a shortcut, a script run
    // by name -- so this module's own path is the second anchor.
    const found = installedEnvFile(['C:\\Windows\\System32', `${A_PROGRAM}\\node_modules\\@xbam\\shared\\src`], machine);
    expect(found).toBe(`${A_DATA}\\.env`);
  });
});
