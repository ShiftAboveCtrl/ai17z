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
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { releaseName, releaseManifestSchema } from '@xbam/shared';
import { INCLUDE, copyFiltered } from './package-windows.mjs';

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
  'packaging/unix/preflight.mts',
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


/**
 * A manifest good enough to decide with, for the probe below.
 *
 * Built through the real schema rather than typed as a literal, so that a
 * schema change cannot quietly turn the probe into a test of nothing: an
 * unparseable manifest makes the bridge print SKIP, and a probe that only
 * checked it printed *something* would go on passing while the gate was dead.
 */
function probeManifest(version: string, platform: 'ubuntu' | 'macos'): string {
  const requirements =
    platform === 'ubuntu'
      ? { minimumDocker: '26.0.0', minimumChromeMajor: 120, bundledNode: 'v22.23.2', os: { releases: ['24.04'] } }
      : { minimumDocker: '26.0.0', minimumChromeMajor: 120, bundledNode: 'v22.23.2', os: { minimumMajor: 13 } };
  const document = {
    schemaVersion: 1,
    version,
    tag: `v${version}`,
    commit: '0'.repeat(40),
    builtAt: new Date().toISOString(),
    signed: { windows: false, macos: false, ubuntu: false },
    minimumUpdaterSchema: 1,
    installLayoutSchema: 3,
    platforms: {
      [platform]: {
        supported: true,
        architectures: ['x64', 'arm64'],
        methods: [platform === 'ubuntu' ? 'UBUNTU_DEB' : 'MACOS_PKG'],
        requirements,
      },
    },
    artifacts: [],
    migrations: { latest: 'probe', count: 0 },
  };
  const checked = releaseManifestSchema.safeParse(document);
  if (!checked.success) {
    throw new Error(
      `the probe manifest no longer matches the release manifest schema, so this check would ` +
        `prove nothing: ${checked.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  return JSON.stringify(checked.data);
}

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
    await run('node', ['node_modules/tsx/dist/cli.mjs', '--eval', 'import("./.probe.ts").then(m=>console.log(m.ok))'], {
      cwd: stage,
      shell: true,
      maxBuffer: 8 * 1024 * 1024,
    });
  } finally {
    await rm(join(stage, '.probe.ts'), { force: true });
  }

  // The compatibility gate actually answers.
  //
  // `preflight.mts` is what both Unix updaters run before they stop anything,
  // and the way they run it is `node node_modules/tsx/dist/cli.mjs` against a
  // file that imports `@xbam/shared`. Every one of those has to resolve inside
  // an installed package, and if any of them does not the updater swallows the
  // error and prints "could not read this release's compatibility manifest;
  // continuing" -- which is correct behaviour for an old release with no
  // manifest, and indistinguishable from the gate being dead.
  //
  // So it is run here, in the stage, exactly as the updater runs it. Twice:
  // once on a machine the release supports and once on one it does not. The
  // refusal is the half that matters, because a bridge that cannot start also
  // prints nothing an OK check would notice.
  console.log('  proving the update compatibility gate answers');
  const probePath = join(stage, '.preflight-probe.json');
  await writeFile(probePath, probeManifest(version, platform), 'utf8');
  const askPreflight = async (...args: string[]): Promise<string> => {
    const { stdout } = await run(
      'node',
      ['node_modules/tsx/dist/cli.mjs', 'packaging/unix/preflight.mts', probePath, platform, ...args],
      { cwd: stage, maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout.trim();
  };
  try {
    const supported = platform === 'ubuntu' ? ['x64', '24.04', '27.0.0', '130'] : ['arm64', '14.5', '27.0.0', '130'];
    const refused = platform === 'ubuntu' ? ['x64', '20.04', '27.0.0', '130'] : ['arm64', '12.7', '27.0.0', '130'];

    const yes = await askPreflight(...supported);
    if (!yes.startsWith('OK')) {
      throw new Error(`a machine this release supports was not accepted; it said:
${yes}`);
    }
    const no = await askPreflight(...refused);
    if (!no.startsWith('NO')) {
      throw new Error(
        `a machine this release does not support was not refused; it said:
${no}
` +
          'A SKIP here means the bridge could not run at all, which is how an update ' +
          'gate stops working without anybody being told.',
      );
    }
  } catch (error) {
    throw new Error(
      'the staged application cannot decide whether a release can run on a machine, so every ' +
        `update would proceed unchecked:
  ${(error as Error).message}`,
    );
  } finally {
    await rm(probePath, { force: true });
  }

  console.log(`  staged at ${stage}`);
  console.log(`AI17Z_VERSION=${version}`);
  console.log(`AI17Z_STAGE=${stage}`);
}

await main();
