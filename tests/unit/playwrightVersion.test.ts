import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

/**
 * The Playwright base image ships browser binaries for exactly one release.
 * If the npm version and the image tag drift apart, the worker builds fine and
 * then fails the first time anyone tries to open a browser, with an error that
 * looks like a missing file rather than a version mismatch. This test is here so
 * that failure happens in CI instead.
 */
describe('playwright version alignment', () => {
  const declared = JSON.parse(read('packages/browser/package.json')).dependencies.playwright as string;

  it('pins an exact version rather than a range', () => {
    expect(declared).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('matches the worker image tag', () => {
    const tag = read('docker/worker.Dockerfile').match(/mcr\.microsoft\.com\/playwright:v([\d.]+)-/)?.[1];
    expect(tag).toBe(declared);
  });

  it('matches the installed package, so the lockfile cannot drift either', () => {
    const installed = JSON.parse(read('node_modules/playwright/package.json')).version as string;
    expect(installed).toBe(declared);
  });

  it('matches @playwright/test, which shares the browser download', () => {
    expect(JSON.parse(read('package.json')).devDependencies['@playwright/test']).toBe(declared);
  });
});
