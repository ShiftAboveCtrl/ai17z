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
const VERSION = '9.9.9';

describe('the release builds every platform from one tag', () => {
  it('has a job for each, and publish waits for all of them', () => {
    const jobs = [...workflow.slice(workflow.indexOf('\njobs:')).matchAll(/^ {2}([a-z][a-z0-9-]*):\r?$/gm)].map((m) => m[1]);
    expect(jobs).toEqual(['validate', 'build', 'macos', 'ubuntu', 'publish']);
    expect(workflow).toContain('needs: [build, macos, ubuntu]');
  });

  it('builds each architecture on a runner that really is it', () => {
    // macos-14 is Apple Silicon; macos-13 is Intel. Reading them off the file
    // rather than trusting a comment about them.
    expect(workflow).toMatch(/runner: macos-14, arch: arm64/);
    expect(workflow).toMatch(/runner: macos-13, arch: x64/);
    expect(workflow).toMatch(/runner: ubuntu-latest, arch: amd64/);
    expect(workflow).toMatch(/runner: ubuntu-24\.04-arm, arch: arm64/);
  });

  it('refuses to build if the runner is not the architecture claimed', () => {
    // The guard that turns a matrix typo into a failed build rather than a
    // mislabelled package.
    const macos = workflow.slice(workflow.indexOf('  macos:'), workflow.indexOf('  ubuntu:'));
    expect(macos).toContain('The architecture this runner really is');
    expect(macos).toMatch(/arm64:arm64\|x64:x86_64/);
    const ubuntu = workflow.slice(workflow.indexOf('  ubuntu:'), workflow.indexOf('  publish:'));
    expect(ubuntu).toContain('dpkg --print-architecture');
  });

  it('proves the bundled runtime starts, on the machine it was built for', () => {
    // A package whose Node cannot start is one that installs and then does
    // nothing, and that is only visible by running it.
    for (const job of ['macos', 'ubuntu'] as const) {
      const section = workflow.slice(
        workflow.indexOf(`  ${job}:`),
        job === 'macos' ? workflow.indexOf('  ubuntu:') : workflow.indexOf('  publish:'),
      );
      // The bundled runtime specifically, not whatever node the runner has.
      expect(section, `${job} does not reference its own runtime`).toContain('runtime/node/bin/node');
      expect(section, `${job} does not run it`).toContain('--version');
      expect(section, `${job} does not check process.arch`).toContain("process.arch");
      expect(section, `${job} does not prove tsx transforms`).toContain('tsx ok');
    }
  });

  it('lints the package and fails on an error', () => {
    const ubuntu = workflow.slice(workflow.indexOf('  ubuntu:'), workflow.indexOf('  publish:'));
    expect(ubuntu).toContain('lintian --fail-on error');
    // And proves the package removes cleanly, which is the half of packaging
    // nobody tests until somebody tries it.
    expect(ubuntu).toContain('apt-get purge -y ai17z');
    expect(ubuntu).toContain('purge left files behind');
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

  it('pins one Node for every platform', () => {
    // Two packages built against different runtimes is a difference nobody
    // would find until one of them behaved differently.
    const runtime = JSON.parse(read('packaging/node-runtime.json')) as { version: string };
    expect(runtime.version).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(workflow).toContain("require('./packaging/node-runtime.json').version");
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

});
