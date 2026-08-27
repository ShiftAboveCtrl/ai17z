import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');

/**
 * The images install dependencies before the sources are copied, which needs
 * every workspace manifest listed by hand. Forgetting one fails the build with a
 * 404 from the npm registry for a package that only exists locally, which reads
 * as a network problem rather than a missing COPY line.
 */
describe('docker images list every workspace', () => {
  const workspaces = [
    ...readdirSync(resolve(root, 'packages')).map((d) => `packages/${d}`),
    ...['apps/api', 'apps/worker', 'apps/web'],
    ...readdirSync(resolve(root, 'tools'))
      .filter((d) => {
        try {
          readFileSync(resolve(root, 'tools', d, 'package.json'));
          return true;
        } catch {
          return false;
        }
      })
      .map((d) => `tools/${d}`),
  ];

  for (const file of ['docker/node.Dockerfile', 'docker/worker.Dockerfile', 'docker/web.Dockerfile']) {
    it(`${file} copies every workspace manifest`, () => {
      const contents = readFileSync(resolve(root, file), 'utf8');
      for (const workspace of workspaces) {
        expect(contents, `${file} is missing ${workspace}/package.json`).toContain(`${workspace}/package.json`);
      }
    });
  }
});
