/**
 * Whether there is a newer AI17Z, and what changed in it.
 *
 * The shape of this is a deliberate answer to "am I being forced to update?".
 * Nothing here downloads anything, nothing replaces a running installation, and
 * nothing nags. It asks GitHub what has been released, compares that to what is
 * running, and puts the release notes on a screen. Everything after that is a
 * person clicking something.
 *
 * Three properties worth stating plainly, because an update mechanism that has
 * any of them wrong is one people learn to distrust:
 *
 *   - **It is a check, not an agent.** There is no updater process, no
 *     scheduled restart, and no code path that installs anything. The download
 *     is a link.
 *   - **It can be turned off**, and then it makes no request at all. The check
 *     is the only thing in AI17Z that talks to a server we control the
 *     repository of, so it is the one thing somebody might reasonably want
 *     silent. See `docs/PRIVACY.md`.
 *   - **A skipped version stays skipped.** "Not now" and "never for this one"
 *     are different answers and both are honoured.
 *
 * Release candidates are offered only to installations already running one. An
 * owner on a stable version is not shown a prerelease, because "there is an
 * update" reading as "there is a beta" is how people end up on builds they did
 * not choose.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ops } from '@xbam/database';
import { buildVersion, createLogger, errorMessage, nowIso, releaseName } from '@xbam/shared';

const log = createLogger('updates');

/** Long enough for a slow connection, short enough not to hold a screen. */
const TIMEOUT_MS = 8_000;

/**
 * How long an answer is reused.
 *
 * A version is published every few weeks at most, so asking more often than
 * this buys nothing and spends somebody's rate limit. Unauthenticated GitHub
 * requests are limited per IP address, and an installation that asked on every
 * page load would exhaust that for everything else on the same network.
 */
const CACHE_MS = 6 * 60 * 60 * 1000;

const CHECK_KEY = 'updates.check';
const SKIPPED_KEY = 'updates.skipped';
const ENABLED_KEY = 'updates.enabled';

const REPOSITORY = process.env.AI17Z_UPDATE_REPO ?? 'ShiftAboveCtrl/ai17z';

export interface ReleaseInfo {
  /** The version, with no leading v: `0.1.1`, `0.2.0-rc.1`. */
  version: string;
  /** What GitHub calls it, which is what a URL needs. */
  tag: string;
  /** The readable name: `AI17Z Beta 1.0.0`. */
  name: string;
  /**
   * `Beta`, `Release Candidate`, or null for a finished release.
   *
   * Derived here rather than in the browser, because the version grammar has
   * one implementation and `apps/web` cannot import it -- `version.ts` reads
   * files and runs git.
   */
  channel: string | null;
  /** The release notes, as written. Markdown. */
  notes: string;
  url: string;
  /** The Windows installer, when the release has one. */
  installerUrl: string | null;
  publishedAt: string;
  prerelease: boolean;
}

export interface UpdateState {
  /** What is running here. */
  current: string;
  /** What that is called: `AI17Z Beta 1.0.0`. The number is still `current`. */
  currentName: string;
  latest: ReleaseInfo | null;
  /** Newer than this installation, and not one the owner has skipped. */
  updateAvailable: boolean;
  /** The version the owner said never to mention again, if any. */
  skipped: string | null;
  enabled: boolean;
  checkedAt: string | null;
  /**
   * Why the last check did not produce an answer.
   *
   * Kept rather than thrown: an installation with no internet is not broken,
   * and a screen that says "could not reach GitHub" is more use than one that
   * silently shows nothing.
   */
  error: string | null;
  /**
   * How this installation would take the update.
   *
   * `INSTALLER` means it was installed from the Windows package and the update
   * is a new installer to run. `CHECKOUT` means it is a clone and the update is
   * `update-ai17z.ps1`. The difference decides which button makes sense, and
   * offering the wrong one is how somebody ends up running `git pull` on a
   * directory with no repository in it.
   */
  method: 'INSTALLER' | 'CHECKOUT';
}

interface CachedCheck {
  checkedAt: string;
  release: ReleaseInfo | null;
  error: string | null;
}

