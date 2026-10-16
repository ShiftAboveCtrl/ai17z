import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

/**
 * One Node version, in four places that must move together.
 *
 * `package.json` said `>=22`, both Dockerfiles built on `node:22`, the release
 * workflow validated on 22, and CI ran 20. So the only thing testing an
 * unsupported runtime was the thing whose job is to tell us the tests pass, and
 * it was the only one failing. The tests were fine; the runtime was not one
 * anybody ships.
 *
 * The same shape as the Playwright pin: a version spread across files, where
 * one of them drifting produces a failure that never mentions versions.
 */
const REQUIRED_MAJOR = 22;

describe('every place that names a Node version names the same one', () => {
  it('is what package.json requires', () => {
    const pkg = JSON.parse(read('package.json')) as { engines?: { node?: string } };
    expect(pkg.engines?.node).toBe(`>=${REQUIRED_MAJOR}`);
  });

  it('is what CI installs', () => {
    // The check job runs on a Node image, named by its major version.
    const images = [...read('.gitlab/ci/check.yml').matchAll(/image:\s*node:(\d+)/g)].map((m) => m[1]);
    expect(images.length).toBeGreaterThan(0);
    for (const major of images) expect(major).toBe(String(REQUIRED_MAJOR));
  });

  it('is what the release pipeline installs', () => {
    // Every packaging and publishing job installs the runtime every package
    // carries, so that pin is the one that has to agree. Two kinds of job
    // matter: the ones that validate, and the ones that build what somebody
    // downloads.
    const runtime = JSON.parse(read('packaging/node-runtime.json')) as { version: string };
    expect(runtime.version.replace(/^v/, '').split('.')[0]).toBe(String(REQUIRED_MAJOR));
    for (const setup of ['setup-ubuntu-job.sh', 'setup-macos-job.sh', 'setup-windows-job.ps1']) {
      expect(read(`.gitlab/scripts/${setup}`), `${setup} installs some other Node`).toContain('packaging/node-runtime.json'.replace('/', setup.endsWith('.ps1') ? '\\' : '/'));
    }
  });

  it('is what the images are built on', () => {
    for (const dockerfile of ['docker/node.Dockerfile', 'docker/web.Dockerfile']) {
      const bases = [...read(dockerfile).matchAll(/^FROM node:(\d+)/gm)].map((m) => m[1]);
      expect(bases.length, `${dockerfile} has no node base image`).toBeGreaterThan(0);
      for (const base of bases) expect(base, dockerfile).toBe(String(REQUIRED_MAJOR));
    }
  });

  it('is what the release notes tell people to install', () => {
    // The notes are the first thing anybody reads, and they said 20 while the
    // project required 22. Somebody following them would have installed a
    // runtime this does not support and hit failures nothing explained.
    const notes = read('.gitlab/scripts/release-notes.sh');
    const claim = notes.match(/\*\*Node\.js ([\d]+)[^*]*\*\*/);
    expect(claim, 'the release notes no longer name a Node version').not.toBeNull();
    expect(claim![1]).toBe(String(REQUIRED_MAJOR));
  });

  it('is what the types are written against', () => {
    // A @types/node from a different major describes APIs the runtime may not
    // have, which typechecks and then fails where it runs.
    const pkg = JSON.parse(read('package.json')) as { devDependencies?: Record<string, string> };
    expect(pkg.devDependencies?.['@types/node']).toMatch(new RegExp(`^\\^?${REQUIRED_MAJOR}\\.`));
  });
});
