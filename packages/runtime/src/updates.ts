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
import {
  INSTALL_METHODS,
  MANIFEST_ASSET,
  NOTES_ASSET,
  buildVersion,
  compareVersions,
  createLogger,
  errorMessage,
  nowIso,
  releaseAssetUrl,
  releaseName,
  releasesFeedUrl,
  windowsInstallerAsset,
  windowsSetupAsset,
} from '@xbam/shared';
import type { InstallMethod } from '@xbam/shared';

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
  /** The readable name: `AI17Z Beta 3.1`. */
  name: string;
  /**
   * The same thing without the product: `Beta 3.1`.
   *
   * For a badge with no room for `AI17Z`. Derived here with `channel` and for
   * the same reason: the version grammar has one implementation and the browser
   * cannot reach it.
   */
  label: string;
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
  /** What that is called: `AI17Z Beta 3.1`. The number is still `current`. */
  currentName: string;
  /** The short form of that: `Beta 3.1`. The number is still `current`. */
  currentLabel: string;
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

/**
 * How a copy got here, which decides how it takes an update.
 *
 * The same list as `INSTALL_METHODS` in `@xbam/shared`, because it is the same
 * question. It used to be its own three-way union written out here, and the two
 * platforms added since were missing from it -- so a Mac fell through to
 * CHECKOUT and the Version panel told an owner to run `.\update-ai17z.ps1`,
 * which is a PowerShell script, on a Mac. Reported from one.
 */
export type UpdateMethod = InstallMethod;

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
 * Lives in `@xbam/shared` so that the shell updaters can reach it through
 * `packaging/preflight.mts`. They had a comparator each, and both were wrong in
 * the same place: `sort -V` on macOS and `dpkg --compare-versions` on Ubuntu
 * both rank `1.0.0` *below* `1.0.0-beta.19`, so the release this whole beta
 * series leads to would have been refused as "not newer" on two platforms out
 * of three. Checked, not assumed -- both were run against that pair.
 */
export { compareVersions } from '@xbam/shared';


/** How many feed entries are read. Bounds the work regardless of feed size. */
const FEED_ENTRIES = 20;

interface FeedEntry {
  tag: string;
  /** What the release is called, which is a title somebody may have written. */
  title: string;
  /** When the feed says it was last touched. */
  updated: string;
}

/**
 * What the releases feed is currently advertising, newest first.
 *
 * Parsed rather than deserialised, because three fields are wanted and an XML
 * parser is a dependency this does not otherwise need.
 *
 * The tag comes from the entry's own link, `.../releases/tag/<tag>`, and not
 * from the title: a title is written by a person and a tag is the thing every
 * filename and comparison here is built from.
 *
 * A draft release has no feed entry at all, which is the same exclusion the
 * REST path used to have to apply by hand.
 */
