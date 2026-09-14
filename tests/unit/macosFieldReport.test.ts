import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareVersions, updateMethodFrom } from '@xbam/runtime';

/**
 * What installing Beta 1.0.0 (19) on a real Mac found.
 *
 * Nine faults, and the ones below are the parts a machine here can hold. The
 * root cause has its own file (`profileDirIsLocal.test.ts`); these are the rest.
 *
 * Every one of them shares a shape worth naming: a platform was added and
 * something that already existed for Windows was not extended to it. The
 * updater's method list, the image rebuild, the Chrome paths, the version
 * comparison. None of them failed loudly; each produced a confident wrong
 * answer.
 */

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
/** Lines that run, so a comment explaining a fault is not mistaken for it. */
const ran = (text: string) =>
  text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

describe('the Version panel speaks to the platform it is on', () => {
  it('knows the two platforms added after Windows', () => {
    // It returned CHECKOUT for a Mac, and the panel's CHECKOUT copy says to run
    // `.\update-ai17z.ps1` -- a PowerShell script, on a Mac.
    expect(updateMethodFrom({ AI17Z_INSTALL_CHANNEL: 'MACOS_PKG' }, true)).toBe('MACOS_PKG');
    expect(updateMethodFrom({ AI17Z_INSTALL_CHANNEL: 'UBUNTU_DEB' }, true)).toBe('UBUNTU_DEB');
    expect(updateMethodFrom({ AI17Z_INSTALL_CHANNEL: 'BOOTSTRAP' }, true)).toBe('BOOTSTRAP');
    expect(updateMethodFrom({ AI17Z_INSTALL_CHANNEL: 'INSTALLER' }, true)).toBe('INSTALLER');
  });

  it('still falls back the way it always did', () => {
    // An installation from before the marker existed keeps its old answer.
    expect(updateMethodFrom({}, true)).toBe('INSTALLER');
    expect(updateMethodFrom({}, false)).toBe('CHECKOUT');
    expect(updateMethodFrom({ AI17Z_INSTALL_CHANNEL: 'SOMETHING_ELSE' }, true)).toBe('INSTALLER');
  });

  it('is told which platform it is, by the thing that knows', () => {
    // The API runs in a container and cannot see the program directory, so
    // something outside has to hand the answer in. Both launchers always did;
    // the lifecycles now do too, so a lifecycle started directly -- which is
    // what the updater does after swapping the application -- carries it as
    // well. The reported fault was downstream of this, in `updateMethodFrom`.
    expect(ran(read('packaging/macos/ai17z-lifecycle.sh'))).toContain('AI17Z_INSTALL_CHANNEL=MACOS_PKG');
    expect(ran(read('packaging/ubuntu/ai17z-lifecycle.sh'))).toContain('AI17Z_INSTALL_CHANNEL=UBUNTU_DEB');
  });

  it('has copy for every method it can report', () => {
    const panel = read('apps/web/src/components/UpdatePanel.tsx');
    for (const method of ['BOOTSTRAP', 'INSTALLER', 'MACOS_PKG', 'UBUNTU_DEB', 'CHECKOUT']) {
      expect(panel, `no instructions for ${method}`).toMatch(new RegExp(`^\\s*${method}: \\{`, 'm'));
    }
    // And a Mac is never sent to PowerShell.
    const macos = panel.slice(panel.indexOf('MACOS_PKG:'), panel.indexOf('UBUNTU_DEB:'));
    expect(macos).toContain('ai17z update');
    expect(macos).not.toMatch(/\.ps1/);
  });
});

describe('a release is newer by semver, not by the shell', () => {
  it('ranks the release above the betas that led to it', () => {
    // `sort -V` on macOS and `dpkg --compare-versions` on Ubuntu both put
    // 1.0.0 *below* 1.0.0-beta.19. Run against that pair to check, not assumed.
    // So the release this whole series leads to would have been refused as "not
    // newer" on two platforms out of three.
    expect(compareVersions('1.0.0', '1.0.0-beta.19')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta.20', '1.0.0-beta.19')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta.18', '1.0.0-beta.19')).toBeLessThan(0);
    expect(compareVersions('1.0.1', '1.0.0')).toBeGreaterThan(0);
  });

  it('is what both Unix updaters ask, through one implementation', () => {
    for (const updater of ['packaging/macos/ai17z-update.sh', 'packaging/ubuntu/ai17z-update.sh']) {
      const text = ran(read(updater));
      expect(text, `${updater} still compares in the shell`).not.toMatch(/sort -V/);
      expect(text, `${updater} still uses dpkg to compare`).not.toMatch(/dpkg --compare-versions/);
      expect(text, `${updater} does not ask`).toContain('ai17z_version_is_newer "$VERSION" "$CURRENT"');
      // A bridge that could not answer is a third outcome, not a quiet no.
      expect(text).toContain('NOT-NEWER)');
      expect(text).toMatch(/could not work out whether/);
      // And the comparator is not copied back in beside the call.
      expect(text, `${updater} carries its own copy again`).not.toMatch(/^ai17z_version_is_newer\(\)/m);
    }
    // One definition, in the file both already source, reaching the bridge.
    const shared = read('packaging/unix/ai17z-paths.sh');
    expect(shared).toMatch(/^ai17z_version_is_newer\(\) \{/m);
    expect(shared).toContain('preflight.mts" --newer');
    // And the bridge answers it.
    expect(read('packaging/preflight.mts')).toContain("'NEWER' : 'NOT-NEWER'");
  });
});

