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

/**
 * The commit inside a build stamp, or nothing when there is not one in it.
 *
 * `AI17Z_BUILD_COMMIT` is set from the launcher's source stamp, and that stamp
 * has never been only a commit. An installed copy has no repository, so the
 * launcher falls back to `BUILD_INFO.json` and stamps `<version>-<commit>` --
 * and this read it as a commit and took the first twelve characters:
 *
 *     "1.0.0-beta.13-05da2440e1f2".slice(0, 12) === "1.0.0-beta.1"
 *
 * Which is what every installed copy has been reporting as its exact source, in
 * the version display and in the worker heartbeat. Not a commit, not a version,
 * and worst of all not obviously either -- it reads like a real answer.
 *
 * So the shapes are named rather than assumed, and anything else is refused.
 * `describeVersion` then says "source unknown", which is true and useful, where
 * a mangled prefix was neither.
 */
export function commitFromStamp(stamp: string): string | null {
  const trimmed = stamp.trim();

  // The two shapes that carry no commit at all, named before anything is
  // matched. `mtime-<ticks>` is the trap: ticks are decimal, decimal digits are
  // valid hex, and a rule looking for a hex tail happily reads the last twelve
  // of them as a commit. Found by a test written for a different case.
  if (!trimmed || trimmed === 'unknown' || trimmed.startsWith('mtime-')) return null;

  // A clean checkout: the stamp is the commit.
  const bare = /^([0-9a-f]{7,40})$/i.exec(trimmed);
  if (bare) return bare[1]!.toLowerCase().slice(0, 12);

  // A checkout with edits in it. Still the commit it sits on, which is the
  // honest answer to "what source is this"; the edits are the launcher's
  // business, not the version display's.
  const dirty = /^([0-9a-f]{7,40})-dirty-/i.exec(trimmed);
  if (dirty) return dirty[1]!.toLowerCase().slice(0, 12);

  // An installed copy: `<version>-<commit>` from BUILD_INFO.json.
  const stamped = /-([0-9a-f]{7,40})$/i.exec(trimmed);
  if (stamped) return stamped[1]!.toLowerCase().slice(0, 12);

  // `mtime-<ticks>`, `unknown`, or a version with no commit beside it. None of
  // those is a commit and none of them should be shown as one.
  return null;
}

let cached: BuildVersion | null = null;

/** Read once. The answer cannot change without the process restarting. */
export function buildVersion(): BuildVersion {
  if (cached) return cached;

  const stamped = process.env.AI17Z_BUILD_COMMIT ?? process.env.XBAM_BUILD_COMMIT;
  if (stamped && stamped.trim()) {
    const commit = commitFromStamp(stamped);
    cached = commit
      ? { version: releasedVersion(), commit, source: 'build' }
      : // A stamp with no commit in it is not an excuse to print part of it.
        { version: releasedVersion(), commit: null, source: 'unknown' };
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
 * downloaded it. "AI17Z Beta 3.1" says which product, how finished it is, and
 * which one it is -- in that order, because that is the order somebody looking
 * at a list of downloads cares about.
 *
 * The number stays exactly as semver requires and the tag is still the number:
 * `compareVersions` decides what is newer, `updates.ts` decides who is shown a
 * prerelease, and the installer's `VersionInfoVersion` still has to be four
 * digits Windows will accept. This is a rendering of the version, not a second
 * version, and nothing downstream may parse it back.
 *
 * Two grammars, because the channels are asking different questions:
 *
 *   **A beta is counted**, ten to a row -- Beta 1.0 to Beta 1.9, then Beta 2.0.
 *   The `1.0.0` was identical on all twenty of them and said nothing; which
 *   beta it is, is the whole of what somebody wants. `betaLabelFor` below.
 *
 *   **Everything else names its number**, because an rc is a candidate *for* a
 *   release and a finished release is one. Their iteration is dropped when it
 *   is the first, since "AI17Z Release Candidate 1.0.0 (1)" is a worse name
 *   than "AI17Z Release Candidate 1.0.0" and every cycle starts with one.
 */
export interface ReleaseName {
  /** The whole thing: `AI17Z Beta 3.1`. */
  title: string;
  /** Without the product: `Beta 3.1`. For a badge with no room. */
  short: string;
  /** `Beta`, `Release Candidate`, `Alpha`, or null for a finished release. */
  channel: string | null;
  /** `1.0.0`, always three numbers, never a `v`. The machine's number. */
  number: string;
  /** Which beta, which candidate. 1 when the tag does not say. */
  iteration: number;
  /**
   * The beta's own two digits, `3.1`, or null for anything that is not a beta.
   *
   * Exposed because a diagnostics screen shows this beside the machine version
   * and should not have to take it apart from `short` to do it.
   */
  betaLabel: string | null;
}

/**
 * Which beta this is, in the two digits people actually use.
 *
 * Twenty betas in, `Beta 1.0.0 (20)` had stopped telling anybody anything: the
 * `1.0.0` is the same on every one of them, and `(20)` reads as a build number
 * rather than as progress. The owner asked for the familiar shape instead --
 * Beta 1.0 through Beta 1.9, then Beta 2.0 -- so the twentieth iteration is
 * Beta 3.0 and the next is Beta 3.1.
 *
 * The tag does not change. `1.0.0-beta.21` stays exactly that: semver
 * precedence, the prerelease filter, the Debian version, the four-digit
 * `VersionInfoVersion` and every updater comparison all keep working on a
 * number that only ever counts up. **This is a rendering, and nothing parses it
 * back** -- the same rule the old grammar had, and the reason it is safe to
 * change what it renders.
 *
 * Writing `1.0.0-beta.3.1` instead would have been the trap: semver compares
 * prerelease identifiers field by field, so `beta.3.1` sorts *below* `beta.20`
 * and every installation in the field would have refused the upgrade as older.
 */
export function betaLabelFor(iteration: number): string {
  // Ten to a row, counting from the tag's own number: beta.1 is Beta 1.1,
  // beta.10 is Beta 2.0, beta.20 is Beta 3.0. The tags are 1-based, which is
  // what puts the first of each ten at `.0`.
  const safe = Number.isFinite(iteration) && iteration > 0 ? Math.floor(iteration) : 0;
  return `${Math.floor(safe / 10) + 1}.${safe % 10}`;
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
    return { title: `AI17Z ${number}`, short: number, channel: null, number, iteration: 1, betaLabel: null };
  }

  const [word = '', count = ''] = pre.split('.', 2);
  const channel = CHANNEL_WORDS[word.toLowerCase()] ?? word.charAt(0).toUpperCase() + word.slice(1);
  const iteration = Number.parseInt(count, 10) || 1;

  // A beta says which beta, and nothing else. The `1.0.0` was identical on all
  // twenty of them, so it carried no information and crowded out the part that
  // did. Every other channel keeps the old grammar: an rc names the release it
  // is a candidate for, which is the whole point of an rc, and a finished
  // release is its number.
  if (word.toLowerCase() === 'beta') {
    const betaLabel = betaLabelFor(iteration);
    const short = `Beta ${betaLabel}`;
    return { title: `AI17Z ${short}`, short, channel, number, iteration, betaLabel };
  }

  const suffix = iteration > 1 ? ` (${iteration})` : '';
  const short = `${channel} ${number}${suffix}`;
  return { title: `AI17Z ${short}`, short, channel, number, iteration, betaLabel: null };
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