function entriesFromFeed(xml: string): FeedEntry[] {
  const entries: FeedEntry[] = [];
  for (const chunk of xml.split('<entry').slice(1, FEED_ENTRIES + 1)) {
    const tag = /releases\/tag\/([^"'<>\s]+)/.exec(chunk)?.[1];
    if (!tag) continue;
    entries.push({
      tag: decodeXml(tag),
      title: decodeXml(/<title[^>]*>([\s\S]*?)<\/title>/.exec(chunk)?.[1]?.trim() ?? ''),
      updated: /<updated[^>]*>([\s\S]*?)<\/updated>/.exec(chunk)?.[1]?.trim() ?? '',
    });
  }
  return entries;
}

/** The five entities an Atom document may use around a tag. */
function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** One bounded GET that must not be allowed to hang or run away. */
async function get(url: string, accept: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: {
        accept,
        // GitHub asks for one, and an unidentified client is refused more
        // readily. It names the product and nothing about the machine.
        'user-agent': 'AI17Z',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The newest release this installation would accept.
 *
 * Nothing here calls the REST API, and that is the point rather than a detail.
 * An installation whose agent watches a repository spends the unauthenticated
 * REST budget on that watching, and when the budget is gone the update check
 * used to go with it: the release was published, downloadable, and invisible.
 * The feed and the per-tag assets are ordinary `github.com` and are not charged
 * against it, so watching and updating can no longer starve each other.
 *
 * `/releases/latest` is still not used, for the reason it never was: it
 * excludes prereleases entirely, which is every release this product has made.
 *
 * Three steps, and each one refuses rather than guesses:
 *
 *   1. the feed says which tags exist, newest first
 *   2. the tag says the version, and the channel rule says whether this
 *      installation is allowed to see it
 *   3. that tag's own manifest confirms the release is actually finished
 *
 * Step three is what stops a half-published release being offered. A release
 * appears in the feed the moment it is created, and its assets arrive after;
 * a manifest that is not there yet means the packages are not there either.
 */
export async function fetchLatestRelease(current = buildVersion().version): Promise<ReleaseInfo | null> {
  const feed = await get(releasesFeedUrl(REPOSITORY), 'application/atom+xml');
  if (!feed.ok) {
    throw new Error(`The releases feed answered ${feed.status} ${feed.statusText}`.trim());
  }
  const onPrerelease = compareVersions(current, current.replace(/-.*$/, '')) < 0;

  const candidates = entriesFromFeed(await feed.text())
    .map((entry) => ({ ...entry, version: entry.tag.replace(/^v/, '') }))
    .filter((entry) => entry.version.length > 0)
    // A tag carrying a prerelease part is a prerelease, which is exactly what
    // the release workflow tells GitHub: it sets the flag from the tag and
    // says so. Somebody on a stable version is never shown a candidate build.
    .filter((entry) => onPrerelease || !entry.version.includes('-'))
    .sort((a, b) => compareVersions(b.version, a.version));

  const newest = candidates[0];
  if (!newest) return null;

  const manifest = await get(
    releaseAssetUrl(REPOSITORY, newest.tag, MANIFEST_ASSET),
    'application/json',
  );
  if (!manifest.ok) {
    throw new Error(
      `${newest.tag} is published but its ${MANIFEST_ASSET} is not, so the packages for it are not ready to install yet.`,
    );
  }
  const described = (await manifest.json()) as { version?: unknown; tag?: unknown };

  // The manifest is the authority on what the release calls itself. A tag and
  // a manifest that disagree is a release built from something other than what
  // the tag points at, and offering it would install a version nobody named.
  const version = typeof described.version === 'string' ? described.version.replace(/^v/, '') : '';
  if (version !== newest.version) {
    throw new Error(
      `${newest.tag} publishes a manifest for ${version || 'nothing recognisable'}, so the two disagree about what it is.`,
    );
  }

  // GitHub defaults a release's title to its tag, and a heading that reads
  // `v1.0.0-beta.2` above the notes tells somebody nothing they did not get
  // from the number beside it. A title that is only the tag is treated as no
  // title and rendered; a title somebody actually wrote is left alone.
  const named = releaseName(version);
  const written = newest.title.trim();
  const name = written && written !== newest.tag && written !== version ? written : named.title;

  return {
    version,
    tag: newest.tag,
    name,
    label: named.short,
    channel: named.channel,
    notes: await fetchNotes(newest.tag),
    url: `https://github.com/${REPOSITORY}/releases/tag/${newest.tag}`,
    // Composed rather than looked up. `releaseManifest.ts` is the one place
    // that spells an asset name, so asking it costs no request and cannot
    // disagree with what the release actually published.
    installerUrl: releaseAssetUrl(REPOSITORY, newest.tag, windowsInstallerAsset(version)),
    setupUrl: releaseAssetUrl(REPOSITORY, newest.tag, windowsSetupAsset(version)),
    publishedAt: newest.updated || nowIso(),
    prerelease: version.includes('-'),
  };
}

/**
 * The release notes, as the Markdown they were written in.
 *
 * Published as an asset for the same reason everything else here is: it is
 * reachable at an exact tag without an API call. The feed carries a rendered
 * HTML copy, which is the wrong thing to hand a Markdown renderer.
 *
 * A release from before this asset existed simply has none, and the panel
 * already says so in a sentence. Notes are worth reading and are not worth
 * failing an update check over, so this is the one step here that shrugs.
 */
async function fetchNotes(tag: string): Promise<string> {
  try {
    const response = await get(releaseAssetUrl(REPOSITORY, tag, NOTES_ASSET), 'text/plain');
    if (!response.ok) return '';
    return (await response.text()).trim();
  } catch {
    // Offline, slow, or not published. None of those is a reason to tell
    // somebody there is no update when there is one.
    return '';
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
  // Read off the shared list rather than matched one at a time, so a platform
  // added there cannot go missing here -- which is exactly what happened to
  // MACOS_PKG and UBUNTU_DEB.
  //
  // CHECKOUT is excluded because it is the one value nothing declares: it is
  // what an installation is when no installer put it anywhere, concluded below
  // from the absence of BUILD_INFO.json. Honouring it as a marker would let a
  // stray environment variable tell an installed copy it was a clone.
  if ((INSTALL_METHODS as readonly string[]).includes(channel) && channel !== 'CHECKOUT') {
    return channel as UpdateMethod;
  }
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

  const running = releaseName(current);
  const currentName = running.title;
  const currentLabel = running.short;

  if (!enabled) {
    return {
      current,
      currentName,
      currentLabel,
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
    currentLabel,
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
