import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PLATFORMS,
  installerScriptAsset,
  macosPackageAsset,
  ubuntuPackageAsset,
  windowsPackageAsset,
} from '@xbam/shared';

/**
 * One tag, three platforms, and nothing relabelled.
 *
 * The expensive mistake this exists to prevent is an architecture built on the
 * wrong runner: an arm64 package assembled on an Intel machine carries x86_64
 * native modules under an arm64 name, installs happily, and fails on somebody
 * else's machine with "cannot load". Nothing in a build log says so, because
 * from the build's point of view everything worked.
 */

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const workflow = read('.github/workflows/release.yml');
const validation = read('.github/workflows/platform-packaging.yml');
// What a published release does on somebody else's machine, which nothing
// before it can answer: everything else proves a package a run just built.
const qualification = read('.github/workflows/release-qualification.yml');
const macosAction = read('.github/actions/macos-package/action.yml');
const ubuntuAction = read('.github/actions/ubuntu-package/action.yml');
// The proofs themselves live in scripts the actions call, so that a failure can
// be run locally and so that its output can reach an annotation.
const macosProof = read('.github/scripts/prove-macos-package.sh');
const ubuntuProof = read('.github/scripts/prove-ubuntu-package.sh');
const VERSION = '9.9.9';

/**
 * Every job's own text, keyed by its name.
 *
 * A workflow read as one string answers "does this appear somewhere", which is
 * the question that let an attestation step name paths belonging to a different
 * job and pass for a release and a half.
 */
function jobs(text: string): Record<string, string> {
  const body = text.slice(text.indexOf('\njobs:'));
  const headers = [...body.matchAll(/^ {2}([a-z][a-z0-9-]*):\r?$/gm)];
  const found: Record<string, string> = {};
  headers.forEach((match, at) => {
    const from = match.index ?? 0;
    const to = at + 1 < headers.length ? (headers[at + 1]!.index ?? body.length) : body.length;
    found[match[1]!] = body.slice(from, to);
  });
  return found;
}

/** The entries of a `key: |` block: every line indented past the key. */
function block(text: string, key: string): string[] {
  const at = text.indexOf(`${key}: |`);
  if (at < 0) return [];
  const lines = text.slice(at).split(/\r?\n/).slice(1);
  const indent = (line: string) => line.length - line.trimStart().length;
  const depth = indent(lines[0] ?? '');
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    if (indent(line) < depth) break;
    out.push(line.trim());
  }
  return out;
}

