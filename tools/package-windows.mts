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

/**
 * Where the application is assembled.
 *
 * Overridable because the last phase of `npm ci` creates the workspace
 * symlinks, and OneDrive, Dropbox and every other sync client refuses to let
 * anything create a symlink inside a folder it is syncing. The install fails
 * with `EBUSY ... symlink`, which names neither the sync client nor the
 * directory as the problem. A developer whose checkout lives in OneDrive --
 * this one does -- can point the staging somewhere else and get on with it.
 */
const stageDir = process.env.AI17Z_STAGE_DIR
  ? resolve(process.env.AI17Z_STAGE_DIR)
  : resolve(root, 'build', 'windows', 'app');

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
  // The template the first run builds its .env from. Without it, a fresh
  // installation's first act is to crash on a missing file.
  '.env.example',
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
  // Everything the three Dockerfiles copy. The installed copy builds its own
  // images on first launch -- exactly as a clone does -- so a path missing here
  // is not a missing feature, it is `docker compose build` failing with
  // "/docs: not found" and no stack at all.
  //
  // `docs` is also the built-in knowledge source an agent can be taught from,
  // and `tools` holds the AI4CZ importer's workspace manifest, which npm needs
  // to resolve the workspace at all.
  'docs',
  'tools',
  'CONTRIBUTING.md',
  'SECURITY.md',
  // Two files, named rather than the whole `scripts/` directory: the rest of it
  // is maintainer tooling -- rewriting commit history, setting the repository
  // URL -- which has no business on somebody's machine.
  //
  // `ensure-env.mjs` runs from the `premigrate` hook, so every `npm run migrate`
  // needs it, and the installed app runs exactly that on every start.
  // `supervise-worker.mts` is `npm run worker:supervised`, which is how the
  // native worker is kept alive.
  'scripts/ensure-env.mjs',
  'scripts/supervise-worker.mts',
];

/**
 * The npm scripts an installed copy can actually run.
 *
 * Used to prove the files they reference are in the package. This list exists
 * because `.env.example` and `scripts/ensure-env.mjs` were both missing from
 * two separate releases, and both failed the same way: the install succeeded,
 * the containers came up, and the first `npm run migrate` died on a path
 * nobody could be expected to find. A check that names the entry points is the
 * only thing that catches the whole class.
 */
const SHIPPED_SCRIPTS = ['migrate', 'migrate:status', 'start:api', 'start:worker', 'worker:supervised'];

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
      //
      // Except the template, which is the one file here with no secret in it by
      // definition -- its master key line is empty, it is committed to a public
      // repository, and the installed copy cannot start its first run without
      // it. Leaving it out was the installed build's very first failure: it
      // crashed on `Copy-Item '.env.example'` naming a path nobody could find.
      if (name.toLowerCase() === '.env.example') return true;
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
  await rm(stageDir, { recursive: true, force: true });
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

  // Proof, rather than an exit code.
  //
  // `npm ci` reports success having installed nothing more than once -- a
  // workspace filter that matched no package, a lockfile that was copied but
  // not read. What ships then is 350 source files that cannot start, and the
  // first person to find out is whoever installed it. These are the two
  // packages the host process actually loads on the first line of its startup.
  for (const proof of ['node_modules/fastify', 'node_modules/pg']) {
    if (!existsSync(join(stageDir, proof))) {
      throw new Error(
        `dependencies were not installed: ${proof} is missing from the staged application. ` +
          'It would install and then fail to start.',
      );
    }
  }

  // Everything the scripts an installed copy runs will reach for, including the
  // `pre` hooks npm runs on their behalf. Two releases shipped without a file
  // one of these needed, and both times the failure surfaced on somebody
  // else's machine as a module-not-found for a path that only exists here.
  const staged = JSON.parse(await readFile(join(stageDir, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const missing: string[] = [];
  for (const name of SHIPPED_SCRIPTS) {
    for (const script of [staged.scripts[`pre${name}`], staged.scripts[name], staged.scripts[`post${name}`]]) {
      if (!script) continue;
      for (const referenced of script.match(/[\w./-]+\.(?:mjs|mts|ts|cjs|js)/g) ?? []) {
        if (referenced.startsWith('-') || existsSync(join(stageDir, referenced))) continue;
        missing.push(`${referenced} (npm run ${name})`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `the staged application is missing files its own npm scripts run:\n  ${missing.join('\n  ')}\n` +
        'It would install, start its containers, and then fail on the first migration.',
    );
  }

  // Everything the Dockerfiles build from.
  //
  // The images are built on the machine that installed AI17Z, from this
  // directory, so every path a `COPY` names has to be in it. Three releases
  // shipped without `docs`, `tools`, `CONTRIBUTING.md` and `SECURITY.md`, and
  // the failure was invisible in testing for a reason worth recording: the
  // installed copy shared a Docker project name with a developer checkout, so
  // compose found images that checkout had already built and never ran a build
  // at all. Fixing the project name is what exposed this.
  //
  // Read out of the Dockerfiles rather than listed here, because a list is a
  // second place to forget.
  const uncopied: string[] = [];
  for (const dockerfile of await readdir(join(root, 'docker'))) {
    if (!dockerfile.endsWith('.Dockerfile')) continue;
    const text = await readFile(join(root, 'docker', dockerfile), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const copy = line.match(/^\s*COPY\s+(.*)$/);
      // `--from=` copies out of an earlier build stage, not out of this
      // directory, so there is nothing here for it to be missing.
      if (!copy || copy[1]!.includes('--from=')) continue;
      const parts = copy[1]!.trim().split(/\s+/);
      // The last argument is the destination inside the image.
      for (const source of parts.slice(0, -1)) {
        if (existsSync(join(stageDir, source))) continue;
        uncopied.push(`${source} (docker/${dockerfile})`);
      }
    }
  }
  if (uncopied.length > 0) {
    throw new Error(
      `the staged application is missing paths its own Dockerfiles copy:\n  ${[...new Set(uncopied)].join('\n  ')}\n` +
        'It would install and then fail to build its images on first launch.',
    );
  }

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
