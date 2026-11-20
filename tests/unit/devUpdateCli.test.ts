import { execFile } from 'node:child_process';
import { mkdtemp, copyFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it('splits outside a checkout without loading runtime dependencies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dev-update-cli-'));
  try {
    for (const file of await readdir('tools')) {
      if (file.startsWith('dev-update') && /\.(?:mts|mjs)$/.test(file)) await copyFile(join('tools', file), join(dir, file));
    }
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href, join(dir, 'dev-updates.mts'), 'split', '--text', 'A paragraph.\n\nAnother paragraph.']);
    expect(JSON.parse(stdout)).toEqual(['A paragraph.\n\nAnother paragraph.']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
