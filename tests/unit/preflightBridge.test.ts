import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The word the updaters branch on has to be the word the bridge prints.
 *
 * `packaging/preflight.mts` is the only thing standing between an update and a
 * machine that cannot run it, and all three updaters reach it the same way: run
 * it under this installation's own tsx, read the first line, branch on `OK` or
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

const bridge = read('packaging/preflight.mts');

/** The two that branch in shell. Windows branches in PowerShell and is checked apart. */
const updaters = {
  ubuntu: read('packaging/ubuntu/ai17z-update.sh'),
  macos: read('packaging/macos/ai17z-update.sh'),
};
const windows = read('packaging/windows/Setup-AI17Z.ps1');

describe('the compatibility gate speaks one language', () => {
  it('prints exactly the three verdicts, and nothing else', () => {
    // Every literal the compatibility gate can put on its first line. The
    // bridge answers other questions too -- `--newer` below -- and each exits
    // before this one is reached, so they are excluded here by taking the file
    // from the gate's own argument parsing onwards rather than by name.
    const gate = bridge.slice(bridge.indexOf('const [manifestPath'));
    const printed = [...gate.matchAll(/console\.log\(\s*'([A-Z]+)'/g)].map((m) => m[1]);
    const firstLine = [...gate.matchAll(/console\.log\(verdict\.ok \? '([A-Z]+)' : '([A-Z]+)'\)/g)].flatMap((m) => [m[1], m[2]]);
    expect(new Set([...printed, ...firstLine])).toEqual(new Set(['SKIP', 'OK', 'NO']));
  });

  it.each(Object.entries(updaters))('%s branches on all three', (_platform, script) => {
    expect(script).toContain('NO*)');
    expect(script).toContain('OK*)');
    // The catch-all, written as `*)` rather than `SKIP*)` on purpose: a bridge
    // that cannot run prints nothing at all, and that has to land somewhere.
    //
    // Where it lands is the part that changed. It used to carry on with a
    // reassuring sentence, which is right for a release published before
    // manifests existed and wrong for a current installation whose gate is
    // broken -- and nothing at runtime could tell those apart. It now asks.
    expect(script).toMatch(/\*\)\s+gate_said_nothing/);
    expect(script).toContain('gate_said_nothing() {');
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
      expect(script).toContain('packaging/preflight.mts');
      // Never a global node. The bundled runtime is the pinned one, and the
      // whole point of shipping it is that nothing consults PATH.
      expect(script).toContain('ai17z_node');
    }
  });

  it('the bridge ships on every platform, from one list', () => {
    // In INCLUDE, which both packagers share. While it lived in the Unix-only
    // list, Windows shipped no gate and nothing said so.
    expect(read('tools/package-windows.mts')).toContain("'packaging/preflight.mts'");
    expect(read('tools/package-unix.mts')).not.toContain("'packaging/unix/preflight.mts'");
  });

  it('Windows asks the same bridge, and decides nothing itself', () => {
    expect(windows).toContain('packaging\\preflight.mts');
    expect(windows).toContain('node_modules\\tsx\\dist\\cli.mjs');
    // No second implementation. The floors live in the manifest and the
    // comparison lives in @xbam/shared; a PowerShell copy would be a second
    // thing to keep in step, and the one that drifted would be the one nobody
    // ran.
    expect(windows).not.toMatch(/minimumDocker/);
  });

  it('Windows asks before it stops a running installation', () => {
    const asks = windows.indexOf('Test-Ai17zReleaseFits $chosen');
    const stops = windows.indexOf('Stop-Ai17zForUpdate $layout');
    expect(asks).toBeGreaterThan(-1);
    expect(stops).toBeGreaterThan(-1);
    expect(asks).toBeLessThan(stops);
  });

  it('Windows refuses rather than warns, and says nothing changed', () => {
    const at = windows.indexOf("$read.Verdict -eq 'NO'");
    expect(at).toBeGreaterThan(-1);
    const refusal = windows.slice(at, at + 700);
    expect(refusal).toContain('Stop-Ai17z');
    expect(refusal).toContain('still installed and still running');
  });

  it('answers --newer by running it, on the case both shells got wrong', () => {
    // Run rather than read. The whole reason this mode exists is that two
    // shells each had a comparison that looked right and was not, and a test
    // that only greps the file would have agreed with both of them.
    //
    // `1.0.0` against `1.0.0-beta.19` is the pair that matters: it is the
    // upgrade every installation in this beta series eventually takes, and
    // `sort -V` and `dpkg --compare-versions` both rank it backwards -- checked
    // against those two commands, not assumed.
    const ask = (candidate: string, installed: string) => {
      const run = spawnSync(
        process.execPath,
        [resolve(root, 'node_modules/tsx/dist/cli.mjs'), resolve(root, 'packaging/preflight.mts'), '--newer', candidate, installed],
        { cwd: root, encoding: 'utf8' },
      );
      expect(run.status, `--newer ${candidate} ${installed} exited ${run.status}: ${run.stderr}`).toBe(0);
      return run.stdout.trim();
    };

    expect(ask('1.0.0', '1.0.0-beta.19')).toBe('NEWER');
    expect(ask('1.0.0-beta.20', '1.0.0-beta.19')).toBe('NEWER');
    expect(ask('1.0.0-beta.19', '1.0.0')).toBe('NOT-NEWER');
    // A reinstall of the same version is not an update.
    expect(ask('1.0.0-beta.19', '1.0.0-beta.19')).toBe('NOT-NEWER');
    // And a downgrade, which is the answer the whole check exists to give: an
    // older application against a database that has migrated forward has no
    // good ending.
    expect(ask('0.9.0', '1.0.0')).toBe('NOT-NEWER');
  }, 60_000);

  it('every packager proves the bridge answers, rather than checking it is present', () => {
    // A guard that lists files cannot catch a missing binary: tsx and esbuild
    // were both present and correct in a package where nothing could run.
    // One prover, exported and called by both, so no platform can be the one
    // that ships a gate nobody ran.
    const packager = read('tools/package-windows.mts');
    expect(packager).toContain('proving the update compatibility gate answers');
    expect(packager).toContain("proveCompatibilityGate(stageDir, 'windows', version)");
    expect(read('tools/package-unix.mts')).toContain('proveCompatibilityGate(stage, platform, version)');
    // Both halves. An OK-only check passes on a bridge that cannot start.
    expect(packager).toMatch(/startsWith\('OK'\)/);
    expect(packager).toMatch(/startsWith\('NO'\)/);
    // And the version comparison, which the same bridge answers. It matters
    // more here than the gate does: the gate fails open, so a dead bridge lets
    // updates through; this fails closed, so a dead bridge refuses all of them.
    expect(packager).toContain("askNewer(['1.0.0', '1.0.0-beta.19'])");
    expect(packager).toMatch(/newer !== 'NEWER'/);
    expect(packager).toMatch(/older !== 'NOT-NEWER'/);
  });

  it('the one comparator lives where both Unix updaters already look', () => {
    // The first version of this fix put a byte-identical function in each
    // updater. Two copies of one rule is what produced the fault being fixed --
    // each platform asked its own shell and both were wrong the same way -- so
    // fixing it with two copies of the fix would have been the same mistake in
    // a better disguise.
    const shared = read('packaging/unix/ai17z-paths.sh');
    expect(shared).toMatch(/^ai17z_version_is_newer\(\) \{/m);
    for (const [platform, script] of Object.entries(updaters)) {
      expect(script, `${platform} does not use it`).toContain('ai17z_version_is_newer "$VERSION" "$CURRENT"');
      expect(script, `${platform} defines its own`).not.toMatch(/^ai17z_version_is_newer\(\)/m);
      expect(script, `${platform} sources nothing`).toContain('ai17z-paths.sh');
    }
  });
});
