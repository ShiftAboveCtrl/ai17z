import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

/**
 * One Node version, in four places that must move together.
 *
 * `package.json` said `>=22`, both Dockerfiles built on `node:22`, the release
 * workflow validated on 22 — and CI ran 20. So the only thing testing an
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
    // Quoted or not, both are valid YAML and both have appeared here.
    const versions = [...read('.github/workflows/ci.yml').matchAll(/node-version:\s*'?(\d+)'?/g)].map((m) => m[1]);
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) expect(version).toBe(String(REQUIRED_MAJOR));
  });

  it('is what the release workflow installs', () => {
    const versions = [...read('.github/workflows/release.yml').matchAll(/node-version:\s*'?(\d+)'?/g)].map((m) => m[1]);
    // Two jobs install it, and both matter: one validates, the other builds the
    // installer somebody downloads.
    expect(versions.length).toBeGreaterThanOrEqual(2);
    for (const version of versions) expect(version).toBe(String(REQUIRED_MAJOR));
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
    const notes = read('.github/workflows/release.yml');
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
