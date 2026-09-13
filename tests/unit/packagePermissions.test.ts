import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A binary is executable because it is a binary.
 *
 * Both Unix build scripts set every mode from what each file is, because a
 * build host cannot be trusted for it: everything on a Windows filesystem reads
 * as executable, so a package built from a mounted checkout ships an executable
 * LICENSE and an executable PNG.
 *
 * The half that was missing cost a package where nothing could run. The rule
 * was "give anything with a `#!` line the executable bit", implemented with
 * `grep -I` -- which skips binary files *by design*. So every compiled
 * executable stayed at 0644, including
 * `node_modules/@esbuild/<platform>/bin/esbuild`, which is what every `tsx`
 * process an installed copy runs shells out to. The package installed, and the
 * migration on first start died with EACCES on a file that was right there.
 *
 * macOS had it worse: four `find` lines, no shebang rule at all.
 *
 * Found by installing a real package in a real container and running it. No
 * file listing shows this, because the file is present and correct -- only its
 * mode says otherwise.
 */

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const shared = read('packaging/unix/pack-permissions.sh');
const builds = {
  ubuntu: read('packaging/ubuntu/build-deb.sh'),
  macos: read('packaging/macos/build-tarball.sh'),
};

describe('what a file in a package is allowed to do', () => {
  it('is decided in one place', () => {
    for (const [name, script] of Object.entries(builds)) {
      expect(script, `${name} does not source the shared rule`).toContain('pack-permissions.sh');
      expect(script, `${name} does not use it`).toContain('ai17z_fix_permissions');
    }
  });

  it('neither build kept its own copy of the rule', () => {
    // Two implementations is how one of them ends up without the half that
    // matters, which is exactly what happened.
    for (const [name, script] of Object.entries(builds)) {
      const chmods = [...script.matchAll(/find [^\n]*-exec chmod/g)];
      expect(chmods.length, `${name} still normalises modes itself: ${chmods.map((m) => m[0]).join(' | ')}`).toBe(0);
    }
  });

  it('restores the executable bit to compiled programs, not only to scripts', () => {
    expect(shared).toContain('ai17z_is_native_executable');
    // By magic bytes rather than by `file`, which is not installed everywhere a
    // build runs, and not by extension, which native binaries do not have.
    expect(shared).toContain('od -An -tx1 -N4');
    expect(shared).toMatch(/7f454c46/); // ELF
    expect(shared).toMatch(/cffaedfe|feedfacf/); // Mach-O
    expect(shared).toMatch(/cafebabe/); // a universal binary
  });

  it('still handles the shebang case, and still exempts data', () => {
    expect(shared).toMatch(/grep -rlI[^\n]*'\^#!'/);
    // Fonts and images start with bytes that are not a shebang, but a `.json`
    // or an `.md` that begins with one is still data.
    expect(shared).toMatch(/-name '\*\.md'/);
    expect(shared).toMatch(/-name '\*\.json'/);
  });

  it('both builds check before they seal the package', () => {
    // A guard that lists files cannot catch a mode. This runs over the finished
    // tree and refuses to produce a package containing a program that cannot be
    // run -- the same reasoning as the TypeScript transform the packagers run.
    expect(shared).toContain('ai17z_assert_executables_runnable');
    for (const [name, script] of Object.entries(builds)) {
      expect(script, `${name} does not assert its executables can run`).toContain(
        'ai17z_assert_executables_runnable',
      );
    }
  });

  it('counts in the shell that will read the count', () => {
    // A `while` on the right of a pipe runs in a subshell, and a count
    // incremented there is a count the caller never sees -- which is the shape
    // of a check that always passes.
    const fn = shared.slice(shared.indexOf('ai17z_assert_executables_runnable()'));
    expect(fn).toContain('done < <(find');
    expect(fn).not.toMatch(/find[^\n]*\|\s*while/);
  });
});
