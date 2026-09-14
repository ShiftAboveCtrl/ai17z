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
