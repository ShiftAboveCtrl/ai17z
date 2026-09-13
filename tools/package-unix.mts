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
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { releaseName } from '@xbam/shared';
import { INCLUDE, copyFiltered, proveCompatibilityGate } from './package-windows.mjs';

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

/**
 * A package for this machine, built on this machine.
 *
 * npm installs exactly one platform package out of an optional set, and which
 * one depends on the machine that ran `npm ci`. Staging an Ubuntu package on
 * Windows produces a tree carrying `@esbuild/win32-x64` under a Linux name: it
 * builds, it installs, and then every `tsx` process an installed copy runs --
 * the migration on every start, the API, the worker -- dies on a binary that is
 * not for that machine. Nothing in the build log says so.
 *
 * The release and validation workflows both build each platform on a runner
 * that really is that platform, so this refuses the one case that cannot be
 * right rather than constraining anything that is.
 */
const hostSuits: Record<'ubuntu' | 'macos', NodeJS.Platform[]> = {
  ubuntu: ['linux'],
  macos: ['darwin'],
};
if (!hostSuits[platform].includes(process.platform)) {
  console.error(`  a ${platform} package cannot be staged on ${process.platform}.`);
  console.error('  npm would install this machine\'s native binaries under that platform\'s name,');
  console.error('  and the package would install and then fail to run a single script.');
  console.error(`  Build it on ${hostSuits[platform].join(' or ')}, as the workflows do.`);
  process.exit(2);
}
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
    'install-ai17z-ubuntu.sh',
    'packaging/ubuntu/ai17z',
    'packaging/ubuntu/ai17z-lifecycle.sh',
    'packaging/ubuntu/ai17z-update.sh',
    'packaging/ubuntu/ai17z.desktop',
    'packaging/ubuntu/postinst',
    'packaging/ubuntu/postrm',
    'packaging/windows/ai17z-256.png',
  ],
  macos: [
    'install-ai17z-macos.sh',
    'packaging/macos/ai17z',
    'packaging/macos/ai17z-lifecycle.sh',
    'packaging/macos/ai17z-update.sh',
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
    // Filtered, exactly as the Windows packager filters. `cp` on its own copies
    // whatever is inside an included directory, and what is inside somebody's
    // checkout includes their `.env`, their `storage`, and the browser profile
    // they are signed into X with. A deny-list is a promise to have thought of
    // everything; sharing one with the other packager is how that promise stays
    // kept in both places at once.
    await copyFiltered(from, to);
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
    // No `shell: true`. A shell eats the double quotes in `import("./.probe.ts")`
    // and tsx is handed `import(./.probe.ts)`, which fails as a syntax error
    // about a dot. This repository already has the same trap written down for
    // PowerShell's native argument passing. `execFile` hands argv over
    // directly, so the quotes survive and nothing needs escaping.
    await run('node', ['node_modules/tsx/dist/cli.mjs', '--eval', 'import("./.probe.ts").then(m=>console.log(m.ok))'], {
      cwd: stage,
      maxBuffer: 8 * 1024 * 1024,
    });
  } finally {
    await rm(join(stage, '.probe.ts'), { force: true });
  }

  await proveCompatibilityGate(stage, platform, version);

  console.log(`  staged at ${stage}`);
  console.log(`AI17Z_VERSION=${version}`);
  console.log(`AI17Z_STAGE=${stage}`);
}

// The same guard as the Windows packager, for the same reason in reverse:
// nothing imports this today, and the day something does is the day it matters
// and nobody is looking.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