describe('the release builds every platform from one tag', () => {
  it('has a job for each, and publish waits for all of them', () => {
    const jobs = [...workflow.slice(workflow.indexOf('\njobs:')).matchAll(/^ {2}([a-z][a-z0-9-]*):\r?$/gm)].map((m) => m[1]);
    expect(jobs).toEqual(['validate', 'build', 'macos', 'ubuntu', 'publish', 'qualify']);
    expect(workflow).toContain('needs: [build, macos, ubuntu]');
  });

  it('names runner labels that GitHub still has', () => {
    // Read off the file rather than trusted from a comment, and named exactly
    // rather than through `macos-latest`, which moves between major versions
    // *and* between architectures -- which is the opposite of what a job whose
    // whole purpose is to be on a particular architecture wants.
    //
    // These two were `macos-14` and `macos-13` until it turned out `macos-13`
    // had been retired in December 2025 and `macos-14` deprecated. The release
    // workflow had never run since they were written, so it was asking for a
    // runner that no longer answers and nothing said so.
    for (const file of [workflow, validation, qualification]) {
      expect(file).toMatch(/runner: macos-15, arch: arm64/);
      expect(file).toMatch(/runner: macos-15-intel, arch: x64/);
      expect(file).toMatch(/runner: ubuntu-24\.04, arch: amd64/);
      expect(file).toMatch(/runner: ubuntu-24\.04-arm, arch: arm64/);
    }
  });

  it('asks for no runner image that has been retired', () => {
    // A label that no longer exists does not fail loudly: the job sits waiting
    // for a runner that will never come, or fails with a message about labels
    // rather than about this project.
    const retired = ['macos-11', 'macos-12', 'macos-13', 'ubuntu-18.04', 'ubuntu-20.04'];
    for (const file of [workflow, validation, qualification]) {
      for (const label of retired) {
        // `runs-on:` and matrix entries only -- the strings also appear in
        // prose about what was retired, which is worth keeping.
        expect(file, `${label} is asked for as a runner`).not.toMatch(
          new RegExp(`(runs-on:\\s*${label}\\b|runner: ${label}\\b)`),
        );
      }
    }
  });

  it('builds through the shared actions rather than its own copy of the steps', () => {
    // Two lists of build steps is how one of them stops being true. The release
    // workflow and the packaging validation workflow call the same actions, so
    // what validation proves on every push is what a release ships.
    for (const file of [workflow, validation]) {
      expect(file).toContain('uses: ./.github/actions/macos-package');
      expect(file).toContain('uses: ./.github/actions/ubuntu-package');
    }
    // And neither has grown a second implementation beside the action.
    for (const file of [workflow, validation]) {
      expect(file).not.toContain('build-tarball.sh');
      expect(file).not.toContain('build-deb.sh');
    }
  });

  it('refuses to build if the runner is not the architecture claimed', () => {
    // The guard that turns a matrix typo into a failed build rather than a
    // mislabelled package that installs and cannot run.
    expect(macosAction).toContain('The architecture this runner really is');
    expect(macosAction).toMatch(/arm64:arm64\|x64:x86_64/);
    expect(macosAction).toContain('uname -s');
    expect(ubuntuAction).toContain('dpkg --print-architecture');
  });

  it('proves the bundled runtime starts, on the machine it was built for', () => {
    // A package whose Node cannot start is one that installs and then does
    // nothing, and that is only visible by running it.
    for (const [name, action] of [['macos', macosProof], ['ubuntu', ubuntuProof]] as const) {
      expect(action, `${name} does not reference its own runtime`).toContain('runtime/node/bin/node');
      expect(action, `${name} does not run it`).toContain('--version');
      expect(action, `${name} does not check process.arch`).toContain('process.arch');
      expect(action, `${name} does not prove tsx transforms`).toContain('tsx ok');
      // `file` rather than the runtime's own opinion: a translated binary
      // reports the architecture you asked about, not the one it is.
      expect(action, `${name} trusts the runtime about its own architecture`).toContain('file -b');
      // The native module that shipped wrong four times.
      expect(action, `${name} does not check esbuild`).toContain('@esbuild');
    }
  });

  it('lints the package and proves it removes cleanly', () => {
    expect(ubuntuAction).toContain('lintian --fail-on error');
    expect(ubuntuProof).toContain('apt-get purge -y -qq ai17z');
    // And that a purge is not allowed to take the owner's data with it.
    expect(ubuntuProof).toContain('purge took the owner');
  });

  it('runs its proof through something that reports what failed', () => {
    // A failure inside a composite action reaches anybody who cannot read
    // Actions logs as "Process completed with exit code 1" and nothing else.
    for (const action of [macosAction, ubuntuAction]) {
      expect(action).toContain('say-on-fail.sh');
      expect(action).toMatch(/trap 'printf "::error::/);
    }
  });

  it('scans the finished artifact rather than the staging directory', () => {
    // A stage is what the packager was handed; a package is what it produced,
    // after npm ci has run and after a postinstall has fetched a binary.
    for (const action of [macosAction, ubuntuAction]) {
      expect(action).toContain('scan-artifact.sh');
    }
  });

  it('scans the Windows package too, where the release can reach it', () => {
    // The release notes say every published package is unpacked and scanned.
    // The Windows one was scanned by nothing: its build job runs on Windows,
    // where the scanner's tools are not all there, so the check lives in the
    // publish job -- on Linux, over the bytes about to be attached.
    const scanner = read('.github/scripts/scan-artifact.sh');
    expect(scanner).toContain('windows)');
    expect(scanner).toContain('unzip -q');

    const publish = jobs(workflow).publish!;
    const from = publish.indexOf("- name: Nothing of an owner's is in anything published");
    const to = publish.indexOf('- name: The release manifest');
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const scanning = publish.slice(from, to);
    for (const call of [
      'scan-artifact.sh "$zip" windows',
      'scan-artifact.sh "$tarball" macos',
      'scan-artifact.sh "$deb" ubuntu',
    ]) {
      expect(scanning, `the publish job never runs: ${call}`).toContain(call);
    }
    // One Windows zip, two Macs, two Debian packages. Counted, because a glob
    // that matched nothing is a loop that runs nothing and a step that passes.
    expect(scanning).toContain('[ "$scanned" -eq 5 ]');
  });

  it('scans after the artifacts have been flattened, not before', () => {
    // `download-artifact` puts each job's output in its own folder, and the
    // checksums step is what flattens them. A scan above it would glob nothing
    // -- which is exactly how the attestation step attested nothing.
    const publish = jobs(workflow).publish!;
    expect(publish.indexOf('- name: Checksums')).toBeLessThan(
      publish.indexOf("- name: Nothing of an owner's is in anything published"),
    );
  });

  it('publishes every platform asset, named the one way they are named', () => {
    const files = workflow.slice(workflow.lastIndexOf('files: |'));
    const end = files.indexOf('\n\n');
    const list = end > 0 ? files.slice(0, end) : files;
    for (const glob of [
      'dist/AI17Z-macos-*.tar.gz',
      'dist/ai17z_*.deb',
      'dist/install-ai17z-macos.sh',
      'dist/install-ai17z-ubuntu.sh',
      'dist/release-manifest.json',
    ]) {
      expect(list, `${glob} is not attached to the release`).toContain(glob);
    }
    // And the globs match what the shared module composes.
    expect(macosPackageAsset(VERSION, 'arm64')).toMatch(/^AI17Z-macos-.*\.tar\.gz$/);
    expect(ubuntuPackageAsset(VERSION, 'x64')).toMatch(/^ai17z_.*\.deb$/);
    expect(list).toContain(`dist/${installerScriptAsset('macos')}`);
    expect(list).toContain(`dist/${installerScriptAsset('ubuntu')}`);
  });

  it('hashes every platform asset', () => {
    const checksums = workflow.slice(workflow.indexOf('- name: Checksums'), workflow.indexOf('- name: The release manifest'));
    for (const needed of ['AI17Z-macos-*.tar.gz', 'ai17z_*.deb', 'install-ai17z-macos.sh', 'install-ai17z-ubuntu.sh']) {
      expect(checksums, `${needed} is published without a hash`).toContain(needed);
    }
    expect(windowsPackageAsset(VERSION)).toMatch(/^AI17Z-App-.*\.zip$/);
  });

  it('builds the manifest from what is about to be published', () => {
    // After the checksums exist, out of the directory the release is attached
    // from, so its hashes are the ones somebody will get.
    expect(workflow.indexOf('- name: Checksums')).toBeLessThan(workflow.indexOf('- name: The release manifest'));
    expect(workflow).toContain('tools/release-manifest.mts');
  });

  /**
   * The release, qualified after it exists.
   *
   * Every other check in this repository proves a package a run has just built.
   * That is the right thing to gate on and it cannot answer one question: does
   * the thing that was *published* install on somebody else's machine. Beta
   * 1.0.0 (16) is why the question is worth asking -- it went out claiming
   * build provenance it did not have, and nothing looked.
   */
  describe('qualifying a release after it is published', () => {
    it('starts by itself, the moment a release exists', () => {
      // Not `workflow_dispatch`. Nothing here may depend on somebody
      // remembering, for the same reason platform packaging runs on a push.
      expect(qualification).toContain('release:');
      expect(qualification).toContain('types: [published]');
      // And a way to run it again against a release that already exists.
      expect(qualification).toContain("- 'qualify-v*'");
    });

    it('can change nothing about a release', () => {
      // It reads published bytes and installs them on a runner. A workflow that
      // could edit the release it is checking is one whose report is worth
      // less.
      const permissions = qualification.slice(qualification.indexOf('permissions:'));
      expect(permissions.slice(0, 60)).toContain('contents: read');
      expect(qualification).not.toContain('contents: write');
      expect(qualification).not.toContain('action-gh-release');
    });

    it('checks out the tag for what it compares, and itself for what compares', () => {
      // Two checkouts in every job, and the difference is the point.
      //
      // One checkout at the tag looked right and was not: the scripts doing the
      // checking were frozen at the release, so a bad assertion in the macOS
      // qualifier failed both Macs for Beta 1.0.0 (17) with no way to correct
      // it except by making another release. The tooling is now the workflow's
      // own ref; the tag supplies only the installers being compared, which is
      // a question about the release and has to be asked of its own commit.
      for (const [job, text] of Object.entries(jobs(qualification))) {
        if (!text.includes('actions/checkout@v4')) continue;
        const checkouts = text.split('actions/checkout@v4').slice(1);
        expect(checkouts.length, `${job} does not check out twice`).toBe(2);
        // The first names nothing: it is this workflow's own commit.
        expect(checkouts[0]!.slice(0, 120)).not.toContain('ref:');
        // The second is the tag, kept apart so nothing confuses the two.
        expect(checkouts[1]!.slice(0, 200)).toContain('ref: ${{ needs.which.outputs.tag }}');
        expect(checkouts[1]!.slice(0, 200)).toContain('path: tagged');
      }
    });

    /**
     * The retry that could never once have fired.
     *
     * Two releases in a row failed a qualification job on the same thing, and
     * the second one showed why the guard against it did not work. Beta 4.6's
     * Windows job reported `install.ps1 -WhatIfOnly exited 1:` with nothing
     * after the colon, and no retry ran.
     *
     * install.ps1 says everything through Write-Host, which writes to the
     * information stream, and `2>&1` merges stderr and nothing else. Measured
     * rather than reasoned about: the same script block captured with `2>&1`
     * yields an empty string and with `*>&1` yields its output. So the text
     * was empty on every run the job has ever done, the annotation could never
     * carry a reason, and a retry conditional on finding (403), (409) or (429)
     * in that text was unreachable code wearing the shape of a safeguard.
     *
     * A retry has to turn on the thing that failed, which is the attempt.
     */
    /**
     * Qualification must not depend on anonymous API luck.
     *
     * The published installer resolves a release through api.github.com without
     * a token, because that is what a stranger runs. A hosted runner shares its
     * address, the anonymous budget is sixty an hour, and twice in three
     * releases that budget was gone: the job failed, the owner pressed re-run,
     * and the release had been correct the whole time. The Intel Mac installed
     * it from the same URLs while the arm64 one was refused.
     *
     * So the two questions were separated. Whether the published package is
     * correct is answered from the tag's own addresses and no API at all.
     * Whether a stranger's route still works is answered too, and reported,
     * but a shared ceiling is not allowed to decide it.
     */
    it('proves the package from the tag rather than from an API lookup', () => {
      for (const script of [
        read('.github/scripts/qualify-published-macos.sh'),
        read('.github/scripts/qualify-published-ubuntu.sh'),
      ]) {
        // The asset by its exact published address, which contains the tag.
        expect(script).toContain('curl -fsSL -o "$ROOM/$PACKAGE" "$DL/$PACKAGE"');
        // Checked against the hash that same tag published.
        expect(script).toContain('"$ROOM/SHA256SUMS.txt"');
        expect(script).toContain('the package hashes $got and SHA256SUMS.txt says');
        // And installed from those bytes, with no release resolution involved.
        expect(script).toContain('installing that exact package, with no network lookup at all');
        /*
          Through the installer with the package it already has, never a raw
          package manager. Beta 4.8 used `dpkg -i` directly, which skipped the
          installer's own handling including `--no-start`, so the package's
          checks ran against a machine whose Docker had not been started and
          failed on something the qualifier was never asking about.
        */
        expect(script).toContain('--package "$ROOM/$PACKAGE" --sha256 "$want"');
        expect(script).not.toMatch(/sudo dpkg -i "\$ROOM/);
      }
      // The Windows job's gate is the pair of hash comparisons it already had,
      // both against the tag, and it now has a token so the parts that do ask
      // GitHub are not competing for the anonymous budget.
      const windows = jobs(qualification).windows!;
      expect(windows).toContain('GITHUB_TOKEN: ${{ github.token }}');
      expect(windows).toContain('the release says $want');
    });

    it('asks for the asset by the name the manifest composes', () => {
      /*
        The qualifiers compose the asset name in shell, because a shell script
        cannot import TypeScript. That is one implementation more than the rule
        allows, so the two are held against each other here: if they drift, the
        deterministic gate asks for a file the release does not publish and the
        job fails for a reason that has nothing to do with the package.

        The same reasoning as the installers already in this file.
      */
      const macos = read('.github/scripts/qualify-published-macos.sh');
      const ubuntu = read('.github/scripts/qualify-published-ubuntu.sh');

      // What the scripts build, with their own variable names.
      expect(macos).toContain('PACKAGE="AI17Z-macos-$ARCH-$VERSION.tar.gz"');
      expect(ubuntu).toContain('PACKAGE="ai17z_${VERSION}_${ARCH}.deb"');

      // And what the one implementation produces for the same inputs.
      expect(macosPackageAsset(VERSION, 'arm64')).toBe(`AI17Z-macos-arm64-${VERSION}.tar.gz`);
      expect(macosPackageAsset(VERSION, 'x64')).toBe(`AI17Z-macos-x64-${VERSION}.tar.gz`);
      expect(ubuntuPackageAsset(VERSION, 'x64')).toBe(`ai17z_${VERSION}_amd64.deb`);
      expect(ubuntuPackageAsset(VERSION, 'arm64')).toBe(`ai17z_${VERSION}_arm64.deb`);

      // The scripts derive VERSION from the tag and ARCH from the machine, so
      // neither can quietly become something else.
      for (const script of [macos, ubuntu]) expect(script).toContain('VERSION="${TAG#v}"');
      expect(macos).toContain('ARCH="$(uname -m)"');
      expect(ubuntu).toContain('ARCH="$(dpkg --print-architecture)"');
    });

    it('keeps the stranger route, bounded, and does not let it decide', () => {
      for (const script of [
        read('.github/scripts/qualify-published-macos.sh'),
        read('.github/scripts/qualify-published-ubuntu.sh'),
      ]) {
        // Still run, because it is the route people actually use.
        expect(script).toContain('the anonymous route a stranger actually takes');
        // Exactly two attempts, with one wait between them.
        expect(script.match(/^\s*wait_for_the_ceiling$/gm)?.length).toBe(1);
        expect(script.match(/smoke_code=\$\?/g)?.length).toBe(2);
        // The verdict is the shared one, not a fresh text match per script.
        expect(script).toContain('qualify-attempt-verdict.sh');
        expect(script).toContain('attempt_verdict "$smoke_code" "$smoke"');
        // A ceiling is said out loud and counted as neither pass nor fail.
        expect(script).toContain('shared hourly');
        // Anything else still fails the job, so a broken installer cannot hide
        // behind the excuse that saved a rate-limited one.
        expect(script).toContain('failed for something other than the API ceiling');
      }
      const windows = jobs(qualification).windows!;
      expect(windows).toContain('::notice::');
      expect(windows).toContain('shared hourly ceiling');
      /*
        The ceiling decides how a failure is reported, never whether the retry
        happens. Those were transposed once: the test was attached to the retry
        branch, so a refused runner printed a notice, skipped its retry and then
        fell into the throw below it, and the job both excused the failure and
        failed. Beta 4.8 went out that way.

        So the retry turns on the exit status alone, and the ceiling is asked
        only inside the branch that has already established the second attempt
        failed too.
      */
      // The retry branch is the first of the two, and it must not mention the
      // ceiling at all: it turns on the exit status alone.
      const firstBranch = windows.slice(
        windows.indexOf('$result = Invoke-Once'),
        windows.indexOf('if ($result.Code -ne 0) {', windows.indexOf('Start-Sleep -Seconds 90')),
      );
      expect(firstBranch).toContain('Start-Sleep -Seconds 90');
      expect(firstBranch).not.toContain('::notice::');
      expect(firstBranch).not.toContain('-match $ceiling');
      // And the reporting branch is an if/else, so exactly one of the two runs.
      expect(windows).toContain('if ($result.Text -match $ceiling) {');
      expect(windows).toContain('else {');
    });

    it('stops at the cause rather than reporting its consequences', () => {
      /*
        Everything after the install asks the installed copy about itself, so a
        runner that never installed anything reported fourteen failures for one
        fact. Measured on Beta 4.7: "5 passed, 14 failed" for a release the
        other Mac installed perfectly from the same URLs.
      */
      for (const script of [
        read('.github/scripts/qualify-published-macos.sh'),
        read('.github/scripts/qualify-published-ubuntu.sh'),
      ]) {
        expect(script).toContain('finish()');
        // Every path that establishes there is nothing installed stops there.
        expect(script.match(/^\s*finish$/gm)?.length ?? 0).toBeGreaterThanOrEqual(3);
      }
    });

    it('says which kind of failure it was, rather than assuming one', () => {
      // A runner's shared sixty-an-hour ceiling says nothing about the
      // release. Anything else is a finding about what was published. Both
      // fail, and the report has to tell somebody which they are looking at,
      // because the two need opposite responses: re-run the job, or stop the
      // release.
      const windows = jobs(qualification).windows!;
      // A refusal the runner could not help is reported and not counted.
      expect(windows).toContain('shared hourly ceiling');
      // Anything else is a failure, and says it was not the runner's fault.
      expect(windows).toContain("not for anything this runner could blame on GitHub");
      // An attempt that printed nothing at all still gets said out loud, which
      // is the case that started this.
      expect(windows).toContain("(it printed nothing at all)");

      for (const script of [
        read('.github/scripts/qualify-published-macos.sh'),
        read('.github/scripts/qualify-published-ubuntu.sh'),
      ]) {
        expect(script).toContain('why_it_failed()');
        expect(script).toContain('sixty-an-hour ceiling');
        expect(script).toContain('a finding about what was published');
      }
    });

    it('refuses a rehearsal, which published nothing to qualify', () => {
      expect(qualification).toContain('rehearsal-*)');
    });

    it('reaches both Macs, both Ubuntus, and Windows', () => {
      const names = Object.keys(jobs(qualification));
      expect(names).toEqual(['which', 'published', 'macos', 'ubuntu', 'windows']);
    });

    it('takes the installers off the release rather than out of the checkout', () => {
      // The whole point. An installer read from the checkout proves the
      // checkout; this proves what a stranger is handed.
      for (const script of [
        read('.github/scripts/qualify-published-macos.sh'),
        read('.github/scripts/qualify-published-ubuntu.sh'),
      ]) {
        expect(script).toContain('releases/download');
        expect(script).toContain('SHA256SUMS.txt');
        // And then says so if the two disagree, which would mean the release
        // was assembled from something that is not this commit.
        expect(script).toContain('byte for byte the script this checkout holds');
      }
    });
  });

  it('does not mistake a rehearsal tag for the previous release', () => {
    // `git describe` answers with the *nearest* tag, and a rehearsal tag sits on
    // the commit that was rehearsed -- an ancestor of the one being released.
    // So without a filter the changelog reads "what changed since
    // rehearsal-v1.0.0-beta.17" and lists the two commits since it.
    //
    // Demonstrated on this repository rather than reasoned about: asked for the
    // nearest tag to the commit below v1.0.0-beta.17, `git describe` answered
    // `rehearsal-v1.0.0-beta.17` without the filter and `v1.0.0-beta.16` with
    // it. Adding a second kind of tag is what made a filter necessary.
    const notes = workflow.slice(workflow.indexOf('- name: Release notes'));
    expect(notes).toContain("git describe --tags --abbrev=0 --match 'v[0-9]*'");
  });

  it('asks what was published, because nothing else is going to', () => {
    // The obvious wiring does not work, and looked as though it did. A release
    // created with GITHUB_TOKEN raises no event that can start a workflow, so
    // `release: published` never fired for a release this repository made:
    // Beta 1.0.0 (17) went out and the qualification workflow sat there. Caught
    // by looking for the run afterwards rather than assuming it, which is the
    // same way the attestation that globbed an empty directory was caught.
    //
    // So the release calls it, as its own last job.
    const qualify = jobs(workflow).qualify!;
    expect(qualify).toContain('uses: ./.github/workflows/release-qualification.yml');
    expect(qualify).toContain('needs: [build, publish]');
    // It reads, and cannot write. What checks a release must not change one.
    expect(qualify).toContain('contents: read');
    // And it is told which tag rather than deriving one.
    expect(qualify).toContain('tag: ${{ github.ref_type == ');
    // A rehearsal published nothing, so there is nothing to qualify.
    expect(qualify).toContain("startsWith(github.ref_name, 'rehearsal-')");

    // Which means the qualification workflow has to be callable.
    expect(qualification).toContain('workflow_call:');
    const which = jobs(qualification).which!;
    expect(which).toContain('${{ inputs.tag }}');
  });

  it('can rehearse the whole release without publishing one', () => {
    // `dry_run` does this too and needs `workflow_dispatch`, which needs a
    // browser or an authenticated CLI. A tag is something a push can do, and
    // the reason to want one is that the publish job's newest steps had never
    // executed at all -- it ran `npx tsx` with no `npm ci` anywhere in the job.
    expect(workflow).toContain("- 'rehearsal-v*'");

    // Exactly one step in this workflow creates a release.
    expect(workflow.match(/softprops\/action-gh-release/g)).toHaveLength(1);
    const publish = jobs(workflow).publish!;
    const step = publish.slice(publish.indexOf('- name: Publish'));
    expect(step).toContain('softprops/action-gh-release');
    // And it is off for both kinds of rehearsal.
    expect(step).toContain(
      "if: ${{ !((github.event_name == 'workflow_dispatch' && inputs.dry_run) || startsWith(github.ref_name, 'rehearsal-')) }}",
    );

    // A rehearsal builds the version its tag names, on every platform, or it
    // is a rehearsal of something else.
    expect(workflow).toContain('v="${GITHUB_REF_NAME#rehearsal-}"');
    expect(workflow).toContain("-replace '^(rehearsal-)?v', ''");
    // Both platform jobs, not one of them.
    expect(workflow.match(/GITHUB_REF_NAME#rehearsal-/g)).toHaveLength(2);

    // And what it found has to be readable. Actions logs need admin rights on
    // the repository -- the API answers 403 and so does the web interface --
    // so a rehearsal whose whole value is what it printed reaches almost
    // nobody unless it also becomes an annotation.
    const report = workflow.slice(workflow.indexOf('- name: What a real run would have published'));
    expect(report.slice(0, 2000)).toContain('say-out.sh');
  });

  it('installs dependencies in every job that runs one of this repository\'s tools', () => {
    // `tools/release-manifest.mts` imports `@xbam/shared`, which resolves only
    // through the workspace symlinks `npm ci` writes. The publish job ran it
    // with neither a Node setup nor an install, so the step ended in
    // ERR_MODULE_NOT_FOUND -- and because that step is newer than the last
    // release, it had never once run. A release would have been the first
    // thing to find out.
    for (const [name, file] of [
      ['release', workflow],
      ['platform packaging', validation],
    ] as const) {
      for (const [job, text] of Object.entries(jobs(file))) {
        if (!/npx |npm run /.test(text)) continue;
        expect(text, `${name}: the ${job} job runs a tool without setting up Node`).toContain('actions/setup-node');
        expect(text, `${name}: the ${job} job runs a tool without installing dependencies`).toContain('npm ci');
        // And in that order: an install before the thing that needs it.
        expect(text.indexOf('npm ci'), `${name}: the ${job} job installs after it runs`).toBeLessThan(
          Math.min(
            ...[text.indexOf('npx '), text.indexOf('npm run ')].filter((at) => at >= 0),
          ),
        );
      }
    }
  });

  it('builds the manifest against a complete asset set, never a directory listing', () => {
    // The generator described whatever it found, so a release short one of the
    // four packages would have published a manifest saying that platform was
    // unsupported -- correct about the directory, and wrong about the release.
    const publish = jobs(workflow).publish!;
    const call = publish.slice(
      publish.indexOf('tools/release-manifest.mts'),
      publish.indexOf('cat dist/release-manifest.json'),
    );
    expect(call.length).toBeGreaterThan(0);
    // A release publishes all three platforms, so it must narrow nothing.
    const narrowed = /--expect ([a-z,]+)/.exec(call)?.[1];
    expect(narrowed ? narrowed.split(',').sort() : [...PLATFORMS].sort()).toEqual([...PLATFORMS].sort());

    // Validation never builds a Windows artifact, and says which two it owes
    // rather than being told a release is broken on every push.
    expect(validation).toContain('--expect macos,ubuntu');
    // Which needs the two readable installers in the directory, exactly as the
    // release copies them in, or the set it claims to expect is not there.
    expect(validation).toContain('cp install-ai17z-macos.sh install-ai17z-ubuntu.sh dist/');
  });

  it('attests provenance without calling it something it is not', () => {
    expect(workflow).toContain('actions/attest-build-provenance');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('attestations: write');
    // The claim is repository and workflow provenance. Saying otherwise would
    // be the one dishonest line in a release.
    const step = workflow.slice(workflow.indexOf('- name: Attest what was built'));
    expect(step.slice(0, 900)).toMatch(/not\*\* Apple notarization/);
  });

  /**
   * The three things that were wrong with the first version of that step, as
   * three properties rather than as a comment.
   *
   * It ran in the Windows build job and named `dist/` paths. That job writes to
   * `build/windows` and has never had a `dist`, so every glob matched nothing;
   * the action failed; and `continue-on-error: true` painted the step green.
   * Beta 1.0.0 (16) was published saying it carried build provenance, and every
   * one of its assets answers 404 from the attestations API.
   */
  it('attests in the job that actually holds the artifacts', () => {
    const byJob = jobs(workflow);
    const attesting = Object.entries(byJob)
      .filter(([, text]) => text.includes('actions/attest-build-provenance'))
      .map(([name]) => name);
    expect(attesting).toEqual(['publish']);

    const publish = byJob.publish!;
    const subjects = block(publish, 'subject-path');
    expect(subjects.length).toBeGreaterThan(0);
    // And the directory has to be one this job makes: `download-artifact` puts
    // every platform's output in `dist`, and nothing else here creates one.
    expect(publish).toContain('path: dist');
    for (const subject of subjects) {
      expect(subject.startsWith('dist/'), `${subject} is not in a directory this job has`).toBe(true);
    }
  });

  it('signs for every file it publishes out of dist', () => {
    const publish = jobs(workflow).publish!;
    // RELEASE_VALIDATION_REPORT.md is checked in rather than built, so it is
    // published from the checkout and is deliberately not a build subject.
    const published = block(publish, 'files').filter((entry) => entry.startsWith('dist/'));
    expect(published.length).toBeGreaterThan(0);
    expect(new Set(block(publish, 'subject-path'))).toEqual(new Set(published));
  });

  it('will not let the attestation fail quietly', () => {
    const job = jobs(workflow).publish!;
    const step = job.slice(job.indexOf('- name: Attest what was built'), job.indexOf('- name: Release notes'));
    // As a key, not as a word: the step's own comment explains the failure
    // this replaced, and says `continue-on-error: true` in doing so.
    expect(step.split(/\r?\n/).filter((line) => /^\s*continue-on-error:/.test(line))).toEqual([]);
    // Before the release exists rather than after it, so a release that cannot
    // be attested is one that does not get published.
    expect(job.indexOf('- name: Attest what was built')).toBeLessThan(job.indexOf('- name: Publish'));
  });

  it('pins one Node for every platform', () => {
    // Two packages built against different runtimes is a difference nobody
    // would find until one of them behaved differently.
    const runtime = JSON.parse(read('packaging/node-runtime.json')) as { version: string };
    expect(runtime.version).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(macosAction + ubuntuAction).toContain("require('./packaging/node-runtime.json').version");
    // And it is the line the rest of the project already requires.
    const engines = JSON.parse(read('package.json')) as { engines?: { node?: string } };
    const major = Number.parseInt(runtime.version.replace(/^v/, '').split('.')[0]!, 10);
    expect(String(major)).toBe((engines.engines?.node ?? '>=22').replace(/[^\d]/g, ''));
  });

  /**
   * A dry run builds everything and publishes nothing.
   *
   * This workflow reaches four runners, two of them macOS, which nothing on a
   * developer's machine can. Before this input the only way to find out whether
   * it worked was to publish and see -- a release used as the test, with
   * somebody else's machine as the test bed, which this repository has already
   * paid for six times.
   *
   * The property worth pinning is not that the input exists. It is that the
   * publishing step cannot run when it is set, and that it still runs on an
   * ordinary tag push, where `inputs` does not exist at all.
   *
   * There is a second way in, for the same reason a second way was needed at
   * all: `workflow_dispatch` wants a browser or an authenticated CLI, and a
   * push can only push. A `rehearsal-v*` tag runs everything and publishes
   * nothing, so the same condition has to hold for it.
   */
  describe('a dry run', () => {
    it('is offered, and defaults to off', () => {
      const dispatch = workflow.slice(workflow.indexOf('workflow_dispatch:'), workflow.indexOf('permissions:'));
      expect(dispatch).toContain('dry_run:');
      expect(dispatch).toMatch(/dry_run:[\s\S]*?default: false/);
    });

    it('cannot publish, and a tag push still can', () => {
      const at = workflow.search(/^ *- name: Publish$/m);
      expect(at).toBeGreaterThan(-1);
      const step = workflow.slice(at, at + 900);
      const guard = step.match(/if: \$\{\{([^}]+)\}\}/);
      expect(guard).not.toBeNull();
      const condition = guard![1]!.trim();
      // A negation of everything that is a rehearsal, so an ordinary tag push
      // -- which has no `inputs` at all -- falls straight through it.
      expect(condition.startsWith('!(')).toBe(true);
      // Both halves of the dispatch case. `!inputs.dry_run` on its own is true
      // for a tag push, which is right, and reads as "not set" for a dispatch
      // that did set it only because GitHub coerces -- so the event is named
      // rather than relied on.
      expect(condition).toContain("github.event_name == 'workflow_dispatch'");
      expect(condition).toContain('inputs.dry_run');
      // And the other kind of rehearsal, which is a tag and would otherwise
      // reach exactly the path a release does.
      expect(condition).toContain("startsWith(github.ref_name, 'rehearsal-')");
    });

    it('leaves something to look at, since nothing is published', () => {
      // A dry run that proves the build and then throws the result away has
      // proved the build and nothing about what it produced.
      const at = workflow.indexOf('- name: Keep them, so a dry run can be inspected');
      expect(at).toBeGreaterThan(-1);
      expect(workflow.slice(at, at + 400)).toContain('actions/upload-artifact');
      // Before the publish step, so a real run is not slowed by it and a dry
      // run reaches it at all.
      expect(at).toBeLessThan(workflow.search(/^ *- name: Publish$/m));
    });
  });


  it('stages at the version it is building, not the one in the checkout', () => {
    // The build scripts are handed the version as a flag, so a package is
    // *named* after the tag. The stager wrote `package.json`'s version into
    // BUILD_INFO.json, and the two agree only because the convention is to bump
    // package.json with the tag. The day somebody tags first, a package would
    // be named one version and report another -- and the only thing that would
    // notice is a check nobody runs on the published bytes.
    expect(read('tools/package-unix.mts')).toContain('process.env.AI17Z_VERSION');
    expect(read('tools/package-windows.mts')).toContain('process.env.AI17Z_VERSION');
    for (const action of [macosAction, ubuntuAction]) {
      expect(action).toMatch(/AI17Z_VERSION: \$\{\{ inputs\.version \}\}/);
    }
  });

});
