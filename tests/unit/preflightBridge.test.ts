import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The word the updaters branch on has to be the word the bridge prints.
 *
 * `packaging/unix/preflight.mts` is the only thing standing between an update
 * and a machine that cannot run it, and both Unix updaters reach it the same
 * way: run it under the bundled tsx, read the first line, branch on `OK` or
 * `NO`, and treat anything else as "no manifest here, carry on".
 *
 * That last branch is why this file exists. Carrying on is correct for a
 * release published before manifests existed, and it is also what happens when
 * the bridge cannot start, when its output is redirected away, or when
 * somebody renames a verdict. The gate fails open and says the same reassuring
 * sentence either way. Nothing at runtime can tell those apart, so the
 * agreement is pinned here instead.
 *
 * Running the bridge for real -- in a staged package, with its own tsx and its
 * own `@xbam/shared` -- is `tools/package-unix.mts`, on every build.
 */

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const bridge = read('packaging/unix/preflight.mts');
const updaters = {
  ubuntu: read('packaging/ubuntu/ai17z-update.sh'),
  macos: read('packaging/macos/ai17z-update.sh'),
};

describe('the compatibility gate speaks one language', () => {
  it('prints exactly the three verdicts, and nothing else', () => {
    // Every literal the bridge can put on its first line.
    const printed = [...bridge.matchAll(/console\.log\(\s*'([A-Z]+)'/g)].map((m) => m[1]);
    const firstLine = [...bridge.matchAll(/console\.log\(verdict\.ok \? '([A-Z]+)' : '([A-Z]+)'\)/g)].flatMap((m) => [m[1], m[2]]);
    expect(new Set([...printed, ...firstLine])).toEqual(new Set(['SKIP', 'OK', 'NO']));
  });

  it.each(Object.entries(updaters))('%s branches on all three', (_platform, script) => {
    expect(script).toContain('NO*)');
    expect(script).toContain('OK*)');
    // The catch-all. Written as `*)` rather than `SKIP*)` on purpose: a bridge
    // that cannot run prints nothing at all, and that has to land somewhere.
    expect(script).toMatch(/\*\)\s+note "Could not read this release's compatibility manifest/);
  });

  it.each(Object.entries(updaters))('%s asks before it stops anything', (_platform, script) => {
    // The property the whole gate exists for: "no" has to be survivable. An
    // update that discovers the problem after replacing the application has
    // already taken the working version away from somebody.
    const asks = script.indexOf('preflight.mts');
    const stops = script.search(/^\s*(stop_ai17z|ai17z_stop|.*lifecycle\.sh" stop)/m);
    expect(asks).toBeGreaterThan(-1);
    if (stops > -1) expect(asks).toBeLessThan(stops);
  });

  it.each(Object.entries(updaters))('%s refuses rather than warns, and says nothing changed', (_platform, script) => {
    const refusal = script.slice(script.indexOf('NO*)'), script.indexOf('OK*)'));
    expect(refusal).toMatch(/oops/);
    expect(refusal).toMatch(/still installed and still running/);
  });

  it.each(Object.entries(updaters))('%s translates its architecture into the one the manifest uses', (_platform, script) => {
    // `uname -m` says x86_64 and dpkg says amd64; the manifest says x64. A
    // platform that passed its own spelling through would be told there is no
    // build for it and would refuse a release that supports it perfectly well.
    expect(script).toMatch(/x86_64\) ARCH=x64|= amd64 \] && echo x64/);
  });

  it('both updaters run the same bridge, under the bundled runtime', () => {
    for (const script of Object.values(updaters)) {
      expect(script).toContain('node_modules/tsx/dist/cli.mjs');
      expect(script).toContain('packaging/unix/preflight.mts');
      // Never a global node. The bundled runtime is the pinned one, and the
      // whole point of shipping it is that nothing consults PATH.
      expect(script).toContain('ai17z_node');
    }
  });

  it('the bridge ships in both packages', () => {
    const packager = read('tools/package-unix.mts');
    expect(packager).toContain('packaging/unix/preflight.mts');
  });

  it('the packager proves the bridge answers, rather than checking it is present', () => {
    // A guard that lists files cannot catch a missing binary: tsx and esbuild
    // were both present and correct in a package where nothing could run.
    const packager = read('tools/package-unix.mts');
    expect(packager).toContain('proving the update compatibility gate answers');
    // Both halves. An OK-only check passes on a bridge that cannot start.
    expect(packager).toMatch(/startsWith\('OK'\)/);
    expect(packager).toMatch(/startsWith\('NO'\)/);
  });
});
