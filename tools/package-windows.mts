/**
 * Stages AI17Z for the Windows installer.
 *
 * The installer ships the application, not the repository. That distinction is
 * the whole design: a clone carries tests, fixtures, the git history, developer
 * tooling and 400MB of dev dependencies, none of which an installed copy needs
 * and some of which it must not have -- shipping `tests/fixtures` would put
 * sample data on somebody's machine and shipping `.env` would put a master key
 * in an installer.
 *
 * What comes out is a directory that runs: the source AI17Z executes directly
 * (internal packages have no build step and run under tsx), production
 * dependencies, and the built web application.
 *
 * Deliberately not bundled:
 *
 *   - **Node**, **Docker** and **Google Chrome**. Redistributing them is either
 *     a licensing question nobody needs or an installer that silently puts
 *     three other products on somebody's machine. The installer detects them
 *     and says what is missing.
 *   - **Playwright browsers**. AI17Z attaches to the real Chrome the owner
 *     already has; the bundled Chromium is only ever used by tests.
 *
 * Run: npm run package:windows
 */
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stageDir = resolve(root, 'build', 'windows', 'app');

/**
 * What the application needs at run time.
 *
 * An allow-list rather than a deny-list, for the same reason the knowledge
 * indexer uses one: a deny-list is a promise to have thought of everything, and
 * the thing nobody thinks of is the one that ships somebody's `.env`.
 */
const INCLUDE = [
  'package.json',
  'package-lock.json',
  'apps/api',
  'apps/worker',
  // Sources, not build output. The web image is built from these by
  // `docker compose build web`, exactly as it is from a clone.
  'apps/web',
  'packages',
  'migrations',
  'tsconfig.base.json',
  'tsconfig.json',
  'LICENSE',
  'README.md',
  'start-ai17z.ps1',
  'stop-ai17z.ps1',
  'restart-ai17z.ps1',
  'launch-ai17z.ps1',
  'doctor-ai17z.ps1',
  'update-ai17z.ps1',
  'docker-compose.yml',
  'docker',
];

/** Never shipped, even when it sits inside something that is. */
const EXCLUDE_NAMES = new Set([
  'node_modules',
  '.git',
  '.env',
  '.env.local',
  'storage',
  'test-results',
  'playwright-report',
  'coverage',
  'dist',
  'build',
  '.turbo',
  '.vite',
]);

async function copyFiltered(from: string, to: string): Promise<void> {
  await cp(from, to, {
    recursive: true,
    force: true,
    filter: (source) => {
      const name = source.split(/[\\/]/).pop() ?? '';
      if (EXCLUDE_NAMES.has(name)) return false;
      // A stray environment file anywhere in the tree is a master key in an
      // installer. Refused by name wherever it appears.
      if (/^\.env(\..*)?$/i.test(name)) return false;
      if (name.endsWith('.tsbuildinfo')) return false;
      return true;
    },
  });
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else total += (await stat(full)).size;
  }
  return total;
}

async function main(): Promise<void> {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
  const version = process.env.AI17Z_VERSION?.replace(/^v/, '') || pkg.version;

  console.log(`AI17Z ${version}: staging the Windows application`);
  await rm(resolve(root, 'build', 'windows'), { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });

  for (const entry of INCLUDE) {
    const from = join(root, entry);
    if (!existsSync(from)) {
      // Named rather than skipped: a missing input means the installer would
      // ship something incomplete, and a silent skip is how that ships.
      throw new Error(`packaging input is missing: ${entry}`);
    }
    await copyFiltered(from, join(stageDir, entry));
  }

  // No web build here. AI17Z serves its interface from a container that nginx
  // fronts, and that image is built from source by `docker compose build web`
  // on first launch -- the same path a clone takes. Building a bundle here as
  // well would ship a second copy that nothing loads.

  console.log('installing production dependencies');
  await run(
    'npm',
    [
      'ci',
      '--omit=dev',
      // pdfjs-dist lists @napi-rs/canvas as optional and only needs it to
      // *render* a PDF. AI17Z reads the text layer and never renders, so this
      // drops a 37MB native binary the product cannot reach.
      '--omit=optional',
      // Only what the *host* runs, which is the native worker and the tools
      // around it. Everything else runs in a container that installs its own
      // dependencies. Without this scoping the installer carries 130MB of
      // front-end build libraries -- three, drei, framer-motion, lucide -- that
      // exist to produce a bundle the container produces for itself.
      '--workspace',
      'apps/api',
      '--workspace',
      'apps/worker',
      '--include-workspace-root',
      '--no-audit',
      '--no-fund',
    ],
    {
      cwd: stageDir,
      shell: true,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        // AI17Z drives the Chrome the owner already has. The bundled browsers
        // are a test dependency and would triple the installer for nothing.
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
      },
    },
  );

  // A stamp the running application can report, so "which version is this?" is
  // answerable on a machine with no git.
  await writeFile(
    join(stageDir, 'BUILD_INFO.json'),
    `${JSON.stringify(
      {
        version,
        builtAt: new Date().toISOString(),
        commit: process.env.GITHUB_SHA ?? (await gitCommit()),
        signed: false,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const bytes = await directorySize(stageDir);
  console.log(`staged ${(bytes / 1024 / 1024).toFixed(0)}MB at ${stageDir}`);
  console.log(`AI17Z_VERSION=${version}`);
}

async function gitCommit(): Promise<string> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: root });
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}

await main();
