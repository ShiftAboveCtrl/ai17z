import { describe, expect, it } from 'vitest';
import { buildVersion, describeVersion, releaseName } from '@xbam/shared';

/**
 * An installation that cannot say what it is running makes two ordinary
 * questions unanswerable: "have you updated?" and "which version has the bug?".
 * The workers.version column had existed since presence tracking was added and
 * nothing ever wrote to it.
 */
describe('what this installation is running', () => {
  it('knows its package version', () => {
    expect(buildVersion().version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('says where the commit came from, so a reader knows what it is worth', () => {
    // A commit stamped into an image at build time and one read from a checkout
    // are different claims, and conflating them hides which one you have.
    expect(['build', 'git', 'unknown']).toContain(buildVersion().source);
  });

  it('is one line, fit for a log, a heartbeat row or a screen', () => {
    const described = describeVersion();
    expect(described).toContain(buildVersion().version);
    expect(described).not.toContain('\n');
  });

  it('admits it does not know rather than inventing something', () => {
    expect(describeVersion({ version: '1.2.3', commit: null, source: 'unknown' })).toBe('v1.2.3 (source unknown)');
  });

  it('names the commit when there is one', () => {
    expect(describeVersion({ version: '1.2.3', commit: 'abc123def456', source: 'build' })).toBe('v1.2.3 (abc123def456)');
  });

  it('answers the same thing every time it is asked', () => {
    // Read once: it cannot change without the process restarting, and shelling
    // out to git on every health check would be absurd.
    expect(buildVersion()).toBe(buildVersion());
  });
});

/**
 * What a release is called.
 *
 * `v0.1.0-rc.8` is a correct version and a poor name: it is the first thing
 * somebody sees on a downloads page and it tells them nothing about which
 * product it is or how finished it is. The number is unchanged -- it is still
 * what `compareVersions` orders and what the tag says -- and this is a
 * rendering of it.
 *
 * The same grammar is implemented a second time, in ISPP, in
 * packaging/windows/ai17z.iss, because the Windows uninstall list is written
 * by the installer and cannot call this. These cases are what keeps the two
 * honest; they are the exact strings that file was compiled against.
 */
describe('what a release is called', () => {
  it('names the channel before the number, the way a person says it', () => {
    expect(releaseName('1.0.0-beta.1').title).toBe('AI17Z Beta 1.0.0');
  });

  it('does not say "1" for the first of anything', () => {
    // "AI17Z Beta 1.0.0 (1)" is a worse name than "AI17Z Beta 1.0.0", and
    // every cycle starts with one, so the common case must read cleanly.
    expect(releaseName('1.0.0-beta.1').title).not.toContain('(');
    expect(releaseName('1.0.0-beta.2').title).toBe('AI17Z Beta 1.0.0 (2)');
  });

  it('spells out rc, which is jargon', () => {
    expect(releaseName('0.1.0-rc.8').title).toBe('AI17Z Release Candidate 0.1.0 (8)');
  });

  it('is just the number when the release is finished', () => {
    expect(releaseName('1.0.0').title).toBe('AI17Z 1.0.0');
    expect(releaseName('1.0.0').channel).toBeNull();
  });

  it('takes a tag with its v, because that is what GitHub hands over', () => {
    expect(releaseName('v1.0.0-beta.1').title).toBe(releaseName('1.0.0-beta.1').title);
  });

  it('always shows three numbers, so it does not look like two products', () => {
    expect(releaseName('2.1').number).toBe('2.1.0');
    expect(releaseName('3').title).toBe('AI17Z 3.0.0');
  });

  it('renders a word nobody planned for rather than breaking the screen', () => {
    expect(releaseName('1.0.0-nightly.4').title).toBe('AI17Z Nightly 1.0.0 (4)');
  });

  it('survives a prerelease with no count', () => {
    expect(releaseName('2.0.0-preview').title).toBe('AI17Z Preview 2.0.0');
    expect(releaseName('2.0.0-preview').iteration).toBe(1);
  });

  it('leaves the number alone for anything that has to sort or compare', () => {
    // The name is for reading. Nothing may parse it back into a version.
    expect(releaseName('1.0.0-beta.2').number).toBe('1.0.0');
    expect(releaseName('1.0.0-beta.2').channel).toBe('Beta');
    expect(releaseName('1.0.0-beta.2').iteration).toBe(2);
  });

  it('has a short form for a badge with no room for the product name', () => {
    expect(releaseName('1.0.0-beta.1').short).toBe('Beta 1.0.0');
    expect(releaseName('1.0.0-beta.1').title).toContain(releaseName('1.0.0-beta.1').short);
  });

  it('names whatever this installation is running', () => {
    expect(releaseName().number).toBe(buildVersion().version.replace(/-.*$/, ''));
  });
});
