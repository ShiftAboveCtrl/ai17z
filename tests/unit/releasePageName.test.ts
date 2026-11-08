import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it.each([
  ['1.0.0-beta.89', 'Beta 0.89'],
  ['1.0.0-beta.100', 'Beta 1.00'],
  ['1.0.0-rc.1', 'AI17Z Release Candidate 1.0.0'],
  ['1.0.0', 'AI17Z 1.0.0'],
])('publishes %s with the intended page title', (version, expected) => {
  const result = spawnSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('tools/release-name.mts'), version, 'page'], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(expected);
});
