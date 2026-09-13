import { describe, expect, it } from 'vitest';
import { compareVersions, updateMethodFrom } from '@xbam/runtime';

/**
 * Which of two versions is newer.
 *
 * The whole update mechanism rests on this one function: get it wrong and an
 * installation either never hears about a release or is offered a downgrade.
 * The rule people get wrong is the prerelease one -- `0.1.0-rc.4` comes
 * *before* `0.1.0`, not after it, because a candidate leads to a release rather
 * than following it.
 */
describe('comparing versions', () => {
  const newer = (a: string, b: string) => expect(compareVersions(a, b)).toBeGreaterThan(0);
  const same = (a: string, b: string) => expect(compareVersions(a, b)).toBe(0);

  it('orders by major, then minor, then patch', () => {
    newer('1.0.0', '0.9.9');
    newer('0.2.0', '0.1.9');
    newer('0.1.2', '0.1.1');
    same('0.1.0', '0.1.0');
  });

  it('treats a release as newer than its own candidates', () => {
    // The one that matters: everybody on rc.3 must be offered 0.1.0, and
    // nobody on 0.1.0 must be offered rc.4.
    newer('0.1.0', '0.1.0-rc.4');
    expect(compareVersions('0.1.0-rc.4', '0.1.0')).toBeLessThan(0);
  });

  it('orders candidates among themselves numerically', () => {
    newer('0.1.0-rc.10', '0.1.0-rc.9');
    // Not as strings: "rc.10" sorts before "rc.9" alphabetically, which would
    // have stopped anybody on rc.9 ever hearing about rc.10.
    expect(['0.1.0-rc.10', '0.1.0-rc.9'].sort()[0]).toBe('0.1.0-rc.10');
  });

  it('ignores a leading v, because tags carry one and versions do not', () => {
    same('v0.1.0', '0.1.0');
    newer('v0.2.0', '0.1.0');
  });

  it('does not treat a missing patch as newer than a zero', () => {
    same('0.1', '0.1.0');
  });

  it('says nothing is newer than itself', () => {
    for (const version of ['0.1.0', '0.1.0-rc.1', '1.2.3-beta.2']) same(version, version);
  });

  it('survives something that is not a version at all', () => {
    // A tag somebody typed by hand. Wrong answers are acceptable here;
    // throwing, in the middle of a check nobody asked for, is not.
    expect(() => compareVersions('nightly', '0.1.0')).not.toThrow();
    expect(() => compareVersions('', '')).not.toThrow();
  });
});

/**
 * How an installation takes an update.
 *
 * Three layouts now: the Windows installer, AI17Z Setup, and a checkout. They
 * update in three different ways, and offering the wrong one is how somebody
 * ends up running `git pull` in a directory with no repository in it, or
 * downloading an installer for a copy that updates itself from the Start Menu.
 *
 * The signal is a marker whichever program installed it wrote, and the fallback
 * is what this did before that marker existed -- because an installation made by
 * an older release has no marker and must not suddenly be told it is a checkout.
 */
describe('which update route an installation has', () => {
  it('believes the marker the installer wrote', () => {
    expect(updateMethodFrom({ AI17Z_INSTALL_CHANNEL: 'BOOTSTRAP' }, false)).toBe('BOOTSTRAP');
    expect(updateMethodFrom({ AI17Z_INSTALL_CHANNEL: 'INSTALLER' }, false)).toBe('INSTALLER');
    // Whatever case it was written in. The launcher passes it through as a
    // string and nothing normalises it on the way.
    expect(updateMethodFrom({ AI17Z_INSTALL_CHANNEL: 'bootstrap' }, false)).toBe('BOOTSTRAP');
    expect(updateMethodFrom({ AI17Z_INSTALL_CHANNEL: ' Installer ' }, false)).toBe('INSTALLER');
  });

  it('falls back to what it did before the marker existed', () => {
    // Every installation published before this was written has no marker, and
    // has to keep being offered the installer.
    expect(updateMethodFrom({ AI17Z_INSTALLED: '1' }, false)).toBe('INSTALLER');
    expect(updateMethodFrom({}, true)).toBe('INSTALLER');
    expect(updateMethodFrom({}, false)).toBe('CHECKOUT');
  });

  it('does not invent a third answer from a channel it does not understand', () => {
    // Something wrote a value nothing here knows. Guessing from it would be
    // worse than falling back to the signal that has always worked.
    expect(updateMethodFrom({ AI17Z_INSTALL_CHANNEL: 'MSIX', AI17Z_INSTALLED: '1' }, false)).toBe('INSTALLER');
    expect(updateMethodFrom({ AI17Z_INSTALL_CHANNEL: 'MSIX' }, false)).toBe('CHECKOUT');
  });

  it('is not confused by a developer checkout whose containers were built here', () => {
    // buildVersion().source says `build` for a developer's own images, which is
    // why it was never the right signal: it told a developer with a repository
    // to go and download an installer.
    expect(updateMethodFrom({ AI17Z_BUILD_COMMIT: 'abc123abc123' }, false)).toBe('CHECKOUT');
  });
});
