import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as load } from 'yaml';
import {
  ARCHITECTURES_OF,
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
 *
 * Every property here was first held of the GitHub workflows this pipeline
 * replaced, and each one was paid for by a release; see the comments beside
 * them. They are held of AI17Z Code's Forgejo workflows now: their YAML, which
 * says which jobs run where and when, and the scripts they call, which say what
 * each step does.
 */

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const packageYml = read('.forgejo/workflows/package.yml');
const releaseYml = read('.forgejo/workflows/release.yml');
const qualifyYml = read('.forgejo/workflows/qualify.yml');
const publish = read('.forgejo/scripts/publish-release.sh');
const notes = read('.forgejo/scripts/release-notes.sh');
const macosBuild = read('.forgejo/scripts/package-macos.sh');
const ubuntuBuild = read('.forgejo/scripts/package-ubuntu.sh');
const windowsBuild = read('.forgejo/scripts/build-windows-release.ps1');
// The proofs themselves live in scripts the builds call, so that a failure can
// be run by hand on a machine of your own before a runner is asked.
const macosProof = read('.forgejo/scripts/prove-macos-package.sh');
const ubuntuProof = read('.forgejo/scripts/prove-ubuntu-package.sh');
const qualifiers = [read('.forgejo/scripts/qualify-published-macos.sh'), read('.forgejo/scripts/qualify-published-ubuntu.sh')];
const windowsQualifier = read('.forgejo/scripts/qualify-published-windows.ps1');
const VERSION = '9.9.9';

type Step = { run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown>; if?: string };
type Job = {
  'runs-on'?: string;
  if?: string;
  needs?: string | string[];
  container?: { image?: string };
  strategy?: { matrix?: { include?: { arch?: string; runner?: string }[] } };
  steps?: Step[];
};
type Workflow = { on: Record<string, { tags?: string[] }>; jobs: Record<string, Job> };
const release = load(releaseYml) as Workflow;
const qualify = load(qualifyYml) as Workflow;
const validation = load(packageYml) as Workflow;
function job(w: Workflow, name: string): Job {
  const own = w.jobs[name];
  if (!own) throw new Error(`no job ${name}`);
  return own;
}
/** Every shell line a job runs, in order. */
const scriptOf = (w: Workflow, name: string) => (job(w, name).steps ?? []).map((step) => step.run ?? '').join('\n');
const needsOf = (j: Job) => (Array.isArray(j.needs) ? j.needs : j.needs ? [j.needs] : []);
/** A section of a script between two of its own headings. */
const between = (text: string, from: string, to: string) => {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + 1);
  expect(a, `no "${from}"`).toBeGreaterThan(-1);
  expect(b, `no "${to}" after "${from}"`).toBeGreaterThan(a);
  return text.slice(a, b);
};

