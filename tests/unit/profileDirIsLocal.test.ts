import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultProfileDir, profilePathIsLocal, resolveProfileDir } from '@xbam/browser';

/**
 * Where a browser profile is, decided by the machine opening the browser.
 *
 * Reported from a real Mac running the published Beta 1.0.0 (19): connecting an
 * X account never opened a window. The `OPEN_AUTH` task was queued, claimed by
 * the native worker, and failed in half a second with
 *
 *     ENOENT: no such file or directory, mkdir '/app'
 *
 * because `browser_sessions.profile_dir` held
 * `/app/storage/browser-profiles/<accountId>`. The API writes that row, the API
 * runs in a container whose working directory is `/app`, and
 * `defaultProfileDir` resolves `./storage/browser-profiles` against it. The
 * worker then used the stored value, because `resolveProfileDir` returned it
 * whenever `profilePathIsLocal` agreed -- and that function separates a Windows
 * path from a POSIX one and nothing else. A Linux container path is a POSIX
 * path, so on macOS it passed.
 *
 * `docs/ENGINEERING.md` and the function's own docstring both already said a
 * stored profile path is not trusted across machines. This is the difference
 * between saying it and doing it.
 *
 * These are pure functions, so they are tested here rather than in
 * `tests/integration/realChrome.test.ts` -- which skips wherever Chrome is
 * absent, and therefore skipped on every machine that built this package.
 */
describe('a stored profile path never decides where a browser opens', () => {
  const account = 'abc-123';

  it('ignores the path the containerised API writes', () => {
    // The exact value off the Mac that reported this.
    const fromTheContainer = '/app/storage/browser-profiles/abc-123';
    const resolved = resolveProfileDir(account, fromTheContainer);
    expect(resolved).not.toBe(fromTheContainer);
    expect(resolved).toBe(defaultProfileDir(account));
  });

  it('ignores a path from the other kind of machine', () => {
    for (const foreign of [
      '/app/storage/browser-profiles/abc-123',
      'C:\\Users\\someone\\storage\\browser-profiles\\abc-123',
      '/home/someone-else/profiles/abc-123',
      '/Users/username/Library/Application Support/AI17Z/AI17Z/browser-profiles/abc-123',
    ]) {
      expect(resolveProfileDir(account, foreign), `${foreign} was used`).toBe(defaultProfileDir(account));
    }
  });

  it('ignores a stored path even when it is the one this machine would pick', () => {
    // Same answer, arrived at the same way. The row is never the source.
    const ours = defaultProfileDir(account);
    expect(resolveProfileDir(account, ours)).toBe(ours);
  });

  it('needs no stored path at all', () => {
    expect(resolveProfileDir(account, null)).toBe(defaultProfileDir(account));
    expect(resolveProfileDir(account, undefined)).toBe(defaultProfileDir(account));
    expect(resolveProfileDir(account, '')).toBe(defaultProfileDir(account));
  });

  it('keeps the account id, which is the identity', () => {
    expect(resolveProfileDir(account, null)).toContain(account);
    expect(resolveProfileDir('other-id', '/app/storage/browser-profiles/abc-123')).toContain('other-id');
  });

  it('leaves profilePathIsLocal as a description rather than a decision', () => {
    // Kept, and deliberately not used to choose a path. This is the assertion
    // that says why: on anything but Windows it accepts the container path that
    // caused the fault.
    if (process.platform !== 'win32') {
      expect(profilePathIsLocal('/app/storage/browser-profiles/abc-123')).toBe(true);
    }
    // And the resolver does not care what it says.
    expect(resolveProfileDir(account, '/app/storage/browser-profiles/abc-123')).toBe(defaultProfileDir(account));
  });
});

/**
 * Nothing works out where a profile is for itself.
 *
 * `resolveProfileDir` derives it from the account id and this process's own
 * configuration, and that is the whole point: the path depends on the
 * installation, on `AI17Z_BROWSER_PROFILE_DIR`, and on the instance segment
 * that keeps two installations on one machine apart.
 *
 * The Response Lab used to build it by hand instead, as a relative
 * `storage/browser-profiles/<account>/ai17z-cdp.json`. That resolved against
 * whatever directory it was started from, omitted the instance segment, and
 * ignored the variable every installed copy sets. So the Lab could not be run
 * against a real installation, which is the only place it has a browser to run
 * against, and where a stale file happened to exist it connected to a port
 * whose Chrome had been gone for days. Three copies of the same line, in one
 * file.
 */
describe('nothing builds a profile path by hand', () => {
  const root = resolve(__dirname, '../..');

  it('the Response Lab asks for the profile rather than composing one', () => {
    const lab = readFileSync(resolve(root, 'tools/scenarios/run.mts'), 'utf8');
    expect(lab).toContain('resolveProfileDir');
    expect(lab).toContain('existingChrome');
    // The exact shape that was wrong, in any of its three places.
    expect(lab).not.toMatch(/storage\/browser-profiles\/\$\{/);
  });

  it('no tool composes one either', () => {
    for (const file of ['tools/scenarios/run.mts', 'tools/soak.mts']) {
      const source = readFileSync(resolve(root, file), 'utf8');
      expect(source, `${file} builds a profile path by hand`).not.toMatch(
        /storage\/browser-profiles\/\$\{/,
      );
    }
  });
});

/**
 * A harness that tested nothing must not read as a harness that found nothing.
 *
 * Both of these were measured against a real installation on the same run. The
 * Response Lab was pointed at an agent whose automation is MANUAL_ONLY, which
 * is an ordinary setting and the right one for an installation somebody is
 * still watching. Every one of the eighty-three scenarios was recorded, none
 * was queued, and the summary said "0 scenarios, 0 problems" and exited zero.
 *
 * Two separate faults, and the second is the dangerous one: the first made the
 * Lab unusable where it matters, and the second made that look like a pass.
 */
describe('the Response Lab cannot pass without running', () => {
  const lab = readFileSync(resolve(__dirname, '../../tools/scenarios/run.mts'), 'utf8');

  it('counts a scenario that queued nothing as one that never ran', () => {
    expect(lab).toContain('neverRan');
    expect(lab).toContain('This is not a pass. Nothing above was exercised.');
    // And says so by failing, not only by printing.
    expect(lab).toMatch(/neverRan\.length > 0[\s\S]{0,900}process\.exitCode = 1/);
  });

  it('still treats the duplicate scenario as the pass it is', () => {
    // There, queueing nothing is exactly what is under test, so it must not be
    // counted as a scenario that failed to run.
    expect(lab).toMatch(/if \(!scenario\.reuseEventIdOf\) neverRan\.push/);
  });

  it('names the agent it is driving, so an ordinary setting cannot mute it', () => {
    // `ingest.ts` treats a named agent as the manual trigger this is, which is
    // what lets the Lab run against MANUAL_ONLY and MONITOR_ONLY.
    expect(lab).toContain('onlyAgentId: agent.id');
  });

  it('still cannot publish without being asked twice', () => {
    // Unchanged by any of the above, and the reason this harness is safe to
    // run at all: --live takes an explicit count and nothing else publishes.
    expect(lab).toContain('dryRun: !live');
    expect(lab).toContain("--live needs a count between 1 and 10");
  });
});
