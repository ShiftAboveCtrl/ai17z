#!/usr/bin/env tsx
/**
 * Can this machine run the release it is being offered?
 *
 * Asked by all three updaters before they stop anything, because "no" has to be
 * survivable: an update that discovers the problem after replacing the
 * application has already taken the working version away from somebody.
 *
 * The decision itself lives in `@xbam/shared`. This is only the part that turns
 * a machine into arguments and a verdict into a line something else can branch
 * on -- a shell `case` on macOS and Ubuntu, a PowerShell `switch` on Windows.
 * It sits above `packaging/<platform>/` on purpose: the moment it lived under
 * `unix/`, Windows had no gate at all and nothing said so.
 *
 *   preflight.mts <manifest.json> <platform> <arch> <osVersion> [dockerVersion] [chromeMajor]
 *
 * Prints `OK` or `NO` on the first line, then one reason per line.
 */
import { readFileSync } from 'node:fs';
import { parseReleaseManifest, preflight } from '@xbam/shared';
import type { Architecture, Platform } from '@xbam/shared';

const [manifestPath, platform, arch, osVersion, dockerVersion, chromeMajor] = process.argv.slice(2);

if (!manifestPath || !platform || !arch || !osVersion) {
  console.log('SKIP');
  console.log('preflight was not given enough to decide with');
  process.exit(0);
}

const parsed = parseReleaseManifest(readFileSync(manifestPath, 'utf8'));
if (!parsed.ok) {
  // A manifest that cannot be read is not a refusal. Older releases published
  // none at all, and an updater that stopped for that would strand every
  // installation made before manifests existed.
  console.log('SKIP');
  console.log(parsed.reason);
  process.exit(0);
}

const verdict = preflight(parsed.manifest, {
  platform: platform as Platform,
  arch: arch as Architecture,
  osVersion,
  dockerVersion: dockerVersion && dockerVersion.length > 0 ? dockerVersion : null,
  chromeMajor: chromeMajor && chromeMajor.length > 0 ? Number.parseInt(chromeMajor, 10) : null,
});

console.log(verdict.ok ? 'OK' : 'NO');
for (const line of [...verdict.blockers, ...verdict.notes]) console.log(line);