describe('the release builds every platform from one tag', () => {
  it('has a job for each, and publish waits for all of them', () => {
    expect(Object.keys(release.jobs)).toEqual([
      'version',
      'check',
      'package-ubuntu',
      'ubuntu-takes-the-package',
      'package-assembled',
      'package-windows',
      'publish',
      'qualify',
      'qualify-windows',
    ]);
    for (const name of ['package-windows', 'package-ubuntu', 'package-assembled', 'check']) {
      expect(needsOf(job(release, 'publish'))).toContain(name);
    }
    // amd64 natively, and both Macs and arm64 Ubuntu in the one assembled job,
    // so publish waiting for the two waits for every package.
    expect(job(release, 'package-ubuntu').strategy!.matrix!.include!.map((i) => i.arch)).toEqual(['amd64']);
  });

  it('names the runners exactly, and never by a moving alias', () => {
    // Named exactly rather than through a `latest`, which moves between major
    // versions and between architectures: the opposite of what a job whose
    // whole purpose is to be on a particular architecture wants.
    expect(job(release, 'package-ubuntu').strategy!.matrix!.include).toEqual([{ arch: 'amd64', runner: 'ai17z-release-linux' }]);
    expect(job(release, 'package-assembled')['runs-on']).toBe('ai17z-release-linux');
    expect(job(release, 'package-assembled').container?.image).toBe('ubuntu:24.04');
    expect(job(release, 'package-windows')['runs-on']).toBe('ai17z-release-windows');
    expect(job(release, 'package-ubuntu').container?.image).toBe('ubuntu:24.04');
    expect(job(validation, 'ubuntu-amd64').container?.image).toBe('ubuntu:24.04');
  });

  it('asks for no image that has been retired, and builds both Macs from proved natives', () => {
    // A label that no longer exists does not fail loudly: the job sits waiting
    // for a runner that will never come.
    for (const text of [packageYml, releaseYml, qualifyYml]) {
      expect(text).not.toMatch(/image:\s*macos-1[1-3]\b|ubuntu:(18|20)\.04/);
    }
    // Intel is back because nothing about it is relabelled: every native file
    // in it is byte for byte the one an Intel Mac built and ran for v1.0.0-beta.76.
    expect(ARCHITECTURES_OF.macos).toEqual(['arm64', 'x64']);
    const refs = JSON.parse(read('.forgejo/native-references.json')) as Record<string, unknown>;
    for (const arch of ARCHITECTURES_OF.macos) expect(refs[`macos-${arch}`]).toBeTruthy();
    expect(refs['ubuntu-arm64']).toBeTruthy();
  });

  it('builds through the shared scripts rather than its own copy of the steps', () => {
    // Two lists of build steps is how one of them stops being true. A release
    // and a validation run call the same scripts, so what validation proves on
    // a change is what a release ships.
    expect(scriptOf(release, 'package-ubuntu')).toContain('package-ubuntu.sh');
    expect(scriptOf(validation, 'ubuntu-amd64')).toContain('package-ubuntu.sh');
    expect(scriptOf(release, 'package-assembled')).toContain('package-assembled.sh');
    // And no pipeline file has grown a second implementation beside them.
    for (const text of [packageYml, releaseYml]) {
      expect(text).not.toContain('build-tarball.sh');
      expect(text).not.toContain('build-deb.sh');
    }
  });

  it('refuses to build if the runner is not the architecture claimed', () => {
    // The guard that turns a wrong runner into a failed build rather than a
    // mislabelled package that installs and cannot run.
    expect(macosBuild).toContain('the architecture this runner really is');
    expect(macosBuild).toContain('[ "$actual" = arm64 ]');
    expect(macosBuild).toContain('uname -s');
    expect(ubuntuBuild).toContain('dpkg --print-architecture');
  });

  it('keeps the version it is building, whatever the machine calls itself', () => {
    // Sourcing /etc/os-release defines VERSION. It once replaced the version
    // being built with "24.04.4 LTS (Noble Numbat)", found by running the job
    // in a container before any runner was asked.
    expect(ubuntuBuild).toContain('( . /etc/os-release && echo "on Ubuntu ${VERSION_ID}" )');
    expect(ubuntuBuild).not.toMatch(/^\. \/etc\/os-release/m);
  });

  it('proves the bundled runtime starts, on the machine it was built for', () => {
    // A package whose Node cannot start is one that installs and then does
    // nothing, and that is only visible by running it.
    for (const [name, proof] of [['macos', macosProof], ['ubuntu', ubuntuProof]] as const) {
      expect(proof, `${name} does not reference its own runtime`).toContain('runtime/node/bin/node');
      expect(proof, `${name} does not run it`).toContain('--version');
      expect(proof, `${name} does not check process.arch`).toContain('process.arch');
      expect(proof, `${name} does not prove tsx transforms`).toContain('tsx ok');
      // `file` rather than the runtime's own opinion: a translated binary
      // reports the architecture you asked about, not the one it is.
      expect(proof, `${name} trusts the runtime about its own architecture`).toContain('file -b');
      // The native module that shipped wrong four times.
      expect(proof, `${name} does not check esbuild`).toContain('@esbuild');
    }
  });

  it('lints the package and proves it removes cleanly', () => {
    expect(ubuntuBuild).toContain('lintian --fail-on error');
    expect(ubuntuProof).toContain('apt-get purge -y -qq ai17z');
    // And that a purge is not allowed to take the owner's data with it.
    expect(ubuntuProof).toContain('purge took the owner');
  });

  it('runs its proof through something that says what failed, last', () => {
    for (const build of [macosBuild, ubuntuBuild]) {
      expect(build).toContain('say-on-fail.sh');
      expect(build).toMatch(/trap 'echo "line \$LINENO failed: \$BASH_COMMAND"' ERR/);
    }
  });

  it('scans the finished artifact rather than the staging directory', () => {
    // A stage is what the packager was handed; a package is what it produced,
    // after npm ci has run and after a postinstall has fetched a binary.
    for (const build of [macosBuild, ubuntuBuild]) expect(build).toContain('scan-artifact.sh');
  });

  it('scans the Windows package too, where the release can reach it', () => {
    // The release notes say every published package is unpacked and scanned.
    // The Windows one is built on Windows, where the scanner's tools are not
    // all there, so the check lives in the publish job, over the bytes about to
    // be attached.
    const scanner = read('.forgejo/scripts/scan-artifact.sh');
    expect(scanner).toContain('windows)');
    expect(scanner).toContain('unzip -q');
    const scanning = between(publish, 'say "nothing of an owner', 'say "the release manifest"');
    for (const call of ['scan-artifact.sh" "$zip" windows', 'scan-artifact.sh" "$tarball" macos', 'scan-artifact.sh" "$deb" ubuntu']) {
      expect(scanning, `the publish job never runs: ${call}`).toContain(call);
    }
    // Counted, because a glob that matched nothing is a loop that runs nothing
    // and a step that passes. One Windows zip, two Debian packages and two Mac
    // packages, less only those the assembled job refused and named.
    expect(scanning).toContain('expected=$((3 - absent_count)); [ -n "$HAVE_MACOS" ] && expected=$((5 - absent_count))');
    expect(scanning).toContain('[ "$scanned" -eq "$expected" ]');
  });

  it('scans after the artifacts have been flattened, not before', () => {
    // A scan before the flattening would glob nothing, which is exactly how
    // the GitHub attestation step attested nothing for two releases.
    const flatten = publish.indexOf('find . -mindepth 2 -type f -exec cp -n {} . \\;');
    expect(flatten).toBeGreaterThan(-1);
    expect(flatten).toBeLessThan(publish.indexOf('say "checksums"'));
    expect(publish.indexOf('say "checksums"')).toBeLessThan(publish.indexOf('say "nothing of an owner'));
  });

  it('publishes every platform asset, named the one way they are named', () => {
    const installable = between(publish, 'INSTALLABLE=(', 'sha256sum "${INSTALLABLE[@]}"');
    for (const glob of ['ai17z_*.deb', 'install-ai17z-macos.sh', 'install-ai17z-ubuntu.sh', 'AI17Z-macos-*.tar.gz']) {
      expect(installable, `${glob} is not published`).toContain(glob);
    }
    expect(publish).toContain('ASSETS=("${INSTALLABLE[@]}" release-manifest.json');
    // And the globs match what the shared module composes.
    expect(macosPackageAsset(VERSION, 'arm64')).toMatch(/^AI17Z-macos-.*\.tar\.gz$/);
    expect(ubuntuPackageAsset(VERSION, 'x64')).toMatch(/^ai17z_.*\.deb$/);
    expect(installable).toContain(installerScriptAsset('macos'));
    expect(installable).toContain(installerScriptAsset('ubuntu'));
    expect(windowsPackageAsset(VERSION)).toMatch(/^AI17Z-App-.*\.zip$/);
  });

  it('builds the manifest from what is about to be published', () => {
    // After the checksums exist, out of the directory the release is attached
    // from, so its hashes are the ones somebody will get.
    expect(publish.indexOf('say "checksums"')).toBeLessThan(publish.indexOf('say "the release manifest"'));
    expect(publish).toContain('tools/release-manifest.mts');
  });

  it('builds the manifest against a complete asset set, never a directory listing', () => {
    // The generator once described whatever it found, so a release short one
    // package would have published a manifest saying that platform was
    // unsupported: correct about the directory, and wrong about the release.
    const call = between(publish, 'say "the release manifest"', 'cat release-manifest.json');
    // With a Mac package it narrows nothing.
    const withMac = call.slice(call.indexOf('if [ -n "$HAVE_MACOS" ]'), call.indexOf('else'));
    expect(withMac).not.toContain('--expect');
    // Without one it narrows to the two it built, and says why, in the
    // manifest, so the release reads as a decision rather than a loss.
    expect(call).toContain('--expect windows,ubuntu --not-built "$MACOS_NOT_BUILT"');
    expect(publish).toMatch(/MACOS_NOT_BUILT="macOS packages are built on a Mac registered with AI17Z Code/);
    // The readable installers are in the directory exactly as the release
    // publishes them, before anything is hashed.
    expect(publish).toContain('cp "$PROJECT_DIR/install-ai17z-macos.sh" "$PROJECT_DIR/install-ai17z-ubuntu.sh" "$DIST/"');
    expect([...PLATFORMS].sort()).toEqual(['macos', 'ubuntu', 'windows']);
  });

  it('says plainly when a release carries no Mac package', () => {
    expect(notes).toContain('**No macOS package in this release.**');
    expect(notes).toContain('if [ -z "$MACOS" ]; then');
  });

  it('installs dependencies in every job that runs one of this repository\'s tools', () => {
    // `tools/release-manifest.mts` imports `@xbam/shared`, which resolves only
    // through the workspace symlinks `npm ci` writes. A publish job once ran it
    // with no install, and because the step was newer than the last release it
    // had never once run: a release would have been the first to find out.
    const runsTools: [Workflow, string, string][] = [
      [release, 'package-ubuntu', 'package-ubuntu.sh'],
      [validation, 'ubuntu-amd64', 'package-ubuntu.sh'],
      [release, 'package-assembled', 'package-assembled.sh'],
      [release, 'publish', 'publish-release.sh'],
    ];
    for (const [w, name, tool] of runsTools) {
      const text = scriptOf(w, name);
      expect(text, `${name} runs ${tool} without installing dependencies`).toContain('npm ci');
      expect(text.indexOf('npm ci'), `${name} installs after it runs`).toBeLessThan(text.indexOf(tool));
    }
    // Windows installs inside its build script, before the packager.
    expect(windowsBuild.indexOf('npm ci')).toBeLessThan(windowsBuild.indexOf('npm run package:windows'));
  });

  it('pins one Node for every platform', () => {
    // Two packages built against different runtimes is a difference nobody
    // would find until one of them behaved differently.
    const runtime = JSON.parse(read('packaging/node-runtime.json')) as { version: string };
    expect(runtime.version).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(macosBuild + ubuntuBuild).toContain("require('./packaging/node-runtime.json').version");
    // Every job's own Node is that one too, checked against nodejs.org.
    for (const setup of ['setup-ubuntu-job.sh', 'setup-macos-job.sh', 'setup-windows-job.ps1']) {
      const text = read(`.forgejo/scripts/${setup}`);
      expect(text, `${setup} does not read the pinned runtime`).toContain('node-runtime.json');
      expect(text, `${setup} does not check nodejs.org's hashes`).toContain('SHASUMS256.txt');
    }
    // And it is the line the rest of the project already requires.
    const engines = JSON.parse(read('package.json')) as { engines?: { node?: string } };
    const major = Number.parseInt(runtime.version.replace(/^v/, '').split('.')[0]!, 10);
    expect(String(major)).toBe((engines.engines?.node ?? '>=22').replace(/[^\d]/g, ''));
  });

  it('stages at the version it is building, not the one in the checkout', () => {
    // A package is named after the tag. The stager wrote package.json's version
    // into BUILD_INFO.json, and the two agree only because the convention is to
    // bump package.json with the tag. The day somebody tags first, a package
    // would be named one version and report another.
    expect(read('tools/package-unix.mts')).toContain('process.env.AI17Z_VERSION');
    expect(read('tools/package-windows.mts')).toContain('process.env.AI17Z_VERSION');
    for (const build of [macosBuild, ubuntuBuild]) expect(build).toContain('AI17Z_VERSION="$VERSION"');
    expect(windowsBuild).toContain('$env:AI17Z_VERSION = $Version');
  });
});

/**
 * Provenance: what stands in for a signature nobody would grant.
 *
 * Signed with AI17Z's release key into Sigstore's public transparency log.
 * Keyless signing, which GitLab's pipeline identity made possible, needs an
 * identity provider the public Sigstore instance trusts, and it does not trust
 * a self-hosted Forgejo. The first version of the GitHub step ran in a job that
 * did not hold the artifacts, every glob matched nothing, and
 * `continue-on-error` painted it green: Beta 1.0.0 (16) was published saying it
 * carried build provenance while every asset answered 404. So: in the job that
 * holds the files, over every file it publishes, and required.
 */
describe('provenance', () => {
  it('is signed without calling it something it is not', () => {
    expect(publish).toContain('cosign sign-blob --yes --key env://COSIGN_PRIVATE_KEY --bundle "$subject.sigstore.json" "$subject"');
    const step = between(publish, 'say "sign what was built"', 'say "release notes"');
    expect(step).toMatch(/\*\*not\*\* Apple notarization/);
  });

  it('is signed in the job that holds the files, and only there', () => {
    const publishing = (job(release, 'publish').steps ?? []).find((s) => (s.run ?? '').includes('publish-release.sh'))!;
    expect(publishing.env?.COSIGN_PRIVATE_KEY).toBe('${{ secrets.COSIGN_PRIVATE_KEY }}');
    for (const [name, def] of Object.entries(release.jobs)) {
      if (name === 'publish') continue;
      expect(JSON.stringify(def), `${name} names the release key`).not.toContain('COSIGN_PRIVATE_KEY');
    }
  });

  it('verifies against a key that is public and only public', () => {
    const key = read('.forgejo/cosign.pub');
    expect(key.trim().startsWith('-----BEGIN PUBLIC KEY-----')).toBe(true);
    expect(key).not.toMatch(/PRIVATE/);
  });

  it('covers every file it publishes, except what cannot be a build subject', () => {
    // The notes and the validation report are published from the checkout, not
    // built; a bundle is the signature itself.
    expect(publish).toContain('SUBJECTS=("${INSTALLABLE[@]}" release-manifest.json "AI17Z-Setup-Audit-$VERSION.json" SHA256SUMS.txt)');
    expect(publish).toContain('ASSETS=("${INSTALLABLE[@]}" release-manifest.json "AI17Z-Setup-Audit-$VERSION.json" SHA256SUMS.txt release-notes.md)');
    expect(publish).toContain('ASSETS+=(RELEASE_VALIDATION_REPORT.md)');
    expect(publish).toContain('for subject in "${SUBJECTS[@]}"; do ASSETS+=("$subject.sigstore.json"); done');
  });

  it('cannot fail quietly, and is checked before anything is released', () => {
    // No key is a failure, not a skip, and every signature is verified against
    // the committed public key before a draft is even created.
    expect(publish).toContain('[ -n "${COSIGN_PRIVATE_KEY:-}" ] && [ -n "${COSIGN_PASSWORD:-}" ]');
    expect(publish).toContain('set -euo pipefail');
    expect(publish.indexOf('cosign verify-blob')).toBeLessThan(publish.indexOf('say "the release, as a draft"'));
    expect(publish.indexOf('say "sign what was built"')).toBeLessThan(publish.indexOf('say "the release, as a draft"'));
    expect(publish).toContain('--key "$SIGNER_PUB"');
  });

  it('is verified, from the published bytes, by the stranger-facing check', () => {
    const verifier = read('.forgejo/scripts/verify-published-release.sh');
    expect(verifier).toContain('--key "$SIGNER_PUB"');
    expect(verifier).not.toContain('certificate-identity');
    expect(scriptOf(release, 'qualify')).toContain('setup-cosign.sh');
    expect(scriptOf(qualify, 'published-bytes-and-ubuntu')).toContain('setup-cosign.sh');
  });
});

describe('publishing', () => {
  it('builds a draft, attaches each file once, checks the set, and only then publishes', () => {
    const order = ['say "the release, as a draft"', 'say "attach every file, once"', 'say "the attachments are exactly the files"', 'say "publish"'];
    const at = order.map((h) => publish.indexOf(h));
    for (const [i, a] of at.entries()) expect(a, order[i]).toBeGreaterThan(-1);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(publish).toContain('draft: true');
    expect(publish).toContain('--data \'{"draft": false}\'');
  });

  it('refuses a tag that already has a release, rather than adding to it', () => {
    // Forgejo accepts a second attachment with a name a release already has.
    expect(publish).toContain('[ "$existing" = 404 ] || { echo "a release for $TAG already exists');
  });

  it('compares names and sizes both ways, and leaves a mismatch as an unpublished draft', () => {
    expect(publish).toContain('if ! diff expected.tsv attached.tsv; then');
    expect(publish).toContain('it stays a draft and nothing is published');
  });
});

/**
 * The release, qualified after it exists.
 *
 * Every other check proves a package a run has just built. That is the right
 * thing to gate on and it cannot answer one question: does the thing that was
 * *published* install on somebody else's machine.
 */
describe('qualifying a release after it is published', () => {
  it('starts by itself, in the release run, and again on a qualify tag', () => {
    // Not something anybody has to remember. On GitHub a release made with the
    // workflow's own token raised no event, and qualification sat there.
    for (const name of ['qualify', 'qualify-windows']) expect(needsOf(job(release, name))).toContain('publish');
    expect(qualify.on.push!.tags).toEqual(['qualify-v[0-9]*']);
  });

  it('refuses a rehearsal, which published nothing to qualify', () => {
    for (const name of ['qualify', 'qualify-windows']) {
      expect(job(release, name).if).toBe("${{ !startsWith(github.ref_name, 'rehearsal-') }}");
    }
    // And none for a runner that may not exist: Forgejo judges `if` on the
    // runner, so such a job waits for ever and holds the release queue.
    expect(release.jobs['qualify-ubuntu-arm64']).toBeUndefined();
  });

  it('can change nothing about a release', () => {
    // It reads published bytes and installs them. A check that could edit the
    // release it is checking is one whose report is worth less.
    for (const text of [qualifyYml, read('.forgejo/scripts/verify-published-release.sh'), windowsQualifier, ...qualifiers]) {
      expect(text).not.toContain('secrets.');
      expect(text).not.toContain('RELEASE_TOKEN');
      expect(text).not.toContain('attachment=@');
      expect(text).not.toContain('--upload-file');
    }
  });

  it('compares against the tag, with tooling from its own commit', () => {
    // A qualifier frozen at the release once failed both Macs with no way to
    // correct it but another release. The tooling is this pipeline's; the
    // installers compared are the tag's own.
    for (const [w, name] of [[release, 'qualify'], [qualify, 'published-bytes-and-ubuntu']] as const) {
      const text = scriptOf(w, name);
      expect(text).toContain('git archive "$TAG" install.ps1 install-ai17z-ubuntu.sh install-ai17z-macos.sh | tar -x -C tagged');
      expect(text).toContain('"$TAG" "$PWD/tagged"');
    }
    // The tag itself has to be in the checkout for that: the whole history.
    for (const name of ['published-bytes-and-ubuntu', 'ubuntu-arm64', 'windows', 'macos']) {
      expect(JSON.stringify(job(qualify, name).steps), name).toContain('"fetch-depth":0');
    }
    expect(scriptOf(release, 'qualify-windows')).toContain('-Tagged tagged\\install.ps1');
    expect(scriptOf(qualify, 'windows')).toContain('-Tagged tagged\\install.ps1');
  });

  it('proves the package from the tag rather than from an API lookup', () => {
    for (const script of qualifiers) {
      // The asset by its exact published address, which contains the tag.
      expect(script).toContain('curl -fsSL -o "$ROOM/$PACKAGE" "$DL/$PACKAGE"');
      expect(script).toContain('DL="https://code.ai17z.io/$PROJECT/releases/download/$TAG"');
      // Checked against the hash that same tag published.
      expect(script).toContain('the package hashes $got and SHA256SUMS.txt says');
      // And installed from those bytes through the installer, never a raw
      // package manager, which once skipped the installer's own `--no-start`.
      expect(script).toContain('installing that exact package, with no network lookup at all');
      expect(script).toContain('--package "$ROOM/$PACKAGE" --sha256 "$want"');
      expect(script).not.toMatch(/sudo dpkg -i "\$ROOM/);
    }
    expect(windowsQualifier).toContain('the release says $want');
  });

  it('asks for the asset by the name the manifest composes', () => {
    // A shell script cannot import TypeScript, so the name is composed twice and
    // the two are held against each other here.
    const [macos, ubuntu] = qualifiers;
    expect(macos).toContain('PACKAGE="AI17Z-macos-$ARCH-$VERSION.tar.gz"');
    expect(ubuntu).toContain('PACKAGE="ai17z_${VERSION}_${ARCH}.deb"');
    expect(macosPackageAsset(VERSION, 'arm64')).toBe(`AI17Z-macos-arm64-${VERSION}.tar.gz`);
    expect(ubuntuPackageAsset(VERSION, 'x64')).toBe(`ai17z_${VERSION}_amd64.deb`);
    expect(ubuntuPackageAsset(VERSION, 'arm64')).toBe(`ai17z_${VERSION}_arm64.deb`);
    for (const script of qualifiers) expect(script).toContain('VERSION="${TAG#v}"');
    expect(macos).toContain('ARCH="$(uname -m)"');
    expect(ubuntu).toContain('ARCH="$(dpkg --print-architecture)"');
  });

  it('keeps the stranger route, bounded, and does not let it decide', () => {
    for (const script of qualifiers) {
      expect(script).toContain('the anonymous route a stranger actually takes');
      // Exactly two attempts, with one wait between them.
      expect(script.match(/^\s*wait_for_the_ceiling$/gm)?.length).toBe(1);
      expect(script.match(/smoke_code=\$\?/g)?.length).toBe(2);
      expect(script).toContain('qualify-attempt-verdict.sh');
      expect(script).toContain('attempt_verdict "$smoke_code" "$smoke"');
      // A shared limit is said out loud and counted as neither pass nor fail;
      // anything else still fails, so a broken installer cannot hide behind it.
      expect(script).toContain('shared rate');
      expect(script).toContain('failed for something other than the API ceiling');
    }
    // On Windows the retry turns on the exit status alone, and the limit is
    // asked only once the second attempt has failed too. Those were transposed
    // once, and a refused runner both excused the failure and failed.
    const first = between(windowsQualifier, '$result = Invoke-Once', "$ceiling = ");
    expect(first).toContain('Start-Sleep -Seconds 60');
    expect(first).not.toContain('-match $ceiling');
    expect(windowsQualifier).toContain('if ($result.Text -match $ceiling) {');
    expect(windowsQualifier).toContain('} else {');
  });

  it('stops at the cause rather than reporting its consequences', () => {
    // A runner that never installed anything once reported fourteen failures
    // for one fact.
    for (const script of qualifiers) {
      expect(script).toContain('finish()');
      expect(script.match(/^\s*finish$/gm)?.length ?? 0).toBeGreaterThanOrEqual(3);
    }
  });

  it('says which kind of failure it was, rather than assuming one', () => {
    // A shared anonymous limit says nothing about the release. Anything else is
    // a finding about what was published. The two need opposite responses: run
    // the job again, or stop the release.
    expect(windowsQualifier).toContain("not for anything this runner could blame on AI17Z Code");
    expect(windowsQualifier).toContain('(it printed nothing at all)');
    for (const script of qualifiers) {
      expect(script).toContain('why_it_failed()');
      expect(script).toContain('anonymous rate limit');
      expect(script).toContain('a finding about what was published');
    }
  });

  it('reaches every published platform', () => {
    expect(Object.keys(qualify.jobs)).toEqual(['published-bytes-and-ubuntu', 'ubuntu-arm64', 'windows', 'macos']);
    expect(job(qualify, 'ubuntu-arm64')['runs-on']).toBe('ai17z-release-linux-arm64');
    expect(job(qualify, 'macos').if).toBe("vars.AI17Z_MACOS == '1'");
  });

  it('takes the installers off the release rather than out of the checkout', () => {
    for (const script of qualifiers) {
      expect(script).toContain('/releases/download/');
      expect(script).toContain('SHA256SUMS.txt');
      expect(script).toContain('byte for byte the script this checkout holds');
    }
  });
});

describe('a rehearsal', () => {
  it('is a tag, so a push can start one', () => {
    expect(release.on.push!.tags).toEqual(['v[0-9]*', 'rehearsal-v[0-9]*']);
  });

  it('builds the version its tag names, on every platform', () => {
    // One job works the version out and every platform takes it from there,
    // Windows included, so there is no second implementation to disagree.
    expect(read('.forgejo/scripts/release-version.sh')).toContain('v="${TAG#rehearsal-}"');
    expect(scriptOf(release, 'version')).toContain('release-version.sh');
    for (const name of ['package-ubuntu', 'package-assembled', 'package-windows', 'publish']) {
      expect(scriptOf(release, name), name).toContain('needs.version.outputs.version');
    }
  });

  it('cannot publish, and a release still can', () => {
    // Exactly one place creates a release, and a rehearsal leaves before it.
    expect(publish.match(/"\$API\/releases"/g)).toHaveLength(1);
    const exit = publish.indexOf('if [ -n "$REHEARSAL" ]; then');
    expect(exit).toBeGreaterThan(-1);
    expect(exit).toBeLessThan(publish.indexOf('say "the release, as a draft"'));
    expect(publish.slice(exit, publish.indexOf('say "the release, as a draft"'))).toContain('exit 0');
    expect(releaseYml).toContain('bash .forgejo/scripts/publish-release.sh dist "$VERSION" rehearsal');
    expect(releaseYml).toContain('if [ "${GITHUB_REF_NAME#rehearsal-}" != "$GITHUB_REF_NAME" ]; then');
  });

  it('does every step a release does, signing included', () => {
    // A signature is a statement about bytes this pipeline really built, as
    // true of a rehearsal as of a release; a step exercised for the first time
    // by the release it protects is the shape that has cost releases before.
    expect(publish.indexOf('say "sign what was built"')).toBeLessThan(publish.indexOf('if [ -n "$REHEARSAL" ]; then'));
  });

  it('leaves something to look at, since nothing is published', () => {
    const kept = (job(release, 'publish').steps ?? []).find((s) => s.with?.name === 'rehearsal-dist')!;
    expect(kept.with?.path).toBe('dist/');
    expect(kept.if).toBe("startsWith(github.ref_name, 'rehearsal-')");
    expect(publish.slice(publish.indexOf('if [ -n "$REHEARSAL" ]; then'))).toContain('say-out.sh');
  });

  it('does not mistake a rehearsal tag for the previous release', () => {
    // `git describe` answers with the nearest tag, and a rehearsal tag sits on
    // the commit that was rehearsed. Asked on this repository, it answered
    // `rehearsal-v1.0.0-beta.17` without the filter and `v1.0.0-beta.16` with it.
    expect(notes).toContain("git describe --tags --abbrev=0 --match 'v[0-9]*'");
  });
});
