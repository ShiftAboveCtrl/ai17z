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

  it('never shows a release candidate to somebody on a stable version', async () => {
    // A candidate is not something to be nudged onto. Whoever is running one
    // chose it; whoever is not, did not.
    serve([release('v9.9.9-rc.1'), release('v0.0.1')]);
    const state = await updateState({ refresh: true });
    expect(state.latest?.prerelease ?? false).toBe(false);
    expect(state.updateAvailable).toBe(false);
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