// An update that keeps serving the previous version's containers is the fourth
// fault in the report. Its assertions are in `imageFreshness.test.ts`, with the
// Windows half they should have been beside all along: this file only ever read
// `start-ai17z.ps1`, which is exactly why macOS and Ubuntu went twelve releases
// without the check.

describe('the launcher on PATH', () => {
  it('resolves the symlink the installer creates', () => {
    // `dirname "${BASH_SOURCE[0]}"` of a symlink is the directory the *link* is
    // in, so `ai17z` on PATH looked for the runtime in ~/.local/bin and every
    // command failed. The installer creates exactly that link.
    const launcher = ran(read('packaging/macos/ai17z'));
    expect(launcher).toContain('while [ -L "$target" ]');
    expect(launcher).toContain('ai17z_self');
    expect(read('install-ai17z-macos.sh')).toContain('ln -sf');
  });
});

describe('what a packaged copy says and keeps', () => {
  it('looks for Chrome where macOS puts it', () => {
    // It only knew the Linux paths, and this script runs on both -- so a Mac
    // with Chrome was told on every setup that Chrome was missing. A warning
    // that is wrong is worse than none: the next true one reads as noise.
    const setup = ran(read('install-ai17z.sh'));
    // Anchored at the opening quote, because `$HOME/Applications/...` contains
    // `/Applications/...` and a plain substring check was satisfied by the
    // per-user path alone -- which a Mac with Chrome in the ordinary place
    // does not have.
    expect(setup, 'no system-wide Chrome path').toMatch(
      /"\/Applications\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome"/,
    );
    expect(setup, 'no per-user Chrome path').toMatch(
      /"\$HOME\/Applications\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome"/,
    );
    // And Linux, which is the half that already worked.
    expect(setup).toContain('/usr/bin/google-chrome');
  });

  it('tells a packaged copy the command it actually has', () => {
    const setup = ran(read('install-ai17z.sh'));
    expect(setup).toContain('ai17z start');
    expect(setup).toContain('./start-ai17z.sh');
  });

  it('keeps the browser log across a restart', () => {
    // Truncating it meant the next start erased why the last one failed, and
    // starting it again is exactly what somebody does after it fails.
    const lifecycle = ran(read('packaging/macos/ai17z-lifecycle.sh'));
    expect(lifecycle).toContain('>>"$WORKER_LOG"');
    expect(lifecycle).not.toMatch(/[^>]>"\$WORKER_LOG" 2>/);
  });
});

describe('the diagnostics say when something is wrong', () => {
  const doctor = read('doctor-ai17z.sh');

  it('counts accounts by state rather than by existence', () => {
    // One account, `offline`, every sign-in failing -- and the report said
    // "1 connected" and finished with "Nothing is broken".
    expect(ran(doctor)).not.toContain(`grep -o '"kind":"account"'`);
    expect(doctor).toContain('unhealthy');
    expect(doctor).toContain('of $total not working');
  });

  it('reports the browser component the API publishes', () => {
    expect(doctor).toContain('Browser, as the API sees it');
  });

  it('names a command the reader actually has', () => {
    // Found while fixing the setup script's next-steps text, which had the same
    // fault: two pieces of advice told a packaged owner to run
    // `./install-ai17z.sh`, a developer's script that is not on their path and
    // is not how setup runs in a package anyway. Advice naming a command
    // somebody does not have is a dead end at the exact moment they are stuck.
    const text = ran(doctor);
    expect(text, 'the doctor cannot tell the two kinds apart').toContain('PACKAGED=1');
    const advice = text.split(/\r?\n/).filter((line) => line.includes('todo+=('));
    const packaged = advice.filter((line) => line.includes('install-ai17z.sh'));
    // Every mention of the developer script has the packaged alternative beside
    // it, so the two cannot drift apart.
    expect(packaged.length).toBeGreaterThan(0);
    expect(text.match(/ai17z start/g)?.length ?? 0).toBeGreaterThanOrEqual(packaged.length);
  });

  it('creates nothing, having said it changes nothing', () => {
    // It used to `mkdir -p` the profile root it was probing.
    expect(ran(doctor)).not.toMatch(/mkdir -p "\$profile_root"/);
    expect(doctor).toContain('AI17Z_BROWSER_PROFILES');
  });
});
