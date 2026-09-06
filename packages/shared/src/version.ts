/**
 * What this installation is running.
 *
 * Nothing reported it. An installation could not say what version it was, which
 * makes two ordinary questions unanswerable: "have you updated?" and "which
 * version has the bug?". The `workers.version` column has existed since the
 * presence table was added and nothing ever wrote to it.
 *
 * Three sources, in the order they are trustworthy:
 *
 *   AI17Z_BUILD_COMMIT   stamped into the image at build time, which is the
 *                        only thing a container can know about its own source
 *   git                  read once at startup, for a checkout run natively
 *   neither              said plainly rather than guessed at
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pkg from '../../../package.json' with { type: 'json' };

/**
 * The released version, which is not the same as the package version.
 *
 * `package.json` used to sit at `0.1.0` through every candidate, so an
 * installation that asked "is there anything newer than me?" compared `0.1.0`
 * against `v0.1.0-rc.4` and could not tell. It now moves with the tag -- but a
 * built copy still must not depend on that being remembered, so the packager
 * stamps the real one into `BUILD_INFO.json` and compose hands it to the
 * containers, which have neither that file nor a repository.
 */
function releasedVersion(): string {
  const stamped = process.env.AI17Z_VERSION ?? process.env.XBAM_VERSION;
  if (stamped && stamped.trim()) return stamped.trim().replace(/^v/, '');

  try {
    const info = JSON.parse(readFileSync(resolve(process.cwd(), 'BUILD_INFO.json'), 'utf8')) as {
      version?: string;
    };
    if (info.version) return info.version.replace(/^v/, '');
  } catch {
    // A checkout has no BUILD_INFO.json, which is not a fault: the package
    // version is the right answer there.
  }
  return pkg.version;
}

export interface BuildVersion {
  /** The package version, which moves at release rather than per commit. */
  version: string;
  /** The exact source, when it can be known. */
  commit: string | null;
  /** How the commit was determined, so a reader knows what it is worth. */
  source: 'build' | 'git' | 'unknown';
}

let cached: BuildVersion | null = null;

/** Read once. The answer cannot change without the process restarting. */
export function buildVersion(): BuildVersion {
  if (cached) return cached;

  const stamped = process.env.AI17Z_BUILD_COMMIT ?? process.env.XBAM_BUILD_COMMIT;
  if (stamped && stamped.trim()) {
    cached = { version: releasedVersion(), commit: stamped.trim().slice(0, 12), source: 'build' };
    return cached;
  }

  try {
    // Never in a container: there is no git there, and no repository either.
    // The failure is expected and silent for exactly that reason.
    const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trim();
    cached = { version: releasedVersion(), commit: commit || null, source: commit ? 'git' : 'unknown' };
  } catch {
    cached = { version: releasedVersion(), commit: null, source: 'unknown' };
  }

  return cached;
}

/** One line, for a log, a heartbeat row, or a screen. */
export function describeVersion(build: BuildVersion = buildVersion()): string {
  if (!build.commit) return `v${build.version} (source unknown)`;
  return `v${build.version} (${build.commit})`;
}

/**
 * What a release is called, as opposed to what it is numbered.
 *
 * `v0.1.0-rc.8` is correct, sortable, and says nothing to the person who
 * downloaded it. "AI17Z Beta 1.0.0" says which product, how finished it is, and
 * which one it is -- in that order, because that is the order somebody looking
 * at a list of downloads cares about.
 *
 * The number stays exactly as semver requires and the tag is still the number:
 * `compareVersions` decides what is newer, `updates.ts` decides who is shown a
 * prerelease, and the installer's `VersionInfoVersion` still has to be four
 * digits Windows will accept. This is a rendering of the version, not a second
 * version, and nothing downstream may parse it back.
 *
 * The iteration is dropped when it is the first, because "AI17Z Beta 1.0.0 (1)"
 * is a worse name than "AI17Z Beta 1.0.0" and every release cycle starts with
 * one.
 */
export interface ReleaseName {
  /** The whole thing: `AI17Z Beta 1.0.0`. */
  title: string;
  /** Without the product: `Beta 1.0.0`. For a badge with no room. */
  short: string;
  /** `Beta`, `Release Candidate`, `Alpha`, or null for a finished release. */
  channel: string | null;
  /** `1.0.0`, always three numbers, never a `v`. */
  number: string;
  /** Which beta, which candidate. 1 when the tag does not say. */
  iteration: number;
}

/**
 * The words for the prerelease identifiers AI17Z uses.
 *
 * Anything not listed is title-cased rather than rejected: a tag nobody planned
 * for should read a little oddly, not break the screen it appears on.
 */
const CHANNEL_WORDS: Record<string, string> = {
  alpha: 'Alpha',
  beta: 'Beta',
  rc: 'Release Candidate',
  preview: 'Preview',
};

export function releaseName(version = buildVersion().version): ReleaseName {
  const [core = '', pre = ''] = version.trim().replace(/^v/, '').split('-', 2);

  // Padded to three, so `1.0` and `1` both render as `1.0.0`. A name that
  // sometimes has two numbers and sometimes three looks like two products.
  const numbers = core.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const number = [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0].join('.');

  if (!pre) {
    return { title: `AI17Z ${number}`, short: number, channel: null, number, iteration: 1 };
  }

  const [word = '', count = ''] = pre.split('.', 2);
  const channel = CHANNEL_WORDS[word.toLowerCase()] ?? word.charAt(0).toUpperCase() + word.slice(1);
  const iteration = Number.parseInt(count, 10) || 1;

  const suffix = iteration > 1 ? ` (${iteration})` : '';
  const short = `${channel} ${number}${suffix}`;
  return { title: `AI17Z ${short}`, short, channel, number, iteration };
}
