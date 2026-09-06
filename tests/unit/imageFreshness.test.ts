import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');

/**
 * An upgrade has to run the code it installed.
 *
 * `docker compose up -d` builds an image only when one is *missing*. It has no
 * idea the source changed. The Docker project name is derived from the data
 * directory, which an upgrade deliberately does not touch, so the project name
 * is stable -- and every image from the previous version was still there and
 * still started.
 *
 * The result was the worst shape a bug can have: somebody downloads a fix, runs
 * the installer, launches AI17Z, and sees the identical fault, with every check
 * passing and nothing anywhere saying why. Uninstalling and installing again
 * did not help either, because the images key off the data path rather than the
 * program directory.
 *
 * It was found because the release gate passed while deliberately running a bug
 * that blanks the interface: the gate had reused a nine-hour-old image. So this
 * covers both halves -- the launcher noticing, and the gate being unable to
 * hide it again.
 */
describe('an upgrade runs the code it installed', () => {
  const compose = read('docker-compose.yml');
  const launcher = read('start-ai17z.ps1');
  const gate = read('tools/verify-install.mts');

  it('stamps every built image with the source it came from', () => {
    // Only the three built here. Postgres is pulled and has no such question.
    const stamps = compose.match(/ai17z\.built-from:/g) ?? [];
    expect(stamps, 'api, web and worker each need the label').toHaveLength(3);
    expect(compose).toContain('${AI17Z_BUILD_STAMP:-unknown}');
  });

  it('gives the launcher a stamp to compare against', () => {
    expect(launcher).toContain('function Get-SourceStamp');
    expect(launcher).toContain('function Get-ImageStamp');
    expect(launcher).toContain('$env:AI17Z_BUILD_STAMP = Get-SourceStamp');
  });

  it('rebuilds without being asked, not only under -Rebuild', () => {
    // The whole defect was that building was opt-in. A `-Rebuild` switch is
    // still there for the case where somebody wants it, but it must not be the
    // only path to a build.
    expect(launcher).toMatch(/\$needsBuild\s*=\s*\[bool\]\$Rebuild/);
    expect(launcher).toContain('$built -ne $env:AI17Z_BUILD_STAMP');
    expect(launcher).toContain('if ($needsBuild) {');
  });

  it('says why it is building, because a surprise build looks like a hang', () => {
    // A first launch compiles for minutes. An unexplained one on a later start
    // reads as broken.
    expect(launcher).toContain('Write-Step "Building images: $why..."');
  });

  it('reads the label in the one way that survives PowerShell', () => {
    // `--format '{{index .Config.Labels "x"}}'`: the double quote does not
    // survive Windows PowerShell's native argument passing, docker gets a
    // broken template and prints an empty line, and an empty line reads exactly
    // like a missing label -- which here would mean never rebuilding.
    expect(launcher).toContain('{{json .Config.Labels}}');
    // Comment lines are exempt: the reason is written down twice in this file,
    // and a test that forbade naming the trap would forbid explaining it.
    const code = launcher
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(code, 'the broken template is being used, not just described').not.toMatch(/index \.Config\.Labels/);
  });

  it('never lets a missing answer mean "no need to build"', () => {
    // Every way of not knowing has to end in a build. An image with no label,
    // an image that is not there, docker not answering: all the same.
    expect(launcher).toContain('if (-not $built) {');
    const notKnown = launcher.slice(launcher.indexOf('if (-not $built) {'));
    expect(notKnown.slice(0, 200)).toContain('$needsBuild = $true');
  });

  it('survives being run where git is not installed', () => {
    // The launcher runs under ErrorActionPreference = Stop, where a native
    // command writing to stderr -- or not existing, which is git on a machine
    // that only ever installed AI17Z -- becomes a terminating error. Three
    // faults have already lived in scripts that only worked when something
    // happened to be present.
    expect(launcher).toContain('function Invoke-Quiet');
    expect(launcher).toMatch(/Invoke-Quiet git @\('-C', \$PSScriptRoot, 'rev-parse', 'HEAD'\)/);
    expect(launcher).toMatch(/Invoke-Quiet docker @\('inspect'/);
  });

  it('takes the images down with the room, or the room is not clean', () => {
    expect(gate).toContain("'down', '-v', '--rmi', 'local'");
    // And by name as well: `--rmi local` cannot remove an image a container
    // from a failed run still holds.
    expect(gate).toContain("['image', 'rm', '-f', `${project}-${service}`]");
  });

  it('makes the second install of the upgrade a different version', () => {
    // Two byte-identical installs cannot answer the question. A real upgrade is
    // a new version, and the stamp is what carries that.
    expect(gate).toContain('const upgradedVersion =');
    expect(gate).toContain("JSON.stringify({ ...stampBefore, version: upgradedVersion }");
  });

  it('fails the upgrade when the images did not move', () => {
    expect(gate).toContain('the upgrade did not rebuild');
    expect(gate).toContain('webAfter === webBefore');
    // Newer is not enough: it has to be the version that was just installed.
    expect(gate).toContain('webAfter.startsWith(upgradedVersion)');
  });

  it('looks at the interface after the upgrade too', () => {
    // Rebuilding into a broken bundle is the same outcome for a person as not
    // rebuilding at all.
    const upgradeSection = gate.slice(gate.indexOf('async function upgradeBody'));
    expect(upgradeSection).toContain('signInAndLook(label, ports)');
  });
});
