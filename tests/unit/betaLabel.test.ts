import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { betaLabelFor, compareVersions, releaseName } from '@xbam/shared';

/**
 * What a beta is called, now that there have been twenty of them.
 *
 * `AI17Z Beta 1.0.0 (20)` had stopped saying anything. The `1.0.0` is identical
 * on every beta, so it carries no information and pushes the part that does to
 * the end, in brackets, where it reads as a build number. The owner asked for
 * the shape people already know: Beta 1.0 through Beta 1.9, then Beta 2.0.
 *
 * The whole safety of this rests on one property, which the tests below spend
 * most of their time on: **the tag does not change.** `1.0.0-beta.21` stays
 * exactly that. Semver precedence, the prerelease filter, the Debian version,
 * Windows' four-digit `VersionInfoVersion`, every updater comparison and every
 * installation already in the field go on working on a number that only counts
 * up, and the label is a rendering nothing parses back.
 *
 * The trap avoided, stated plainly because it is the obvious thing to try:
 * tagging `1.0.0-beta.3.1` instead. Semver compares prerelease identifiers
 * field by field, so `beta.3.1` sorts *below* `beta.20` -- every installation
 * in the field would have refused the upgrade as older, and the refusal would
 * have looked exactly like the release being broken.
 */

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('the beta label counts the way people do', () => {
  it('puts ten in a row before carrying', () => {
    // The sequence the owner asked for, written out rather than generated, so
    // a change to the arithmetic has to disagree with the list itself.
    const wanted: Record<number, string> = {
      1: '1.1',
      2: '1.2',
      9: '1.9',
      10: '2.0',
      11: '2.1',
      19: '2.9',
      20: '3.0',
      21: '3.1',
      29: '3.9',
      30: '4.0',
      100: '11.0',
    };
    for (const [iteration, label] of Object.entries(wanted)) {
      expect(betaLabelFor(Number(iteration)), `beta.${iteration}`).toBe(label);
    }
  });

  it('never shows a minor digit outside 0 through 9', () => {
    for (let iteration = 1; iteration <= 250; iteration += 1) {
      const [major, minor] = betaLabelFor(iteration).split('.');
      expect(Number(minor), `beta.${iteration}`).toBeGreaterThanOrEqual(0);
      expect(Number(minor), `beta.${iteration}`).toBeLessThanOrEqual(9);
      expect(Number(major), `beta.${iteration}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('never goes backwards as the tag counts up', () => {
    // The label is what somebody reads to decide whether they are behind, so a
    // pair of iterations that renders out of order is a lie even though the
    // machine ordering is fine.
    let previous = -Infinity;
    for (let iteration = 1; iteration <= 250; iteration += 1) {
      const [major, minor] = betaLabelFor(iteration).split('.').map(Number);
      const rank = (major ?? 0) * 10 + (minor ?? 0);
      expect(rank, `beta.${iteration} ranks below beta.${iteration - 1}`).toBeGreaterThan(previous);
      previous = rank;
    }
  });

  it('is what this release and the next one are called', () => {
    // The two the owner named. Written as the exact strings a person sees.
    expect(releaseName('1.0.0-beta.20').title).toBe('AI17Z Beta 3.0');
    expect(releaseName('1.0.0-beta.21').title).toBe('AI17Z Beta 3.1');
    expect(releaseName('1.0.0-beta.20').short).toBe('Beta 3.0');
    expect(releaseName('1.0.0-beta.20').betaLabel).toBe('3.0');
  });

  it('keeps the machine number beside the label rather than instead of it', () => {
    // A diagnostics screen shows both. The label is not a version and the
    // version is not a label, and neither is derived from the other's text.
    const named = releaseName('1.0.0-beta.21');
    expect(named.number).toBe('1.0.0');
    expect(named.iteration).toBe(21);
    expect(named.channel).toBe('Beta');
  });
});

describe('what the label must not have changed', () => {
  it('leaves semver ordering exactly where it was', () => {
    // The label has no say in any of this. Included because it is the property
    // that would end a release if it were wrong, and it costs four lines.
    expect(compareVersions('1.0.0-beta.21', '1.0.0-beta.20')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta.20', '1.0.0-beta.19')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta.9', '1.0.0-beta.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0-beta.21')).toBeGreaterThan(0);
  });

  it('shows why the tag was not renumbered to match the label', () => {
    // `1.0.0-beta.3.1` is the obvious thing to try and it is the one thing that
    // would have broken every installation in the field. Asserted rather than
    // explained, so nobody has to take it on trust.
    expect(compareVersions('1.0.0-beta.3.1', '1.0.0-beta.20')).toBeLessThan(0);
  });

  it('leaves the grammar of every other channel alone', () => {
    // An rc names the release it is a candidate for, which is the point of an
    // rc; a finished release is its number. Only the beta changed.
    expect(releaseName('1.0.0-rc.1').title).toBe('AI17Z Release Candidate 1.0.0');
    expect(releaseName('1.0.0-rc.8').title).toBe('AI17Z Release Candidate 1.0.0 (8)');
    expect(releaseName('1.0.0').title).toBe('AI17Z 1.0.0');
    expect(releaseName('1.0.0-alpha.2').title).toBe('AI17Z Alpha 1.0.0 (2)');
    for (const version of ['1.0.0-rc.1', '1.0.0', '1.0.0-alpha.2']) {
      expect(releaseName(version).betaLabel, version).toBeNull();
    }
  });
});

describe('the installer says the same thing as the application', () => {
  const iss = read('packaging/windows/ai17z.iss');
  const version = read('packages/shared/src/version.ts');

  it('does the same arithmetic in its own language', () => {
    // ISPP cannot call a TypeScript function, so this grammar exists twice --
    // one more than the rule allows, which is why the two are held against
    // each other here. Add/Remove Programs and the version screen are read side
    // by side, and disagreeing looks like two builds installed at once.
    expect(iss).toContain('#define PreCountNumber PreCount == "" ? 0 : Int(PreCount)');
    expect(iss).toContain('Str((PreCountNumber / 10) + 1) + "." + Str(PreCountNumber % 10)');
    expect(version).toContain('Math.floor(safe / 10) + 1');
    expect(version).toContain('safe % 10');
  });

  it('applies it to betas only, on both sides', () => {
    expect(iss).toContain('LowerCase(PreWord) == "beta" ? "Beta " + BetaLabel');
    expect(version).toContain("word.toLowerCase() === 'beta'");
    // And the old grammar is still there for everything else.
    expect(iss).toContain('ChannelWord + " " + NumericVersion + IterationSuffix');
    expect(version).toContain("iteration > 1 ? ` (${iteration})` : ''");
  });

  it('still hands Windows a number rather than a label', () => {
    // `VersionInfoVersion` must be four numbers or Inno refuses the script, and
    // the download filename is a URL: a name with a space in it is not.
    expect(iss).toMatch(/^VersionInfoVersion=\{#NumericVersion\}/m);
    expect(iss).toMatch(/^OutputBaseFilename=AI17Z-Setup-\{#AppVersion\}/m);
    // The label goes where a person reads it, and nowhere else.
    expect(iss).toMatch(/^AppVerName=\{code:InstanceName\} \{#ReleaseVersionOnly\}/m);
    expect(iss).toMatch(/^UninstallDisplayName=\{code:InstanceName\} \{#ReleaseVersionOnly\}/m);
  });
});
