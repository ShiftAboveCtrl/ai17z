#!/usr/bin/env tsx
/**
 * Stages AI17Z for the macOS and Ubuntu packages.
 *
 * The same application the Windows packager stages, with the platform's own
 * lifecycle scripts instead of Windows'. `INCLUDE` is imported rather than
 * copied: two lists of what an installation needs is how one of them ends up
 * missing the file that makes `docker compose build` fail on somebody else's
 * machine with "/docs: not found".
 *
 * This does the npm work and the layout. It does **not** fetch the private Node
 * runtime -- that happens in the platform build script, on the platform, where
 * the architecture is not a guess.
 *
 *   npm run package:unix -- --platform ubuntu --stage <dir>
 */
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { releaseName } from '@xbam/shared';
import { INCLUDE } from './package-windows.mjs';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? (argv[at + 1] ?? null) : null;
};

const requested = flag('platform');
if (requested !== 'ubuntu' && requested !== 'macos') {
  console.error('  --platform must be ubuntu or macos');
  process.exit(2);
}
const platform: 'ubuntu' | 'macos' = requested;
const stage = resolve(flag('stage') ?? join(root, 'build', platform, 'app'));

/**
 * What each platform needs that the other does not.
 *
 * Windows' `.ps1` lifecycle is left out entirely rather than shipped and
 * ignored: a package carrying scripts that cannot run on it invites somebody to
 * try, and the failure would be confusing rather than obvious.
 */
const SHARED_UNIX = [
  // The resolver every shipped .sh sources. Without it in the package, every
  // one of them exits on its first line saying so -- which is the right
  // failure, and one that must never actually happen.
  'packaging/unix/ai17z-paths.sh',
  'start-ai17z.sh',
  'stop-ai17z.sh',
  'restart-ai17z.sh',
  'launch-ai17z.sh',
  'doctor-ai17z.sh',
  'install-ai17z.sh',
];

const PLATFORM_FILES: Record<'ubuntu' | 'macos', string[]> = {
  ubuntu: [
    'packaging/ubuntu/ai17z',
    'packaging/ubuntu/ai17z.desktop',
    'packaging/ubuntu/postinst',
    'packaging/ubuntu/postrm',
    'packaging/windows/ai17z-256.png',
  ],
  macos: [
    'packaging/macos/ai17z',
    'packaging/windows/ai17z-256.png',
  ],
};

/** The Windows-only entries, dropped from the shared list. */
const WINDOWS_ONLY = /\.ps1$|^packaging\/windows\/(?!ai17z-256\.png)|\.cmd$|\.ico$/;

async function main(): Promise<void> {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
  const version = manifest.version;
  const name = releaseName(version);
  console.log(`${name.title} (${version}): staging the ${platform} application`);

  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  const wanted = [...INCLUDE.filter((entry) => !WINDOWS_ONLY.test(entry)), ...SHARED_UNIX, ...PLATFORM_FILES[platform]];
  for (const entry of wanted) {
    const from = join(root, entry);
    if (!existsSync(from)) {
      // Loud rather than skipped. Four releases in a row shipped an application
      // that could not start, and every one of them was a path nobody noticed
      // was absent until somebody else's machine tried to use it.
      console.error(`  missing from the checkout: ${entry}`);
      process.exit(1);
    }
    const to = join(stage, entry);
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { recursive: true });
  }

  console.log('  installing production dependencies');
  await run(
    'npm',
    ['ci', '--omit=dev', '--workspace', 'apps/api', '--workspace', 'apps/worker', '--include-workspace-root', '--no-audit', '--no-fund'],
    { cwd: stage, shell: true, maxBuffer: 64 * 1024 * 1024 },
  );

  // Exactly the rule the Windows packager follows, and for the same reason:
  // npm installs one platform package out of an optional set, and `--omit=optional`
  // would take `@esbuild/linux-x64` with it -- and with it every `tsx` process
  // an installed copy runs. Unwanted natives go by name, never by category.
  for (const unwanted of ['@img/sharp-libvips-dev', '@img/sharp-libvips-dev-wasm32']) {
    await rm(join(stage, 'node_modules', unwanted), { recursive: true, force: true }).catch(() => undefined);
  }

  await writeFile(
    join(stage, 'BUILD_INFO.json'),
    `${JSON.stringify({ version, name: name.title, platform, builtAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );

  // Proved rather than assumed: a stage where `tsx` cannot transform is a stage
  // that installs happily and then cannot run a single npm script.
  console.log('  proving the staged runtime can transform TypeScript');
  await writeFile(join(stage, '.probe.ts'), 'export const ok: number = 1;\n', 'utf8');
  try {
    await run('node', ['node_modules/tsx/dist/cli.mjs', '--eval', 'import("./.probe.ts").then(m=>console.log(m.ok))'], {
      cwd: stage,
      shell: true,
      maxBuffer: 8 * 1024 * 1024,
    });
  } finally {
    await rm(join(stage, '.probe.ts'), { force: true });
  }

  console.log(`  staged at ${stage}`);
  console.log(`AI17Z_VERSION=${version}`);
  console.log(`AI17Z_STAGE=${stage}`);
}

await main();
