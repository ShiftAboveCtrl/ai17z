import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The names three files have to agree on, or an install fails on a stranger's
 * machine and nowhere else.
 *
 * The release workflow decides what a release contains. `install.ps1` decides
 * what it goes looking for. `Setup-AI17Z.ps1` decides what it then downloads.
 * Nothing connects those three except somebody typing the same string into all
 * of them, and the failure is invisible here: every test passes, the build
 * succeeds, the release publishes, and the first person to paste the command
 * is told the release does not contain a file that is sitting right there
 * under a slightly different name.
 *
 * That already happened once in the other direction -- a release that carried
 * no setup script at all, and a command that correctly refused it -- which is
 * what this exists to stop happening again by accident.
 */

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const install = read('install.ps1');
const setup = read('packaging/windows/Setup-AI17Z.ps1');
const workflow = read('.github/workflows/release.yml');

/** A concrete version, so patterns and workflow expressions can be compared as strings. */
const VERSION = '9.9.9-beta.1';

/** `Install-AI17Z-{0}.ps1` with the version in it. */
function fromPattern(source: string, declaration: RegExp): string {
  const pattern = declaration.exec(source)?.[1];
  expect(pattern, `no asset pattern matched ${declaration}`).toBeTruthy();
  return pattern!.replace('{0}', VERSION);
}

/** What the workflow publishes, with its version expression resolved. */
function published(source: string): string[] {
  const list = source.slice(source.lastIndexOf('files: |'));
  const end = list.indexOf('\n\n');
  return [...(end > 0 ? list.slice(0, end) : list).matchAll(/^\s+dist\/(\S+)$/gm)].map((m) => m[1] ?? '');
}

describe('the release publishes exactly what the installer goes looking for', () => {
  it('agrees on the setup script name', () => {
    const wanted = fromPattern(install, /\$SetupAssetPattern = '([^']+)'/);
    expect(wanted).toBe(`Install-AI17Z-${VERSION}.ps1`);

    // The workflow writes it under a name built from its own version output.
    expect(workflow).toContain('Install-AI17Z-$version.ps1');
    expect(published(workflow)).toContain('Install-AI17Z-*.ps1');

    // And the glob the release attaches actually matches the name asked for.
    expect(wanted).toMatch(/^Install-AI17Z-.+\.ps1$/);
  });

  it('agrees on the application package name', () => {
    const wanted = fromPattern(setup, /Package\s*=\s*'([^']+)'/);
    expect(wanted).toBe(`AI17Z-App-${VERSION}.zip`);
    expect(workflow).toContain('AI17Z-App-${{ steps.version.outputs.version }}.zip');
    expect(published(workflow)).toContain('AI17Z-App-*.zip');
  });

  it('agrees on the checksum file name, in all three', () => {
    const fromInstall = /\$ChecksumAsset = '([^']+)'/.exec(install)?.[1];
    const fromSetup = /Checksums\s*=\s*'([^']+)'/.exec(setup)?.[1];
    expect(fromInstall).toBe('SHA256SUMS.txt');
    expect(fromSetup).toBe('SHA256SUMS.txt');
    expect(published(workflow)).toContain('SHA256SUMS.txt');
  });

  it('hashes every asset the install path has to verify', () => {
    // Publishing an asset without a line in SHA256SUMS.txt is the same failure
    // as not publishing it: both scripts refuse what they cannot check, so the
    // release would be attached, complete, and uninstallable.
    const checksums = workflow.slice(workflow.indexOf('- name: Checksums'), workflow.indexOf('- name: Release notes'));
    for (const needed of ['Install-AI17Z-*.ps1', 'AI17Z-App-*.zip']) {
      expect(checksums, `${needed} is published without a hash`).toContain(needed);
    }
  });

  it('publishes every asset it hashes', () => {
    // The other direction. A hash for something that is not attached is a line
    // nobody can use, and it is how a rename gets halfway done.
    const checksums = workflow.slice(workflow.indexOf('- name: Checksums'), workflow.indexOf('- name: Release notes'));
    const hashed = [...checksums.matchAll(/(?:^|\s)([A-Za-z0-9][\w.-]*\*[\w.-]*|install\.ps1)(?=\s)/g)]
      .map((m) => m[1] ?? '')
      .filter((name) => name !== 'tee');
    const attached = published(workflow);
    for (const name of new Set(hashed)) {
      expect(attached, `${name} is hashed but never attached to the release`).toContain(name);
    }
  });

  it('names the stage-zero file the command actually fetches', () => {
    // `install.ps1` is published so somebody can pin or compare it, and the
    // README command points at the copy on `main`. Both are the same file, and
    // the release is where its hash comes from.
    expect(published(workflow)).toContain('install.ps1');
    expect(workflow).toContain('raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/install.ps1');
  });
});
