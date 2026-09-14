import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');

/**
 * An upgrade has to run the code it installed.
 *
 * Windows first, then macOS and Ubuntu, which this file did not cover for
 * twelve releases -- see the second suite below.
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

/**
 * Whether a native worker is running is a question for the database.
 *
 * It was answered from a pid file, and that was wrong three ways at once on a
 * machine with two installations:
 *
 *   - the recorded pid is the cmd.exe npm runs, not the worker. The worker can
 *     be gone while the wrapper lives, and Get-Process still says running
 *   - pids are reused, so an unrelated process answers to the number
 *   - a pid says nothing about which installation a worker serves
 *
 * What that produced: the launcher printed "native worker already running"
 * while the interface, reading that installation's own heartbeat, said nothing
 * was there that could open a browser. Two scripts, one machine, opposite
 * answers -- and the agent could not be started.
 *
 * The heartbeat is per-installation by construction and is what the interface
 * already reads, so the launcher now reads the same thing.
 */
describe('the launcher asks the heartbeat, not Windows', () => {
  const launcher = read('start-ai17z.ps1');
  const packager = read('tools/package-windows.mts');

  it('runs the probe rather than inspecting a process', () => {
    expect(launcher).toContain("Invoke-Native npm @('run', '--silent', 'worker:present')");
  });

  it('no longer decides from the pid file', () => {
    // The pid file stays -- stopping needs it -- but it must not be what
    // "is it running" is answered from.
    expect(launcher).not.toMatch(/Get-Process -Id \(\[int\]\$existing\)/);
  });

  it('treats "could not ask" as different from "there is none"', () => {
    // Starting a second worker because the database blinked is worse than
    // leaving one out, so exit 2 is not the same as exit 1.
    expect(launcher).toContain('$probe -eq 2');
    expect(launcher).toContain('Could not ask the database');
  });

  it('does not refuse to start because another installation has one', () => {
    // That refusal stopped two installations from ever both driving Chrome,
    // which is a supported setup: different accounts, different databases, and
    // a Chrome profile keyed by account id.
    expect(launcher).not.toContain('Another AI17Z installation is already running a native worker');
    expect(launcher).not.toContain('Stop the other installation first');
  });

  it('does not let the probe decide how the launcher exits', () => {
    // The probe exits 1 for "no native worker", which is an answer. The script
    // ended without setting an exit code, so PowerShell handed cmd whatever the
    // last native command left -- and AI17Z.cmd printed "AI17Z did not start"
    // after a start that had worked and had just launched the worker the probe
    // reported missing. The gate caught this before it shipped.
    expect(launcher).toContain('$global:LASTEXITCODE = 0');
    expect(launcher.trimEnd().endsWith('exit 0'), 'the launcher must state its own success').toBe(true);
  });

  it('ships the probe, since the launcher cannot run without it', () => {
    expect(packager).toContain("'scripts/browser-worker-present.mts'");
    expect(packager).toContain("'worker:present'");
  });
});

/**
 * The same property, on the two platforms that did not have it.
 *
 * Windows has compared the label against the installed build since
 * Beta 1.0.0 (8). macOS and Ubuntu never did, and nothing here noticed, because
 * this file only ever read `start-ai17z.ps1`. So every Unix image carried
 * `ai17z.built-from=unknown` and an update went on serving the containers built
 * for the version before it -- found by somebody updating a Mac, twelve
 * releases later.
 *
 * The two lifecycles are parallel implementations on purpose: 162 of their 243
 * lines of code are already identical, because the shapes differ per platform
 * while the decisions do not. That only stays safe while the parallel halves
 * cannot quietly diverge, so the rule itself is compared rather than trusted.
 */
describe('an upgrade runs the code it installed, on Unix too', () => {
  const lifecycles = {
    macos: read('packaging/macos/ai17z-lifecycle.sh'),
    ubuntu: read('packaging/ubuntu/ai17z-lifecycle.sh'),
  };
  /** Lines that run, so a comment describing the fault is not mistaken for it. */
  const ran = (text: string) =>
    text
      .split(/\r?\n/)
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

  it.each(Object.entries(lifecycles))('%s has a stamp to compare against', (_platform, text) => {
    expect(ran(text)).toMatch(/^build_stamp\(\) \{$/m);
    expect(ran(text)).toMatch(/^image_stamp\(\) \{ # image$/m);
    expect(ran(text)).toContain('AI17Z_BUILD_STAMP="$(build_stamp)"');
    expect(ran(text)).toContain('export AI17Z_BUILD_STAMP AI17Z_VERSION');
  });

  it.each(Object.entries(lifecycles))('%s rebuilds without being asked', (_platform, text) => {
    const code = ran(text);
    // The call, not the name: a function that exists and is never called reads
    // identically to one that works.
    expect(code).toMatch(/^\s*if images_are_stale; then$/m);
    expect(code).toMatch(/^images_are_stale\(\) \{$/m);
    // And before the stack comes up, or the check is decoration.
    const build = code.indexOf('ai17z_compose build');
    const up = code.indexOf('ai17z_compose up -d');
    expect(build).toBeGreaterThan(-1);
    expect(build).toBeLessThan(up);
  });

  it.each(Object.entries(lifecycles))('%s says why it is building', (_platform, text) => {
    // A rebuild takes minutes. Unexplained, it reads as a hang -- and this one
    // fires on the first start after every update.
    expect(ran(text)).toContain('step "Rebuilding the containers for this version"');
    expect(ran(text)).toContain("note \"The ${service} image holds");
  });

  it.each(Object.entries(lifecycles))('%s never lets a missing answer mean "no need"', (_platform, text) => {
    // An image with no label, an image that is not there, docker not
    // answering: `image_stamp` prints nothing for all three, and nothing can
    // equal a stamp, so every one of them ends in a rebuild.
    const code = ran(text);
    expect(code).toContain('[ "$built" = "$want" ] || {');
    expect(code).toContain("|| printf ''");
    // And a project name that cannot be read is also a rebuild, not a skip.
    expect(code).toContain('[ -n "$project" ] || return 0');
  });

  it.each(Object.entries(lifecycles))('%s reads the label the simple way, which is safe here', (_platform, text) => {
    // The quoted-template trap is Windows PowerShell's native argument
    // passing, not this shell's, so `{{index ...}}` is correct in a POSIX
    // shell and was proved against a real image.
    expect(ran(text)).toContain('{{index .Config.Labels "ai17z.built-from"}}');
  });

  it('decides staleness identically on both platforms', () => {
    const body = (text: string) => {
      const start = text.indexOf('images_are_stale() {');
      expect(start).toBeGreaterThan(-1);
      return text.slice(start, text.indexOf('\n}', start)).replace(/\r/g, '');
    };
    expect(body(lifecycles.ubuntu), 'the two launchers no longer agree').toBe(body(lifecycles.macos));
  });
});
