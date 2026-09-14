import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
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
    expect(jobs).toEqual(['validate', 'build', 'macos', 'ubuntu', 'publish']);
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
    for (const file of [workflow, validation]) {
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
    for (const file of [workflow, validation]) {
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
      const step = workflow.slice(at, at + 600);
      const guard = step.match(/if: \$\{\{([^}]+)\}\}/);
      expect(guard).not.toBeNull();
      const condition = guard![1]!;
      // Both halves. `!inputs.dry_run` on its own is true for a tag push, which
      // is right, and reads as "not set" for a dispatch that did set it only
      // because GitHub coerces -- so the event is named rather than relied on.
      expect(condition).toContain("github.event_name != 'workflow_dispatch'");
      expect(condition).toContain('!inputs.dry_run');
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
