/**
 * Links inside a staged `node_modules` that a package cannot carry.
 *
 * npm links a dependency to a directory in the repository in two situations: a
 * workspace package (`node_modules/@xbam/shared`), and an override that points a
 * dependency at a local `file:` package. The second is how `@farcaster/core`
 * gets `packages/faker-compat` in place of the faker 7 it asks for, at
 * `node_modules/@farcaster/core/node_modules/@faker-js/faker`.
 *
 * The zip writer skips every link, because a link inside an archive is either a
 * path that escapes the extraction directory or a broken file on the other
 * machine (see `walk` in `zip.ts`). The workspace links are harmless to lose:
 * the code resolves `@xbam/*` through tsconfig paths. The override link is not.
 * Without it `@farcaster/core` resolves the top-level faker 10, calls
 * `faker.datatype.number` while its module initialises, and the native worker,
 * the only thing that can drive Chrome, dies on start. Beta 0.93 shipped
 * exactly that, and it was invisible everywhere the package was not unpacked
 * from the zip, because the stage itself still has the link.
 *
 * So every link that is not a workspace link is replaced here by a real copy of
 * what it points at, and one that cannot be is a refusal. Left alone, a new
 * override would ship broken the same way.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, lstat, readdir, readFile, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

/** Links npm makes for the repository's own workspaces; resolved by tsconfig paths instead. */
const WORKSPACE_SCOPE = '@xbam';

async function* walkLinks(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      yield full;
    } else if (entry.isDirectory() && entry.name !== '.bin') {
      yield* walkLinks(full);
    }
  }
}

/** The package name a path under `node_modules` stands for: `@scope/name` or `name`. */
function packageNameAt(modulesDir: string, linkPath: string): string {
  const parts = relative(modulesDir, linkPath).split(sep);
  return parts[0]!.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

async function removeLink(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    // A directory junction on Windows is refused by rm without `recursive`, which
    // would follow it; rmdir removes the junction itself and never its target.
    await rmdir(path);
  }
}

/**
 * Where `name` would be found by a file that sits *under* `copyDir`, ignoring
 * the copy itself: the nearest enclosing `node_modules` that is not the one the
 * copy lives in.
 */
function hoistedCopyOf(name: string, copyDir: string, stageDir: string): string | null {
  let dir = dirname(copyDir);
  for (;;) {
    if (dir.endsWith(`${sep}node_modules`) && existsSync(join(dir, name, 'package.json'))) {
      // The one that holds the copy would find the copy again, not the real thing.
      if (resolve(join(dir, name)) !== resolve(copyDir)) return join(dir, name);
    }
    const up = dirname(dir);
    if (up === dir || !resolve(up).startsWith(resolve(stageDir))) return null;
    dir = up;
  }
}

/**
 * The dependency that crashed Beta 0.93's worker actually loads, from the stage.
 *
 * Looking for a path cannot catch this: the file was there, and the link to it
 * was what went missing. `@farcaster/core` runs its factories while it
 * initialises, so importing it is the whole question. Run with plain `node` from
 * the stage root, the way the worker's own resolution works.
 */
export async function proveWorkerImports(stageDir: string, env?: NodeJS.ProcessEnv): Promise<void> {
  const run = promisify(execFile);
  const probe = join(stageDir, '.probe-farcaster.mjs');
  await writeFile(probe, "const m = await import('@farcaster/core');\nconsole.log(`farcaster ok ${typeof m.Message}`);\n", 'utf8');
  try {
    const { stdout } = await run('node', [probe], { cwd: stageDir, maxBuffer: 8 * 1024 * 1024, ...(env ? { env } : {}) });
    if (!stdout.includes('farcaster ok')) throw new Error(`the import ran but printed: ${stdout.trim()}`);
  } catch (error) {
    throw new Error(
      'the staged application cannot load @farcaster/core, so its native worker would crash on start ' +
        `and no installed copy could drive Chrome:\n  ${(error as Error).message}`,
    );
  } finally {
    await rm(probe, { force: true });
  }
}

export interface MaterializedLinks {
  /** Paths, relative to the stage, that were links and are now real directories. */
  materialized: string[];
}

export async function materializeNestedLinks(stageDir: string): Promise<MaterializedLinks> {
  const stageReal = await realpath(stageDir);
  const modules = join(stageDir, 'node_modules');
  const materialized: string[] = [];
  if (!existsSync(modules)) return { materialized };

  const links: string[] = [];
  for await (const link of walkLinks(modules)) links.push(link);

  for (const link of links) {
    // A workspace link sits directly under node_modules/@xbam.
    if (dirname(link) === join(modules, WORKSPACE_SCOPE)) continue;

    const where = relative(stageDir, link);
    let target: string;
    try {
      target = await realpath(link);
    } catch {
      throw new Error(`${where} is a link to nothing, so it would ship broken.`);
    }
    if (target !== stageReal && !target.startsWith(`${stageReal}${sep}`)) {
      throw new Error(`${where} links outside the staged application (${target}); it would not exist on another machine.`);
    }
    if (!(await lstat(target)).isDirectory()) {
      throw new Error(`${where} links to something that is not a directory, which this packager does not know how to carry.`);
    }

    // Name read before the link is gone: `@faker-js/faker` for the nested override.
    const nearestModules = (() => {
      let dir = dirname(link);
      while (!dir.endsWith(`${sep}node_modules`) && dirname(dir) !== dir) dir = dirname(dir);
      return dir;
    })();
    const name = packageNameAt(nearestModules, link);

    await removeLink(link);
    await cp(target, link, { recursive: true, dereference: true, filter: (source) => !source.split(/[\\/]/).includes('node_modules') });

    // A copy that depends on a package of its own name would resolve itself, so
    // it carries the real one. The link never had the problem: Node resolves a
    // link from where it points, and that is outside this node_modules.
    const manifest = JSON.parse(await readFile(join(link, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    if (manifest.dependencies && name in manifest.dependencies) {
      const real = hoistedCopyOf(name, link, stageDir);
      if (!real) {
        throw new Error(`${where} depends on ${name}, and no ${name} is installed above it to carry along.`);
      }
      await cp(real, join(link, 'node_modules', name), { recursive: true, dereference: true });
    }
    materialized.push(where.split(sep).join('/'));
  }
  return { materialized };
}
