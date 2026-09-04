import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every subpath a package exports has to be resolvable under vitest too.
 *
 * The alias map in `vitest.config.ts` duplicates the `exports` map in each
 * package.json, and nothing links them. Adding `@xbam/shared/util` to the
 * package built and typechecked cleanly and then failed at run time in one
 * suite with "Cannot find module" -- the kind of break that is invisible until
 * something imports it.
 */
const root = join(import.meta.dirname, '..', '..');
const config = readFileSync(join(root, 'vitest.config.ts'), 'utf8');

function packageDirs(group: string): string[] {
  return readdirSync(join(root, group), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(root, group, e.name));
}

describe('the vitest alias map against what the packages export', () => {
  const dirs = [...packageDirs('packages'), ...packageDirs('apps')];

  it('covers every exported subpath', () => {
    const missing: string[] = [];
    for (const dir of dirs) {
      let pkg: { name?: string; exports?: Record<string, string> };
      try {
        pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      } catch {
        continue;
      }
      if (!pkg.name || !pkg.exports) continue;
      for (const subpath of Object.keys(pkg.exports)) {
        const specifier = subpath === '.' ? pkg.name : `${pkg.name}${subpath.slice(1)}`;
        if (!config.includes(`'${specifier}'`)) missing.push(specifier);
      }
    }
    expect(missing, 'exported but not aliased for vitest').toEqual([]);
  });

  it('lists a subpath before the bare package name it starts with', () => {
    // Aliases are matched in order, so '@xbam/shared' above '@xbam/shared/util'
    // rewrites the prefix and the import resolves to the wrong file.
    const order = [...config.matchAll(/'(@xbam\/[^']+)':/g)].map((m) => m[1]!);
    const wrong = order.flatMap((specifier, i) =>
      order.slice(0, i).filter((earlier) => specifier.startsWith(`${earlier}/`)).map((earlier) => `${earlier} before ${specifier}`),
    );
    expect(wrong).toEqual([]);
  });
});
