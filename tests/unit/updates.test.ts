import { describe, expect, it } from 'vitest';
import { compareVersions } from '@xbam/runtime';

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
