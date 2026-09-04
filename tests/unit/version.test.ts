import { describe, expect, it } from 'vitest';
import { buildVersion, describeVersion } from '@xbam/shared';

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
