import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Handing somebody over to Docker, on a Mac, without losing them.
 *
 * Reported from a real Mac: Docker never appeared and the engine never came up.
 * The installer downloaded Docker's disk image, mounted it, and then ran
 *
 *     open "$MOUNT/Docker.app"
 *
 * while telling somebody to "follow Docker Desktop's installer". A `.dmg` is
 * not an installer. That line launches Docker *from the read-only volume*,
 * which the script then ejects out from under it -- so nothing ever reaches
 * `/Applications`, and the failure reads as Docker's rather than as ours.
 *
 * Nothing caught it, and the reason is worth writing down: the hosted macOS
 * proof answers the `docker` command at the vendor boundary, precisely so that
 * everything *after* the Docker gate can be tested on a runner that cannot have
 * Docker. That stub makes this whole branch unreachable. It is the one part of
 * the macOS route a machine here cannot run, and `docs/MACOS_TEST_CHECKLIST.md`
 * says so -- but "not covered" was left as a sentence in a document rather than
 * as anything that would fail.
 *
 * So these are the properties of the handover, read off the script. They cannot
 * prove it works on a Mac. They can keep the shape that was wrong from coming
 * back.
 */

const root = resolve(__dirname, '../..');
const installer = readFileSync(resolve(root, 'install-ai17z-macos.sh'), 'utf8');

/** Lines that actually run, so a comment explaining a mistake is not the mistake. */
const runs = installer
  .split(/\r?\n/)
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

describe('the Docker Desktop handover on macOS', () => {
  it('never treats the disk image as an installer', () => {
    // The exact shape of the defect: opening the application out of the volume
    // instead of installing it.
    expect(runs).not.toMatch(/open\s+"\$MOUNT\/Docker\.app"/);
    expect(runs).not.toMatch(/open\s+-a\s+"?\$MOUNT/);
  });

  it('installs through the binary Docker documents for it', () => {
    // `sudo /Volumes/Docker/Docker.app/Contents/MacOS/install`, which is
    // Docker's own command-line install -- the vendor's documented route, the
    // same rule that sends Ubuntu to Docker's APT repository and never to
    // get.docker.com.
    expect(runs).toContain('Docker.app/Contents/MacOS/install');
    expect(runs).toMatch(/sudo "\$DOCKER_INSTALL"/);
    // And only where somebody is there to answer sudo.
    expect(runs).toMatch(/\[ -x "\$DOCKER_INSTALL" \] && \[ -t 0 \]/);
  });

  it('never accepts Docker\'s licence for anybody', () => {
    // That binary takes `--accept-license`. It is the one flag this must never
    // grow: Docker collects its own agreement on first launch, and AI17Z has no
    // business answering it. The same rule as `--accept-license` never
    // appearing beside winget on Windows.
    //
    // Against lines that run, not against the file: the comment above the call
    // names the flag in order to forbid it. That is the third time in this
    // repository a check has had to learn the difference between a word and an
    // instruction -- `continue-on-error` and `Reading it afterwards` were the
    // other two.
    expect(runs).not.toMatch(/accept.?license/i);
  });

  it('opens the volume so somebody can drag it, when it is not installed', () => {
    // What a disk image is for. The window holds Docker.app and a shortcut to
    // Applications; dragging one onto the other is the whole of it, and the
    // instruction says exactly that.
    expect(runs).toMatch(/open "\$MOUNT"/);
    expect(installer).toMatch(/Drag Docker\.app onto the Applications folder/);
  });

  it('waits by looking, not by asking for a keypress', () => {
    // A keypress proves somebody pressed a key. What matters is whether the
    // application is there, and that is observable -- so it is observed. The
    // old branch read a line and believed it.
    expect(runs).toMatch(/while \[ ! -d "\/Applications\/Docker\.app" \]/);
    expect(runs).not.toMatch(/Press return once Docker/);
  });

  it('ejects the image only once the copy that matters exists', () => {
    // Ejecting first is what left nothing behind. The detach that follows the
    // success line must come after it.
    const installed = runs.indexOf('good "Docker Desktop is in Applications"');
    expect(installed).toBeGreaterThan(-1);
    const detachAfter = runs.indexOf('hdiutil detach', installed);
    expect(detachAfter).toBeGreaterThan(installed);
  });

  it('refuses rather than half-finishing where nobody can answer', () => {
    // No terminal means nobody can drag anything, and a script that carried on
    // would report Docker's absence as Docker's fault.
    const branch = installer.slice(installer.indexOf('Opening Docker\'s disk image'));
    expect(branch).toContain('needs somebody to put it in Applications');
    expect(branch).toContain('Nothing on this Mac was changed by AI17Z');
  });

  it('declares the one host that is not AI17Z\'s own release', () => {
    // The Docker download used a bare `curl`, so the declared allow-list was
    // not the whole list -- which makes the declaration worth nothing. It now
    // goes through the same assertion as everything else.
    expect(installer).toMatch(/ALLOWED_HOSTS=.*desktop\.docker\.com/);
    expect(runs).toMatch(/fetch_watched "\$DOCKER_DMG" "\$DOCKER_URL"/);
    // Every curl in the file is inside a helper that asserts the host first.
    for (const line of runs.split(/\r?\n/)) {
      if (!/curl /.test(line)) continue;
      expect(line, `a curl outside the allow-list helpers: ${line.trim()}`).toMatch(
        /^(fetch|fetch_watched|fetch_stdout)\(\)/,
      );
    }
  });

  it('still touches no macOS security control', () => {
    // Unchanged by any of this, and asserted here as well as in the hosted
    // proof, because this branch is the one the hosted proof cannot reach.
    for (const forbidden of ['spctl', 'csrutil', 'codesign', 'xattr -d']) {
      expect(runs, `${forbidden} appears in a line that runs`).not.toContain(forbidden);
    }
  });
});
