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
  /** The full Windows installer, when the release has one. */
  installerUrl: string | null;
  /**
   * The setup program for this release, as the script it is.
   *
   * Not a download anybody is asked to run: the ordinary way in is a command,
   * and the command fetches this. It is here so an update screen can link
   * somebody straight at what is about to run on their machine.
   */
  setupUrl: string | null;
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
   * `INSTALLER` means it came from the Windows package and the update is a new
   * installer to run. `BOOTSTRAP` means AI17Z Setup put it there and the update
   * is the Start Menu's "Update AI17Z", which runs the same setup script that
   * installed it. `CHECKOUT` means it is a clone and the update is a pull.
   *
   * The difference decides which button makes sense, and offering the wrong one
   * is how somebody ends up running `git pull` on a directory with no
   * repository in it.
   */
  method: UpdateMethod;
  /**
   * Which installation this screen belongs to.
   *
   * A machine can hold several AI17Z installations, each with its own agents,
   * database and browser session, and each serving its own copy of this
   * interface. "There is an update" is not an answer for somebody running three
   * of them, and an update screen that cannot name itself is one that will
   * eventually be used to update the wrong one.
   *
   * Both values come from the launcher of *this* installation -- the name off
   * its own marker, the directory it is running from -- and never from release
   * metadata, which is remote data and has no business naming a local path.
   */
  installation: Installation;
}

export interface Installation {
  /** `AI17Z`, `AI17Z-test`. Null in a checkout, which has no instance. */
  name: string | null;
  /** The folder this copy runs from. Null when it is not an installation. */
  programDir: string | null;
  /** How it got here, which is what decides how it takes an update. */
  channel: UpdateMethod;
}

export type UpdateMethod = 'INSTALLER' | 'BOOTSTRAP' | 'CHECKOUT';

/**
 * What this installation can say about itself.
 *
 * Read from the environment the launcher set rather than from the filesystem:
 * the API runs in a container that cannot see the program directory at all, so
 * anything it knows about where it came from was handed to it on the way in.
 */
export function installationFrom(env: NodeJS.ProcessEnv, method: UpdateMethod): Installation {
  const name = (env.AI17Z_INSTANCE_NAME ?? '').trim();
  const programDir = (env.AI17Z_PROGRAM_DIR ?? '').trim();
  return {
    name: name || null,
    programDir: programDir || null,
    channel: method,
  };
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

  // By name, not by position.
  //
  // This took "the first asset ending in .exe", which was unambiguous while
  // there was one. There are now two, and which one an installation should be
  // offered depends on how it was installed -- so handing out whichever GitHub
  // happened to list first would tell half of them to run the wrong one. The
  // old rule survives as a fallback so a release published before either name
  // existed still resolves to something.
  const assets = raw.assets ?? [];
  const assetNamed = (prefix: string, extension: string) =>
    assets.find(
      (asset) =>
        asset.name?.toLowerCase().startsWith(prefix) && asset.name.toLowerCase().endsWith(extension),
    );
  const anyExe = assets.find((asset) => asset.name?.toLowerCase().endsWith('.exe'));
  // The older full installer, still published because the installations that
  // were made with it update by running a newer one.
  const installer = assetNamed('ai17z-setup-', '.exe') ?? anyExe;
  // The setup program itself, as a script. A release from before the terminal
  // route has none, and null is the honest answer there.
  const setup = assetNamed('install-ai17z-', '.ps1') ?? null;

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
    setupUrl: setup?.browser_download_url ?? null,
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
 * Three layouts and one marker. Whichever program put the installation there --
 * the Windows installer or AI17Z Setup -- writes `INSTALL_INFO.json` beside it
 * saying which it was, and the launcher passes the channel on because a
 * container has neither that file nor a repository to ask.
 *
 * The fallback is what this did before that file existed, and it stays: an
 * installation made by an older release has no marker and must keep being
 * offered the installer rather than being told it is a checkout.
 */
export function updateMethodFrom(env: NodeJS.ProcessEnv, hasBuildInfo: boolean): UpdateMethod {
  const channel = (env.AI17Z_INSTALL_CHANNEL ?? '').trim().toUpperCase();
  if (channel === 'BOOTSTRAP') return 'BOOTSTRAP';
  if (channel === 'INSTALLER') return 'INSTALLER';
  // An unknown channel is not a third answer. Something wrote a value nothing
  // here understands, and guessing from it would be worse than falling back to
  // the signal that has always worked.
  if (env.AI17Z_INSTALLED === '1') return 'INSTALLER';
  return hasBuildInfo ? 'INSTALLER' : 'CHECKOUT';
}

function updateMethod(): UpdateMethod {
  return updateMethodFrom(process.env, existsSync(resolve(process.cwd(), 'BUILD_INFO.json')));
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
  const installation = installationFrom(process.env, method);

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
      installation,
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
    installation,
  };
}
