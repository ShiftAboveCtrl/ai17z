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
import pkg from '../../../package.json' with { type: 'json' };

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
    cached = { version: pkg.version, commit: stamped.trim().slice(0, 12), source: 'build' };
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
    cached = { version: pkg.version, commit: commit || null, source: commit ? 'git' : 'unknown' };
  } catch {
    cached = { version: pkg.version, commit: null, source: 'unknown' };
  }

  return cached;
}

/** One line, for a log, a heartbeat row, or a screen. */
export function describeVersion(build: BuildVersion = buildVersion()): string {
  if (!build.commit) return `v${build.version} (source unknown)`;
  return `v${build.version} (${build.commit})`;
}
