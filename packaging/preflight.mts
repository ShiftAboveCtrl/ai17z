#!/usr/bin/env tsx
/**
 * Can this machine run the release it is being offered, and may the update
 * proceed if that could not be established?
 *
 * Asked by all three updaters before they stop anything, because "no" has to be
 * survivable: an update that discovers the problem after replacing the
 * application has already taken the working version away from somebody.
 *
 * The decisions live in `@xbam/shared`. This is only the part that turns a
 * machine into arguments and a verdict into a line something else can branch
 * on -- a shell `case` on macOS and Ubuntu, a PowerShell `switch` on Windows.
 * It sits above `packaging/<platform>/` on purpose: the moment it lived under
 * `unix/`, Windows had no gate at all and nothing said so.
 *
 *   preflight.mts <manifest.json> <platform> <arch> <osVersion> [dockerVersion] [chromeMajor]
 *   preflight.mts --newer <candidate> <installed>
 *
 * `--newer` prints NEWER or NOT-NEWER. It exists because the two shell
 * updaters each had their own comparison and both got the same case wrong:
 * `sort -V` and `dpkg --compare-versions` rank `1.0.0` below
 * `1.0.0-beta.19`, so the release this beta series leads to would have been
 * refused as not newer on macOS and on Ubuntu.
 *
 * Prints `OK` or `NO` on the first line, then one reason per line.
 *
 * It prints `SKIP` only where there is genuinely nothing to decide with, and a
 * caller that reaches SKIP must still decide what that means: see
 * `decideUpdate` in `@xbam/shared`, and `--decide` below, which is how the
 * shells ask for that decision rather than each inventing it.
 */
import { readFileSync } from 'node:fs';
import { compareVersions, decideUpdate, parseReleaseManifest, preflight } from '@xbam/shared';
import type { Architecture, GateUnavailable, Platform } from '@xbam/shared';

const argv = process.argv.slice(2);

// --newer <candidate> <installed>
//
// Is the offered release newer than the installed one? Asked here rather than
// in each shell, because the two shells each had their own comparison and both
// got the same case wrong in the same direction: `sort -V` on macOS and
// `dpkg --compare-versions` on Ubuntu rank `1.0.0` below `1.0.0-beta.19`, so
// the release this beta series leads to would have been refused as not newer
// on both. `compareVersions` in @xbam/shared is the one implementation.
const newerAt = argv.indexOf('--newer');
if (newerAt >= 0) {
  const candidate = argv[newerAt + 1];
  const installed = argv[newerAt + 2];
  if (!candidate || !installed) {
    console.error('--newer needs two versions');
    process.exit(2);
  }
  console.log(compareVersions(candidate, installed) > 0 ? 'NEWER' : 'NOT-NEWER');
  process.exit(0);
}

// --decide <installedSchema> <why>
//
// The second half of the gate, for a caller that already knows the check could
// not run. A shell can see that a file is missing; what it must not do is
// decide for itself what a missing file means, because that is the distinction
// this whole thing turns on and three copies of it would drift.
const decideAt = argv.indexOf('--decide');
if (decideAt >= 0) {
  const raw = argv[decideAt + 1];
  const why = (argv[decideAt + 2] ?? 'unreadable') as GateUnavailable;
  const installedSchema = raw && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null;
  const decision = decideUpdate({ installedSchema, outcome: { kind: 'unavailable', why } });
  console.log(decision.proceed ? 'GO' : 'NO');
  for (const line of decision.reasons) console.log(line);
  process.exit(0);
}

const [manifestPath, platform, arch, osVersion, dockerVersion, chromeMajor] = argv;

if (!manifestPath || !platform || !arch || !osVersion) {
  console.log('SKIP');
  console.log('preflight was not given enough to decide with');
  process.exit(0);
}

let text: string;
try {
  text = readFileSync(manifestPath, 'utf8');
} catch {
  console.log('SKIP');
  console.log('the release manifest could not be read');
  process.exit(0);
}

const parsed = parseReleaseManifest(text);
if (!parsed.ok) {
  // Not a refusal in itself. Older releases published no manifest at all, and
  // what a caller should do about that depends on how old its own installation
  // is -- which is `--decide`'s question, not this one.
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
