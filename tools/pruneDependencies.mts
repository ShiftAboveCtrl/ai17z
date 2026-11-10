/**
 * Documentation and tests out of the dependencies an installation ships.
 *
 * A dependency's README, changelog, `docs/` and `test/` are never loaded by
 * anything AI17Z runs, and they are where third-party packages keep other
 * people's hostnames, addresses and example paths. Every one of those is a hit
 * the release's private identifier scan then has to prove came from upstream.
 * Fewer files, fewer hits.
 *
 * The rule is narrow on purpose, because removing a file the runtime loads is a
 * package that installs and then fails on somebody else's machine:
 *
 * - Only a package's **top level** is considered. `playwright/lib/mcp/test/`
 *   is runtime code that happens to be called test, and it is never touched.
 * - Only fixed names: the directories in `PRUNED_DIRECTORIES`, and README,
 *   CHANGELOG and their kin. Not every `*.md`: playwright reads its agent
 *   templates from `lib/agents/*.md` at run time.
 * - A candidate is kept if the package's `package.json` points into it (main,
 *   module, browser, bin, exports, types), or if any of the package's own
 *   JavaScript or JSON names it. A false keep costs a few kilobytes; a false
 *   removal costs an installation.
 *
 * Never by category of dependency, and never `--omit=optional`: see the
 * comment on `npm ci` in package-windows.mts.
 */
import { existsSync } from 'node:fs';
import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const PRUNED_DIRECTORIES: ReadonlySet<string> = new Set([
  'test',
  'tests',
  '__tests__',
  'example',
  'examples',
  'docs',
  'doc',
  'benchmark',
  'benchmarks',
  'coverage',
  '.github',
]);

/** README, CHANGELOG and their kin, as plain text or markdown. LICENSE and NOTICE are never touched. */
export const PRUNED_FILE = /^(readme|changelog|changes|history|contributing|code_of_conduct|upgrading|migrating|migration)(\.(md|markdown|txt))?$/i;

const CODE = /\.(c?js|mjs|json)$/i;

export interface PruneResult {
  removed: string[];
  kept: string[];
  bytes: number;
}

/** Every relative path a package.json says something loads, normalised without a leading `./`. */
export function entryPoints(manifest: unknown): string[] {
  const out: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value === 'string') out.push(value.replace(/^\.\//, '').replace(/\\/g, '/'));
    else if (Array.isArray(value)) value.forEach(add);
    else if (value && typeof value === 'object') Object.values(value).forEach(add);
  };
  if (manifest && typeof manifest === 'object') {
    const m = manifest as Record<string, unknown>;
    for (const field of ['main', 'module', 'browser', 'bin', 'exports', 'types', 'typings', 'directories']) add(m[field]);
  }
  return out;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether any of the package's own code names this top-level entry as a path:
 * `./docs/x`, `'docs/x'`, `require('./docs')`, `import './test'`, or `'docs'`
 * handed to `join`, `resolve`, beside `__dirname`, or interpolated as
 * `${__dirname}/docs`. A bare `'test'` anywhere else is a string, not a path:
 * `NODE_ENV === 'test'` is in half the packages on npm. File names are matched
 * without case, so a `readme.md` reference keeps a `README.md`.
 */
export function referenced(name: string, isDirectory: boolean, code: string): boolean {
  if (!isDirectory) return new RegExp(escape(name), 'i').test(code);
  const n = escape(name);
  return (
    new RegExp(`['"\`/]${n}/`).test(code) ||
    new RegExp(`['"\`]\\./${n}['"\`]`).test(code) ||
    new RegExp(`(__dirname|join\\(|resolve\\()[^;\\n]{0,80}['"\`]\\/?${n}['"\`]`).test(code) ||
    new RegExp(`\\$\\{__dirname\\}\\/?${n}(['"\`/]|$)`).test(code)
  );
}

async function packageCode(dir: string, skip: ReadonlySet<string>): Promise<string> {
  const parts: string[] = [];
  const walk = async (at: string, top: boolean): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || (top && skip.has(entry.name))) continue;
      const full = join(at, entry.name);
      if (entry.isDirectory()) await walk(full, false);
      // package.json is read for its entry points instead: its scripts name
      // `test/` in every package that has tests, and a script is not a load.
      else if (entry.isFile() && CODE.test(entry.name) && !(top && entry.name === 'package.json')) {
        parts.push(await readFile(full, 'utf8'));
      }
    }
  };
  await walk(dir, true);
  return parts.join('\n');
}

async function sizeOf(path: string): Promise<number> {
  const s = await lstat(path);
  if (!s.isDirectory()) return s.size;
  let total = 0;
  for (const entry of await readdir(path)) total += await sizeOf(join(path, entry));
  return total;
}

async function prunePackage(dir: string, label: string, result: PruneResult): Promise<void> {
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) return;
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    // A package.json nobody can read says nothing about what it loads, so
    // nothing in that package is removed.
    return;
  }
  const entries = await readdir(dir, { withFileTypes: true });
  const candidates = entries.filter((e) =>
    e.isDirectory() ? PRUNED_DIRECTORIES.has(e.name) : e.isFile() && PRUNED_FILE.test(e.name),
  );
  if (candidates.length === 0) return;
  const points = entryPoints(manifest);
  const code = await packageCode(dir, new Set(candidates.map((c) => c.name)));
  for (const candidate of candidates) {
    const isDirectory = candidate.isDirectory();
    const loaded = points.some((p) => (isDirectory ? p === candidate.name || p.startsWith(`${candidate.name}/`) : p === candidate.name));
    if (loaded || referenced(candidate.name, isDirectory, code)) {
      result.kept.push(`${label}/${candidate.name}`);
      continue;
    }
    const full = join(dir, candidate.name);
    result.bytes += await sizeOf(full);
    await rm(full, { recursive: true, force: true });
    result.removed.push(`${label}/${candidate.name}`);
  }
}

/** Prune every package under one node_modules directory, nested node_modules included. */
export async function pruneDependencies(nodeModules: string, label = 'node_modules'): Promise<PruneResult> {
  const result: PruneResult = { removed: [], kept: [], bytes: 0 };
  const visit = async (modules: string, at: string): Promise<void> => {
    if (!existsSync(modules)) return;
    for (const entry of await readdir(modules, { withFileTypes: true })) {
      // Links are workspace packages: AI17Z's own code, never pruned here.
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dirs = entry.name.startsWith('@')
        ? (await readdir(join(modules, entry.name), { withFileTypes: true }))
            .filter((e) => e.isDirectory())
            .map((e) => [join(modules, entry.name, e.name), `${at}/${entry.name}/${e.name}`] as const)
        : [[join(modules, entry.name), `${at}/${entry.name}`] as const];
      for (const [dir, name] of dirs) {
        await prunePackage(dir, name, result);
        await visit(join(dir, 'node_modules'), `${name}/node_modules`);
      }
    }
  };
  await visit(nodeModules, label);
  return result;
}
