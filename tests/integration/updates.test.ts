import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ops } from '@xbam/database';
import { fetchLatestRelease, setUpdatesEnabled, skipVersion, updateState, updatesEnabled } from '@xbam/runtime';
import { installHarness } from '../support/harness';

installHarness();

interface FakeRelease {
  tag_name: string;
  name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: { name: string; browser_download_url: string }[];
}

function release(tag: string, extra: Partial<FakeRelease> = {}): FakeRelease {
  return {
    tag_name: tag,
    name: `AI17Z ${tag}`,
    body: '### What changed\n\n- Something',
    html_url: `https://github.com/ShiftAboveCtrl/ai17z/releases/tag/${tag}`,
    published_at: '2026-09-01T00:00:00.000Z',
    prerelease: tag.includes('-'),
    assets: [{ name: `AI17Z-Setup-${tag}.exe`, browser_download_url: `https://example.invalid/${tag}.exe` }],
    ...extra,
  };
}

/** Every call GitHub would have received, so "did it ask at all" is testable. */
let calls: string[] = [];

function serve(releases: FakeRelease[] | Error): void {
  vi.stubGlobal(
    'fetch',
    (async (url: string | URL) => {
      calls.push(String(url));
      if (releases instanceof Error) throw releases;
      return new Response(JSON.stringify(releases), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch,
  );
}

beforeEach(async () => {
  calls = [];
  // Every key this feature owns, so one test cannot leak into the next.
  await ops.setSetting('updates.check', null);
  await ops.setSetting('updates.skipped', null);
  await ops.setSetting('updates.enabled', null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The update check, which exists to answer a question the owner asked -- "is
 * there a newer one?" -- and to do nothing else. There is no path here that
 * downloads, installs, restarts, or decides anything on somebody's behalf.
 */
describe('finding out whether there is a newer version', () => {
  it('offers a release that is newer than this one', async () => {
    serve([release('v9.9.9')]);
    const state = await updateState({ refresh: true });
    expect(state.updateAvailable).toBe(true);
    expect(state.latest?.version).toBe('9.9.9');
    expect(state.latest?.installerUrl).toBe('https://example.invalid/v9.9.9.exe');
  });

  it('offers nothing when the newest release is this one or older', async () => {
    serve([release('v0.0.1')]);
    const state = await updateState({ refresh: true });
    expect(state.updateAvailable).toBe(false);
  });

  it('never shows a prerelease to somebody on a stable version', async () => {
    // A candidate is not something to be nudged onto. Whoever is running one
    // chose it; whoever is not, did not.
    //
    // The current version is passed in rather than taken from this checkout.
    // It used to be inherited, and the day package.json moved to a beta this
    // test started asserting the opposite of its own name and passing --
    // because the installation running it was, by then, on a prerelease.
    serve([release('v9.9.9-rc.1'), release('v0.0.1')]);
    expect(await fetchLatestRelease('1.0.0')).toMatchObject({ version: '0.0.1', prerelease: false });
  });

  it('does show one to somebody already on a prerelease', async () => {
    // The other half, and the reason the filter is conditional at all: an
    // owner running a beta with no way to hear about the next one is stranded
    // on it.
    serve([release('v9.9.9-rc.1'), release('v0.0.1')]);
    expect(await fetchLatestRelease('1.0.0-beta.1')).toMatchObject({ version: '9.9.9-rc.1' });
  });

  it('ignores a draft, which is not published to anybody', async () => {
    serve([release('v9.9.9', { draft: true })]);
    const state = await updateState({ refresh: true });
    expect(state.updateAvailable).toBe(false);
  });

  it('takes the newest, not the first GitHub happens to return', async () => {
    serve([release('v2.0.0'), release('v9.9.9'), release('v3.1.0')]);
    expect((await updateState({ refresh: true })).latest?.version).toBe('9.9.9');
  });

  it('asks for the list rather than /latest, which hides candidates entirely', async () => {
    serve([release('v9.9.9')]);
    await fetchLatestRelease('0.1.0');
    expect(calls[0]).toContain('/releases?');
    expect(calls[0]).not.toContain('/releases/latest');
  });
});

describe('not being made to update', () => {
  it('stops mentioning a version that was skipped', async () => {
    serve([release('v9.9.9')]);
    expect((await updateState({ refresh: true })).updateAvailable).toBe(true);

    await skipVersion('9.9.9');
    const after = await updateState();
    expect(after.updateAvailable).toBe(false);
    // Still known, and still reported -- skipped is not the same as absent.
    expect(after.latest?.version).toBe('9.9.9');
    expect(after.skipped).toBe('9.9.9');
  });

  it('still mentions a newer one after that', async () => {
    await skipVersion('9.9.9');
    serve([release('v9.9.10')]);
    expect((await updateState({ refresh: true })).updateAvailable).toBe(true);
  });

  it('makes no request at all when checking is switched off', async () => {
    serve([release('v9.9.9')]);
    await setUpdatesEnabled(false);
    const state = await updateState({ refresh: true });
    expect(calls).toHaveLength(0);
    expect(state.enabled).toBe(false);
    expect(state.updateAvailable).toBe(false);
    expect(state.latest).toBeNull();
  });

  it('is on unless somebody turned it off', async () => {
    expect(await updatesEnabled()).toBe(true);
    await setUpdatesEnabled(false);
    expect(await updatesEnabled()).toBe(false);
    await setUpdatesEnabled(true);
    expect(await updatesEnabled()).toBe(true);
  });
});

describe('what happens when GitHub cannot be reached', () => {
  it('reports the failure instead of throwing it', async () => {
    // An installation with no internet is not a broken one, and a screen that
    // says so is more use than one that quietly shows nothing.
    serve(new Error('getaddrinfo ENOTFOUND api.github.com'));
    const state = await updateState({ refresh: true });
    expect(state.error).toContain('ENOTFOUND');
    expect(state.updateAvailable).toBe(false);
  });

  it('keeps the last answer it did get', async () => {
    serve([release('v9.9.9')]);
    await updateState({ refresh: true });

    serve(new Error('network down'));
    const state = await updateState({ refresh: true });
    expect(state.error).toContain('network down');
    expect(state.latest?.version, 'the known release was forgotten').toBe('9.9.9');
    expect(state.updateAvailable).toBe(true);
  });

  it('says so when GitHub answers with a status rather than a list', async () => {
    vi.stubGlobal('fetch', (async () => new Response('rate limited', { status: 403 })) as unknown as typeof fetch);
    expect((await updateState({ refresh: true })).error).toContain('403');
  });
});

describe('how often it asks', () => {
  it('answers from the cache rather than asking again', async () => {
    serve([release('v9.9.9')]);
    await updateState({ refresh: true });
    expect(calls).toHaveLength(1);

    await updateState();
    await updateState();
    // Opening a screen must not send a request. GitHub rate-limits per address,
    // and an installation that asked on every page load would spend that on
    // everything else behind the same router.
    expect(calls).toHaveLength(1);
  });

  it('asks again when somebody presses the button', async () => {
    serve([release('v9.9.9')]);
    await updateState({ refresh: true });
    await updateState({ refresh: true });
    expect(calls).toHaveLength(2);
  });

  it('asks again once the answer is old', async () => {
    serve([release('v9.9.9')]);
    await updateState({ refresh: true });

    const stale = (await ops.getSetting<{ checkedAt: string }>('updates.check'))!;
    await ops.setSetting('updates.check', { ...stale, checkedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString() });

    await updateState();
    expect(calls).toHaveLength(2);
  });
});

/**
 * What the release is called.
 *
 * The number is what decides anything; the name is what somebody reads. A
 * heading that says `v1.0.0-beta.2` above the notes has told them nothing they
 * did not already get from the number beside it, and GitHub defaults a
 * release's name to exactly that.
 */
describe('what a release is called on the screen', () => {
  it('names this installation, as well as numbering it', async () => {
    serve([]);
    const state = await updateState({ refresh: true });
    expect(state.currentName).toMatch(/^AI17Z /);
    // The name is a rendering of the number; they cannot disagree.
    expect(state.currentName).toContain(state.current.replace(/-.*$/, ''));
  });

  it('renders a name for a release GitHub named after its own tag', async () => {
    serve([release('v9.9.9-beta.2', { name: 'v9.9.9-beta.2' })]);
    const state = await updateState({ refresh: true });
    expect(state.latest?.name).toBe('AI17Z Beta 9.9.9 (2)');
    expect(state.latest?.channel).toBe('Beta');
  });

  it('leaves a name somebody actually wrote alone', async () => {
    serve([release('v9.9.9', { name: 'The one where replies work' })]);
    const state = await updateState({ refresh: true });
    expect(state.latest?.name).toBe('The one where replies work');
  });

  it('renders a name when GitHub gives none at all', async () => {
    serve([release('v9.9.9', { name: undefined })]);
    const state = await updateState({ refresh: true });
    expect(state.latest?.name).toBe('AI17Z 9.9.9');
    // A finished release has no channel, and the screen must not label it one.
    expect(state.latest?.channel).toBeNull();
  });

  it('keeps the tag and the version exactly as they were, for comparing', async () => {
    serve([release('v9.9.9-rc.3')]);
    const state = await updateState({ refresh: true });
    expect(state.latest?.tag).toBe('v9.9.9-rc.3');
    expect(state.latest?.version).toBe('9.9.9-rc.3');
  });
});

/**
 * Which download an installation is pointed at.
 *
 * A release carries one executable -- the older full installer -- and one setup
 * script, which is what the recommended route runs. Which of them a copy should
 * be offered depends on how it was installed, so both are resolved **by name**.
 *
 * The rule this replaced took "the first asset ending in .exe". That was
 * unambiguous while a release had one, and briefly was not: for the period the
 * recommended route was also an executable, GitHub's upload ordering decided
 * which half of all installations got the wrong one.
 */
describe('picking the right download out of a release', () => {
  const both = (tag: string) =>
    release(tag, {
      assets: [
        { name: 'install.ps1', browser_download_url: 'https://example.invalid/stage-zero.ps1' },
        { name: `Install-AI17Z-${tag.replace(/^v/, '')}.ps1`, browser_download_url: 'https://example.invalid/setup.ps1' },
        { name: `AI17Z-Setup-${tag.replace(/^v/, '')}.exe`, browser_download_url: 'https://example.invalid/installer.exe' },
        { name: `AI17Z-App-${tag.replace(/^v/, '')}.zip`, browser_download_url: 'https://example.invalid/app.zip' },
        { name: 'SHA256SUMS.txt', browser_download_url: 'https://example.invalid/sums.txt' },
      ],
    });

  it('names them rather than taking whichever is listed first', async () => {
    serve([both('v9.9.9')]);
    const latest = await fetchLatestRelease('9.0.0');
    expect(latest?.installerUrl).toBe('https://example.invalid/installer.exe');
    expect(latest?.setupUrl).toBe('https://example.invalid/setup.ps1');
  });

  it('does not mistake the command for the setup program it fetches', async () => {
    // `install.ps1` is a few hundred lines whose whole job is to check a hash
    // and hand over. Offering it as the update would be offering the wrong
    // file, and it is listed first in the fixture for exactly that reason.
    serve([both('v9.9.9')]);
    const latest = await fetchLatestRelease('9.0.0');
    expect(latest?.setupUrl).not.toContain('stage-zero');
  });

  it('still answers for a release published before either name existed', async () => {
    serve([
      release('v9.9.9', {
        assets: [{ name: 'AI17Z-Setup-9.9.9.exe', browser_download_url: 'https://example.invalid/old.exe' }],
      }),
    ]);
    const latest = await fetchLatestRelease('9.0.0');
    expect(latest?.installerUrl).toBe('https://example.invalid/old.exe');
    // Nothing to offer the terminal route, and saying so beats inventing a URL.
    expect(latest?.setupUrl).toBeNull();
  });

  it('says so rather than guessing when a release has no installer at all', async () => {
    serve([release('v9.9.9', { assets: [{ name: 'SHA256SUMS.txt', browser_download_url: 'https://example.invalid/s' }] })]);
    const latest = await fetchLatestRelease('9.0.0');
    expect(latest?.installerUrl).toBeNull();
    expect(latest?.setupUrl).toBeNull();
  });

  it('carries the route through to the screen', async () => {
    serve([both('v9.9.9')]);
    const state = await updateState({ refresh: true });
    expect(state.updateAvailable).toBe(true);
    // The method is whatever this process's environment says, and what matters
    // here is that both links reach the screen so it can offer the right one.
    expect(state.latest?.setupUrl).toBeTruthy();
    expect(state.latest?.installerUrl).toBeTruthy();
    expect(['INSTALLER', 'BOOTSTRAP', 'CHECKOUT']).toContain(state.method);
  });
});
