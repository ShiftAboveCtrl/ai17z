import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { materializeNestedLinks } from '../../tools/materializeLinks.mjs';
import { createZip } from '../../tools/zip';

const run = promisify(execFile);
const root = resolve(__dirname, '../..');
const NESTED = 'node_modules/@farcaster/core/node_modules/@faker-js/faker';

/**
 * Beta 0.93 shipped without the link that points @farcaster/core at
 * packages/faker-compat, so the native worker died on start with
 * "faker.datatype.number is not a function". The stage had the link; the zip
 * writer drops links; nothing looked at the extracted result.
 *
 * The fixture is the same shape as the real stage, with a fake faker small
 * enough to read.
 */
async function buildStage(): Promise<string> {
  const stage = await realpath(await mkdtemp(join(tmpdir(), 'ai17z-links-')));
  await mkdir(join(stage, 'packages/faker-compat'), { recursive: true });
  await writeFile(join(stage, 'packages/faker-compat/package.json'), JSON.stringify({
    name: '@xbam/faker-compat', version: '10.6.0', type: 'module', exports: './index.js', dependencies: { '@faker-js/faker': '10.6.0' },
  }));
  await writeFile(join(stage, 'packages/faker-compat/index.js'),
    "import { faker as current } from '@faker-js/faker';\nexport const faker = { datatype: { number: () => current.number.int() } };\n");

  await mkdir(join(stage, 'node_modules/@faker-js/faker'), { recursive: true });
  await writeFile(join(stage, 'node_modules/@faker-js/faker/package.json'), JSON.stringify({ name: '@faker-js/faker', version: '10.6.0', type: 'module', main: './index.js' }));
  await writeFile(join(stage, 'node_modules/@faker-js/faker/index.js'), 'export const faker = { number: { int: () => 42 } };\n');

  await mkdir(join(stage, 'node_modules/@farcaster/core/node_modules/@faker-js'), { recursive: true });
  await symlink(join(stage, 'packages/faker-compat'), join(stage, NESTED), 'junction');

  // A workspace link, which is meant to stay a link.
  await mkdir(join(stage, 'node_modules/@xbam'), { recursive: true });
  await mkdir(join(stage, 'packages/shared'), { recursive: true });
  await writeFile(join(stage, 'packages/shared/package.json'), '{"name":"@xbam/shared"}');
  await symlink(join(stage, 'packages/shared'), join(stage, 'node_modules/@xbam/shared'), 'junction');
  return stage;
}

async function zipHolds(stage: string, name: string): Promise<boolean> {
  const zip = join(stage, '..', `${Date.now()}-${Math.random().toString(16).slice(2)}.zip`);
  await createZip(stage, zip);
  try {
    return (await readFile(zip)).includes(Buffer.from(name, 'utf8'));
  } finally {
    await rm(zip, { force: true });
  }
}

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) {
    // Junctions first, so removing the temp tree can never reach what they point at.
    await rm(join(dir, NESTED), { force: true, recursive: false }).catch(() => undefined);
    await rm(join(dir, 'node_modules/@xbam/shared'), { force: true, recursive: false }).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

describe('links a package cannot carry', () => {
  it('the zip writer drops the override link, which is how Beta 0.93 lost it', async () => {
    const stage = await buildStage();
    made.push(stage);
    expect(await zipHolds(stage, `${NESTED}/index.js`)).toBe(false);
  });

  it('turns the override link into a real directory the zip carries', async () => {
    const stage = await buildStage();
    made.push(stage);
    const { materialized } = await materializeNestedLinks(stage);
    expect(materialized).toEqual([NESTED]);
    expect((await lstat(join(stage, NESTED))).isSymbolicLink()).toBe(false);
    expect(await zipHolds(stage, `${NESTED}/index.js`)).toBe(true);
  });

  it('leaves workspace links alone', async () => {
    const stage = await buildStage();
    made.push(stage);
    await materializeNestedLinks(stage);
    expect((await lstat(join(stage, 'node_modules/@xbam/shared'))).isSymbolicLink()).toBe(true);
  });

  it('gives the copy the faker it asks for rather than itself', async () => {
    const stage = await buildStage();
    made.push(stage);
    await materializeNestedLinks(stage);
    // A copy that imports its own name resolves the nearest node_modules, which holds the copy.
    // A file inside @farcaster/core asks for faker the way the real dependency does.
    const dependent = join(stage, 'node_modules/@farcaster/core/probe.mjs');
    await writeFile(dependent, "import { faker } from '@faker-js/faker';\nconsole.log('number', faker.datatype.number());\n");
    const { stdout } = await run('node', [dependent], { cwd: stage });
    expect(stdout.trim()).toBe('number 42');
  });

  it('refuses a link that points outside the stage', async () => {
    const stage = await buildStage();
    made.push(stage);
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'ai17z-outside-')));
    made.push(outside);
    await mkdir(join(stage, 'node_modules/stray'), { recursive: true });
    await symlink(outside, join(stage, 'node_modules/stray/linked'), 'junction');
    await expect(materializeNestedLinks(stage)).rejects.toThrow(/outside the staged application/);
    await rm(join(stage, 'node_modules/stray/linked'), { force: true, recursive: false }).catch(() => undefined);
  });
});

describe('both packagers use it', () => {
  const windows = () => readFile(join(root, 'tools/package-windows.mts'), 'utf8');
  const unix = () => readFile(join(root, 'tools/package-unix.mts'), 'utf8');

  it('replaces links before anything is proved or archived', async () => {
    const text = await windows();
    expect(text).toContain('materializeNestedLinks(stageDir)');
    expect(text.indexOf('materializeNestedLinks(stageDir)')).toBeLessThan(text.indexOf("'node_modules/fastify'"));
    expect(await unix()).toContain('materializeNestedLinks(stage)');
  });

  it('proves @farcaster/core loads from the stage and refuses when it does not', async () => {
    expect(await windows()).toContain('await proveWorkerImports(stageDir)');
    expect(await unix()).toContain('proveWorkerImports(stage');
    const module = await readFile(join(root, 'tools/materializeLinks.mts'), 'utf8');
    expect(module).toContain("import('@farcaster/core')");
    expect(module).toContain('throw new Error');
  });
});