/**
 * Semver precedence, in the part of it AI17Z actually uses.
 *
 * Returns negative when `a` is older. The one rule people get wrong is that a
 * prerelease is *older* than the release it leads to: `0.1.0-rc.4` comes before
 * `0.1.0`. Getting that backwards offers everybody on a stable build a
 * downgrade to last month's candidate.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const [core = '', pre = ''] = value.replace(/^v/, '').split('-', 2);
    const numbers = core.split('.').map((part) => Number.parseInt(part, 10) || 0);
    return { numbers, pre };
  };
  const left = parse(a);
  const right = parse(b);

  for (let i = 0; i < 3; i += 1) {
    const difference = (left.numbers[i] ?? 0) - (right.numbers[i] ?? 0);
    if (difference !== 0) return difference;
  }

  if (left.pre === right.pre) return 0;
  // No prerelease beats any prerelease.
  if (!left.pre) return 1;
  if (!right.pre) return -1;

  const leftParts = left.pre.split('.');
  const rightParts = right.pre.split('.');
  for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i += 1) {
    const l = leftParts[i];
    const r = rightParts[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const both = /^\d+$/.test(l) && /^\d+$/.test(r);
    const difference = both ? Number(l) - Number(r) : l.localeCompare(r);
    if (difference !== 0) return difference;
  }
  return 0;
}

interface GitHubRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: { name?: string; browser_download_url?: string }[];
}

function toRelease(raw: GitHubRelease): ReleaseInfo | null {
  const tag = raw.tag_name?.trim();
  if (!tag) return null;
  const version = tag.replace(/^v/, '');
  const installer = (raw.assets ?? []).find((asset) => asset.name?.toLowerCase().endsWith('.exe'));

  // GitHub defaults a release's name to its tag, and a heading that reads
  // `v1.0.0-beta.2` above the notes tells somebody nothing they did not get
  // from the number beside it. A name that is only the tag is treated as no
  // name and rendered; a name somebody actually wrote is left alone.
  const named = releaseName(version);
  const written = raw.name?.trim();
  const name = written && written !== tag && written !== version ? written : named.title;

  return {
    version,
    tag,
    name,
    channel: named.channel,
    notes: raw.body?.trim() ?? '',
    url: raw.html_url ?? `https://github.com/${REPOSITORY}/releases/tag/${tag}`,
    installerUrl: installer?.browser_download_url ?? null,
    publishedAt: raw.published_at ?? nowIso(),
    prerelease: Boolean(raw.prerelease),
  };
}

/**
 * The newest release this installation would accept.
 *
 * `/releases/latest` is not used, because it excludes prereleases entirely --
 * which would leave everybody running a release candidate with no way to hear
 * about the next one.
 */
export async function fetchLatestRelease(current = buildVersion().version): Promise<ReleaseInfo | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=20`, {
      headers: {
        accept: 'application/vnd.github+json',
        // GitHub asks for one, and an unidentified client is rate-limited
        // harder. It names the product and nothing about the machine.
        'user-agent': 'AI17Z',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GitHub answered ${response.status} ${response.statusText}`.trim());
    }
    const raw = (await response.json()) as GitHubRelease[];
    const onPrerelease = compareVersions(current, current.replace(/-.*$/, '')) < 0;

    const candidates = raw
      .filter((entry) => !entry.draft)
      .map(toRelease)
      .filter((entry): entry is ReleaseInfo => entry !== null)
      // Somebody on a stable version is never shown a candidate build.
      .filter((entry) => onPrerelease || !entry.prerelease)
      .sort((a, b) => compareVersions(b.version, a.version));

    return candidates[0] ?? null;
  } finally {
    clearTimeout(timer);
  }
}

/** Whether checking is switched on. Default yes, and it is one setting. */
export async function updatesEnabled(): Promise<boolean> {
  const stored = await ops.getSetting<boolean>(ENABLED_KEY);
  return stored === null ? true : Boolean(stored);
}

export async function setUpdatesEnabled(enabled: boolean): Promise<void> {
  await ops.setSetting(ENABLED_KEY, enabled);
}

/** Never mention this version again. A different, newer one still appears. */
export async function skipVersion(version: string): Promise<void> {
  await ops.setSetting(SKIPPED_KEY, version.replace(/^v/, ''));
}

/**
 * How this installation takes an update.
 *
 * Not from `buildVersion().source`, which says how the *commit* was found. A
 * developer's containers are built from a checkout and report `build` there
 * like any other image, so that test told a developer to go and download an
 * installer.
 *
 * The honest signal is the stamp the packager writes: `BUILD_INFO.json` exists
 * beside an installed application and nowhere else. The launcher passes it on
 * as `AI17Z_INSTALLED`, because a container has neither that file nor a
 * repository to ask.
 */
function updateMethod(): 'INSTALLER' | 'CHECKOUT' {
  if (process.env.AI17Z_INSTALLED === '1') return 'INSTALLER';
  return existsSync(resolve(process.cwd(), 'BUILD_INFO.json')) ? 'INSTALLER' : 'CHECKOUT';
}

/**
 * What to show. Reads the cache unless it is stale or `refresh` is asked for.
 *
 * A failed check never throws: the answer is the state with `error` filled in,
 * because "we could not reach GitHub" is information and an exception is not.
 */
export async function updateState(options: { refresh?: boolean } = {}): Promise<UpdateState> {
  const current = buildVersion().version;
  const enabled = await updatesEnabled();
  const skipped = await ops.getSetting<string>(SKIPPED_KEY);
  const method = updateMethod();

  const currentName = releaseName(current).title;

  if (!enabled) {
    return {
      current,
      currentName,
      latest: null,
      updateAvailable: false,
      skipped,
      enabled,
      checkedAt: null,
      error: null,
      method,
    };
  }

  const cached = await ops.getSetting<CachedCheck>(CHECK_KEY);
  const fresh =
    cached && !options.refresh && Date.now() - Date.parse(cached.checkedAt) < CACHE_MS ? cached : null;

  let check: CachedCheck;
  if (fresh) {
    check = fresh;
  } else {
    try {
      check = { checkedAt: nowIso(), release: await fetchLatestRelease(current), error: null };
    } catch (error) {
      const message = errorMessage(error);
      log.warn('update check failed', { error: message });
      check = { checkedAt: nowIso(), release: cached?.release ?? null, error: message };
    }
    await ops.setSetting(CHECK_KEY, check);
  }

  const latest = check.release;
  const newer = latest !== null && compareVersions(latest.version, current) > 0;

  return {
    current,
    currentName,
    latest,
    updateAvailable: newer && latest.version !== skipped,
    skipped,
    enabled,
    checkedAt: check.checkedAt,
    error: check.error,
    method,
  };
}
