import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ops } from '@xbam/database';
import { fetchLatestRelease, setUpdatesEnabled, skipVersion, updateState, updatesEnabled } from '@xbam/runtime';
import { betaLabelFor } from '@xbam/shared';
import { installHarness } from '../support/harness';

installHarness();

const REPO = 'ShiftAboveCtrl/ai17z';
const DOWNLOAD = `https://github.com/${REPO}/releases/download`;

/**
 * One release as the world can see it, through the two routes that cost no
 * REST budget: the feed entry, and the files published under its own tag.
 *
 * `manifest: null` is a release that exists and is not finished. `notes: null`
 * is one published before notes became an asset.
 */
interface FakeRelease {
  tag: string;
  title?: string;
  updated?: string;
  manifest?: Record<string, unknown> | null;
  notes?: string | null;
}

function release(tag: string, extra: Partial<FakeRelease> = {}): FakeRelease {
  return {
    tag,
    title: `AI17Z ${tag}`,
    updated: '2026-09-01T00:00:00.000Z',
    manifest: { schemaVersion: 1, version: tag.replace(/^v/, ''), tag },
    notes: '### What changed\n\n- Something',
    ...extra,
  };
}

function atom(releases: FakeRelease[]): string {
  const entries = releases
    .map(
      (entry) => `<entry>
  <id>tag:github.com,2008:Repository/1/${entry.tag}</id>
  <updated>${entry.updated ?? ''}</updated>
  <link rel="alternate" type="text/html" href="https://github.com/${REPO}/releases/tag/${entry.tag}"/>
  <title>${entry.title ?? ''}</title>
  <content type="html">&lt;h3&gt;rendered, which is the wrong thing for a Markdown renderer&lt;/h3&gt;</content>
</entry>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n${entries}\n</feed>`;
}

/** Every URL GitHub would have received, so "did it ask at all" is testable. */
let calls: string[] = [];
const feedCalls = () => calls.filter((url) => url.endsWith('releases.atom'));
const restCalls = () => calls.filter((url) => url.includes('api.github.com'));

/**
 * The world, served the way the update path actually reaches it.
 *
 * Anything asking `api.github.com` is answered 403 on purpose. That is the
 * exhausted anonymous budget an agent watching a repository produces, and the
 * point of these tests is that the update path never touches it.
 */
function serve(releases: FakeRelease[] | Error, options: { restStatus?: number } = {}): void {
  vi.stubGlobal(
    'fetch',
    (async (url: string | URL) => {
      const href = String(url);
      calls.push(href);
      if (releases instanceof Error) throw releases;

      if (href.includes('api.github.com')) {
        return new Response('{"message":"API rate limit exceeded"}', { status: options.restStatus ?? 403 });
      }
      if (href.endsWith('releases.atom')) {
        return new Response(atom(releases), { status: 200, headers: { 'content-type': 'application/atom+xml' } });
      }
      for (const entry of releases) {
        const base = `${DOWNLOAD}/${entry.tag}/`;
        if (href === `${base}release-manifest.json`) {
          if (entry.manifest === null) return new Response('Not Found', { status: 404 });
          return new Response(JSON.stringify(entry.manifest), { status: 200 });
        }
        if (href === `${base}release-notes.md`) {
          if (entry.notes === null) return new Response('Not Found', { status: 404 });
          return new Response(entry.notes, { status: 200 });
        }
      }
      return new Response('Not Found', { status: 404 });
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
    expect(state.latest?.installerUrl).toBe(`${DOWNLOAD}/v9.9.9/AI17Z-Setup-9.9.9.exe`);
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
    // test started asserting the opposite of its own name and passing.
    serve([release('v9.9.9-rc.1'), release('v0.0.1')]);
    expect(await fetchLatestRelease('1.0.0')).toMatchObject({ version: '0.0.1', prerelease: false });
  });

  it('does show one to somebody already on a prerelease', async () => {
    // The other half, and the reason the filter is conditional at all: an
    // owner running a beta with no way to hear about the next one is stranded.
    serve([release('v9.9.9-rc.1'), release('v0.0.1')]);
    expect(await fetchLatestRelease('1.0.0-beta.1')).toMatchObject({ version: '9.9.9-rc.1' });
  });

  it('never sees a draft, because a draft has no feed entry', async () => {
    // The REST path had to filter drafts by hand. The feed publishes only what
    // is published, so the exclusion is structural rather than remembered.
    serve([release('v0.0.1')]);
    const state = await updateState({ refresh: true });
    expect(state.updateAvailable).toBe(false);
  });

  it('takes the newest, not the first the feed happens to list', async () => {
    serve([release('v2.0.0'), release('v9.9.9'), release('v3.1.0')]);
    expect((await updateState({ refresh: true })).latest?.version).toBe('9.9.9');
  });

  it('reads the feed and never the REST API', async () => {
    serve([release('v9.9.9')]);
    await fetchLatestRelease('0.1.0');
    expect(feedCalls()).toHaveLength(1);
    expect(restCalls()).toHaveLength(0);
    // `/releases/latest` hides prereleases, which is every release so far.
    expect(calls.some((url) => url.includes('/releases/latest'))).toBe(false);
  });
});

/**
 * The defect this architecture exists to close.
 *
 * An agent told to watch a repository polls GitHub through the REST API, and
 * the unauthenticated allowance is sixty an hour for the whole address. Two
 * installations on one connection exhaust it, and what went blind was the
 * updater: a release sat published and downloadable while the update check
 * reported that it could not reach GitHub to see which version.
 */
describe('not being starved by the agent that watches GitHub', () => {
  it('finds the release while the REST budget is exhausted', async () => {
    // Every api.github.com request in this harness answers 403 rate limited.
    serve([release('v9.9.9')]);
    const state = await updateState({ refresh: true });
    expect(state.updateAvailable).toBe(true);
    expect(state.latest?.version).toBe('9.9.9');
    expect(state.error).toBeNull();
  });

  it('does not spend a single REST request doing it', async () => {
    serve([release('v9.9.9')]);
    await updateState({ refresh: true });
    expect(restCalls()).toEqual([]);
  });

  it('needs no token, and gains no privilege from one', async () => {
    serve([release('v9.9.9')]);
    await updateState({ refresh: true });
    // Nothing on this path may carry a credential. A PAT is not required, and
    // there is nowhere for one to be sent even if somebody set it.
    expect(calls.every((url) => !url.includes('token') && !url.includes('access_token'))).toBe(true);
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
    serve(new Error('getaddrinfo ENOTFOUND github.com'));
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

  it('says so when the feed answers with a status rather than a document', async () => {
    vi.stubGlobal('fetch', (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch);
    expect((await updateState({ refresh: true })).error).toContain('503');
  });

  it('offers nothing rather than something when discovery fails', async () => {
    serve(new Error('network down'));
    const state = await updateState({ refresh: true });
    // The whole point of failing closed: a failed check must never resolve to
    // a version, because the next thing that happens is an install.
    expect(state.latest).toBeNull();
    expect(state.updateAvailable).toBe(false);
  });

  it('asks a bounded number of times and then stops', async () => {
    serve(new Error('network down'));
    await updateState({ refresh: true });
    // One attempt per check. A failing network must not turn the update check
    // into a retry loop against somebody else's server.
    expect(calls.length).toBeLessThanOrEqual(1);
  });
});

/**
 * A release is only installable once its packages are published.
 *
 * The feed carries an entry the moment a release is created, and the assets
 * arrive afterwards. The manifest is what says the release is finished, and an
 * absent one is a refusal rather than an older version quietly offered instead.
 */
describe('a release that is not finished yet', () => {
  it('refuses when the newest release has published no manifest', async () => {
    serve([release('v9.9.9', { manifest: null }), release('v9.9.8')]);
    const state = await updateState({ refresh: true });
    expect(state.latest).toBeNull();
    expect(state.error).toContain('not ready to install');
  });

  it('refuses when the manifest names a different version than its tag', async () => {
    // A tag and a manifest that disagree is a release built from something
    // other than what the tag points at.
    serve([release('v9.9.9', { manifest: { version: '1.2.3', tag: 'v1.2.3' } })]);
    const state = await updateState({ refresh: true });
    expect(state.latest).toBeNull();
    expect(state.error).toContain('disagree');
  });

  it('refuses a manifest that is not a document at all', async () => {
    vi.stubGlobal(
      'fetch',
      (async (url: string | URL) => {
        const href = String(url);
        calls.push(href);
        if (href.endsWith('releases.atom')) return new Response(atom([release('v9.9.9')]), { status: 200 });
        if (href.endsWith('release-manifest.json')) return new Response('<html>not json</html>', { status: 200 });
        return new Response('', { status: 404 });
      }) as unknown as typeof fetch,
    );
    const state = await updateState({ refresh: true });
    expect(state.latest).toBeNull();
    expect(state.error).not.toBeNull();
  });
});

describe('how often it asks', () => {
  it('answers from the cache rather than asking again', async () => {
    serve([release('v9.9.9')]);
    await updateState({ refresh: true });
    expect(feedCalls()).toHaveLength(1);

    await updateState();
    await updateState();
    // Opening a screen must not send a request. GitHub rate-limits per address,
    // and an installation that asked on every page load would spend that on
    // everything else behind the same router.
    expect(feedCalls()).toHaveLength(1);
  });

  it('asks again when somebody presses the button', async () => {
    serve([release('v9.9.9')]);
    await updateState({ refresh: true });
    await updateState({ refresh: true });
    expect(feedCalls()).toHaveLength(2);
  });

  it('asks again once the answer is old', async () => {
    serve([release('v9.9.9')]);
    await updateState({ refresh: true });

    const stale = (await ops.getSetting<{ checkedAt: string }>('updates.check'))!;
    await ops.setSetting('updates.check', { ...stale, checkedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString() });

    await updateState();
    expect(feedCalls()).toHaveLength(2);
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
    // The name is a rendering of the number and the two cannot disagree. For a
    // beta the link is the iteration rather than the core: `1.0.0-beta.20` is
    // "Beta 3.0", and the 20 is what the 3.0 is made of. Asserted by deriving
    // it the same way rather than by repeating the arithmetic here.
    const iteration = Number(/-beta\.(\d+)/.exec(state.current)?.[1] ?? 0);
    if (iteration > 0) {
      expect(state.currentName).toBe(`AI17Z Beta ${betaLabelFor(iteration)}`);
      // And the number is still on the screen, beside it, for a bug report.
      expect(state.current).toMatch(/^\d+\.\d+\.\d+-beta\.\d+$/);
    } else {
      expect(state.currentName).toContain(state.current.replace(/-.*$/, ''));
    }
  });

  it('renders a name for a release GitHub named after its own tag', async () => {
    serve([release('v9.9.9-beta.2', { title: 'v9.9.9-beta.2' })]);
    const state = await updateState({ refresh: true });
    // The beta label counts betas and says nothing about the core version, so
    // `9.9.9-beta.2` reads the same as `1.0.0-beta.2` would. That is what a
    // flat counter means and it is deliberate.
    expect(state.latest?.name).toBe('AI17Z Beta 1.2');
    expect(state.latest?.channel).toBe('Beta');
    expect(state.latest?.version).toBe('9.9.9-beta.2');
  });

  it('leaves a name somebody actually wrote alone', async () => {
    serve([release('v9.9.9', { title: 'The one where replies work' })]);
    const state = await updateState({ refresh: true });
    expect(state.latest?.name).toBe('The one where replies work');
  });

  it('renders a name when the feed carries none at all', async () => {
    serve([release('v9.9.9', { title: '' })]);
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
 * script, which is what the recommended route runs. Both are now composed from
 * the tag rather than looked up in a list, because their names are fixed by the
 * release and `releaseManifest.ts` is the one place that spells them. That
 * costs no request and cannot disagree with what was published.
 */
describe('picking the right download out of a release', () => {
  it('addresses both by name, at the exact tag', async () => {
    serve([release('v9.9.9')]);
    const latest = await fetchLatestRelease('9.0.0');
    expect(latest?.installerUrl).toBe(`${DOWNLOAD}/v9.9.9/AI17Z-Setup-9.9.9.exe`);
    expect(latest?.setupUrl).toBe(`${DOWNLOAD}/v9.9.9/Install-AI17Z-9.9.9.ps1`);
  });

  it('does not mistake the command for the setup program it fetches', async () => {
    // `install.ps1` is a few hundred lines whose whole job is to check a hash
    // and hand over. Offering it as the update would be offering the wrong file.
    serve([release('v9.9.9')]);
    const latest = await fetchLatestRelease('9.0.0');
    expect(latest?.setupUrl).not.toContain('install.ps1');
    expect(latest?.setupUrl).toContain('Install-AI17Z-');
  });

  it('never points at anything outside the release it named', async () => {
    serve([release('v9.9.9')]);
    const latest = await fetchLatestRelease('9.0.0');
    for (const url of [latest?.installerUrl, latest?.setupUrl, latest?.url]) {
      expect(url).toContain(`${REPO}/releases`);
      expect(url).toMatch(/^https:\/\/github\.com\//);
    }
  });

  it('carries the route through to the screen', async () => {
    serve([release('v9.9.9')]);
    const state = await updateState({ refresh: true });
    expect(state.latest?.installerUrl).toContain('AI17Z-Setup-');
    expect(state.method).toBeTruthy();
  });
});

/**
 * The notes, which are worth reading and are not worth failing a check over.
 */
describe('the release notes', () => {
  it('reads the Markdown that was published, not the rendered feed copy', async () => {
    serve([release('v9.9.9', { notes: '### What changed\n\n- A thing' })]);
    const latest = await fetchLatestRelease('9.0.0');
    expect(latest?.notes).toContain('### What changed');
    // The feed's own copy is HTML, which is the wrong thing to hand a Markdown
    // renderer, so it must not be what arrives here.
    expect(latest?.notes).not.toContain('&lt;h3&gt;');
    expect(latest?.notes).not.toContain('<h3>');
  });

  it('still offers the update when a release published no notes', async () => {
    serve([release('v9.9.9', { notes: null })]);
    const latest = await fetchLatestRelease('9.0.0');
    expect(latest?.version).toBe('9.9.9');
    expect(latest?.notes).toBe('');
  });
});
