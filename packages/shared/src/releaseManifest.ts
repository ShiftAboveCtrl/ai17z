import { z } from 'zod';

/**
 * What a release is, in one machine-readable document.
 *
 * Before this, the name of every published file existed in at least three
 * places that nothing connected: the release workflow that produces it,
 * `install.ps1` that goes looking for it, and `Setup-AI17Z.ps1` that downloads
 * the payload next. Adding macOS and Ubuntu would have made that nine, across
 * two more shell languages, and a mismatch is invisible until a stranger runs
 * the command and is told a release does not contain a file that is sitting
 * right there under a slightly different name.
 *
 * So naming lives here, once, and everything else derives from it. The
 * installers for each platform are shell scripts and cannot import this, which
 * is exactly why `tests/unit/releaseManifest.test.ts` holds their patterns
 * against these functions rather than trusting anybody to keep them in step.
 *
 * The other half of its job is the thing that stops a future release breaking a
 * working installation: an updater reads this **before** it stops anything, and
 * refuses an update whose requirements the machine does not meet. A release
 * that cannot run here should leave the old one running.
 */

/** Bumped when the shape changes in a way an older reader cannot cope with. */
export const RELEASE_MANIFEST_SCHEMA = 1;

export const PLATFORMS = ['windows', 'macos', 'ubuntu'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const ARCHITECTURES = ['x64', 'arm64'] as const;
export type Architecture = (typeof ARCHITECTURES)[number];

/**
 * How a copy got onto a machine, which is what decides how it updates.
 *
 * `BOOTSTRAP` and `INSTALLER` predate this file and keep their spelling,
 * because installations already exist carrying those words in their metadata
 * and renaming them would strand every one of them.
 */
export const INSTALL_METHODS = ['BOOTSTRAP', 'INSTALLER', 'MACOS_PKG', 'UBUNTU_DEB', 'CHECKOUT'] as const;
export type InstallMethod = (typeof INSTALL_METHODS)[number];

/** Which platform an install method belongs to. A method is never ambiguous. */
export const PLATFORM_OF_METHOD: Record<InstallMethod, Platform | null> = {
  BOOTSTRAP: 'windows',
  INSTALLER: 'windows',
  MACOS_PKG: 'macos',
  UBUNTU_DEB: 'ubuntu',
  // A checkout is whatever the developer is sitting on.
  CHECKOUT: null,
};

// ---------------------------------------------------------------------------
// Asset names
//
// One function per kind, and nothing anywhere else may compose these strings.
// ---------------------------------------------------------------------------

/** `1.0.0-beta.16` from either `v1.0.0-beta.16` or `1.0.0-beta.16`. */
export function bareVersion(version: string): string {
  return version.trim().replace(/^v/, '');
}

/** The application payload the Windows setup program downloads and unpacks. */
export function windowsPackageAsset(version: string): string {
  return `AI17Z-App-${bareVersion(version)}.zip`;
}

/** The Windows setup program, published as the script it is. */
export function windowsSetupAsset(version: string): string {
  return `Install-AI17Z-${bareVersion(version)}.ps1`;
}

/** The older full Windows installer. Unsigned, and not the recommended route. */
export function windowsInstallerAsset(version: string): string {
  return `AI17Z-Setup-${bareVersion(version)}.exe`;
}

/**
 * The macOS application payload, per architecture.
 *
 * A tarball rather than a `.app`, a `.pkg` or a `.dmg`, and that is a decision
 * rather than a shortcut: AI17Z has no Apple Developer ID, so any of those
 * three downloaded from the internet meets Gatekeeper as an unidentified
 * developer. A tar extracted by a script the owner read first does not become
 * a quarantined bundle somebody has to be talked past.
 */
export function macosPackageAsset(version: string, arch: Architecture): string {
  return `AI17Z-macos-${arch}-${bareVersion(version)}.tar.gz`;
}

/** The Ubuntu package, per architecture. Debian's own naming, so `apt` is happy. */
export function ubuntuPackageAsset(version: string, arch: Architecture): string {
  return `ai17z_${bareVersion(version)}_${arch === 'x64' ? 'amd64' : 'arm64'}.deb`;
}

/** The readable installer somebody downloads, looks at, and then runs. */
export function installerScriptAsset(platform: Exclude<Platform, 'windows'>): string {
  return platform === 'macos' ? 'install-ai17z-macos.sh' : 'install-ai17z-ubuntu.sh';
}

/** Debian spells x64 `amd64`; everything else here spells it `x64`. */
export function debArchitecture(arch: Architecture): string {
  return arch === 'x64' ? 'amd64' : 'arm64';
}

/** What Node's own download server calls a platform/architecture pair. */
export function nodeArchiveName(nodeVersion: string, platform: Platform, arch: Architecture): string {
  const version = nodeVersion.startsWith('v') ? nodeVersion : `v${nodeVersion}`;
  const os = platform === 'macos' ? 'darwin' : 'linux';
  return `node-${version}-${os}-${arch}.tar.gz`;
}

export const CHECKSUMS_ASSET = 'SHA256SUMS.txt';
export const MANIFEST_ASSET = 'release-manifest.json';

/**
 * The release notes, published as the Markdown they were written in.
 *
 * The same text the release page shows, as a file at an exact tag. An update
 * check reads it from here rather than asking the API for the release body,
 * because the body arrives as rendered HTML through every route that does not
 * cost an API request, and the panel renders Markdown.
 */
export const NOTES_ASSET = 'release-notes.md';

/**
 * Where an installation looks to find out what has been released.
 *
 * Deliberately `github.com` and not `api.github.com`, and that is the whole
 * point of this function existing rather than a URL being written inline.
 *
 * The REST API allows sixty requests an hour to an unauthenticated address,
 * and an AI17Z installation already spends that budget on something else: a
 * repository an owner asked their agent to watch is polled through the REST
 * API, four endpoints at a time. Two installations on one home connection
 * during an active week exhaust sixty an hour between them, and what breaks is
 * not the watching. It is the update check, which then cannot discover a
 * release that is sitting there published. Measured: the core budget read
 * `0 of 60` and the updater reported that it could not reach GitHub to see
 * which version, correctly refusing rather than guessing, while the release it
 * was looking for had been downloadable the whole time.
 *
 * The releases feed is ordinary `github.com` and is not charged against that
 * budget. Measured across three consecutive fetches: the REST budget read 56
 * before and 56 after. It also lists prereleases, which is the reason
 * `/releases/latest` was rejected for this job long before any of the above:
 * it hides exactly the releases this product ships.
 *
 * So an owner's update check and an agent's repository watching no longer draw
 * on one budget, and neither can starve the other.
 */
export function releasesFeedUrl(repository: string): string {
  return `https://github.com/${repository}/releases.atom`;
}

/**
 * One published file of one release, addressed by the tag it belongs to.
 *
 * Exact tag rather than "latest", so what is fetched is decided before the
 * request rather than by whatever the server considers newest at that moment.
 * This is the same address the release qualification gate uses, and it needs no
 * API call, which is what makes an update independent of the budget above.
 */
export function releaseAssetUrl(repository: string, tag: string, asset: string): string {
  return `https://github.com/${repository}/releases/download/${tag}/${asset}`;
}

/**
 * Every package a platform must publish, by name.
 *
 * Not "whatever was found in the directory". `release-manifest.mts` used to
 * describe the artifacts it happened to see, so a release missing one of the
 * four packages would have published a manifest quietly saying that platform
 * was unsupported -- correct about the directory, and wrong about the release.
 * The job that reads this asks for a platform and is told what that platform
 * owes, so an absent file is a missing name rather than a smaller list.
 */
export function expectedAssets(version: string, platform: Platform): string[] {
  const v = bareVersion(version);
  if (platform === 'windows') {
    return [windowsInstallerAsset(v), windowsSetupAsset(v), windowsPackageAsset(v), 'install.ps1'];
  }
  const packageFor = platform === 'macos' ? macosPackageAsset : ubuntuPackageAsset;
  return [...ARCHITECTURES.map((arch) => packageFor(v, arch)), installerScriptAsset(platform)];
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

const artifact = z.object({
  name: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative().optional(),
  platform: z.enum(PLATFORMS).nullable(),
  arch: z.enum(ARCHITECTURES).nullable(),
  /** What this file is, so a reader never parses the name to find out. */
  kind: z.enum(['app-package', 'setup-script', 'installer-exe', 'installer-script', 'checksums', 'audit']),
});
export type ReleaseArtifact = z.infer<typeof artifact>;

/**
 * What a machine must already be, for this release to run on it.
 *
 * Checked before an update stops anything. Every field is a floor rather than a
 * pin: AI17Z does not update Docker or Chrome because a newer one exists, only
 * when what is here genuinely cannot run what is arriving.
 */
const requirements = z.object({
  /** `26.0.0`. Compared with the engine's reported version. */
  minimumDocker: z.string().min(1),
  /** Chrome's own floor, which is a Google decision rather than an AI17Z one. */
  minimumChromeMajor: z.number().int().positive().nullable(),
  /** The Node bundled inside the package. Nothing global is consulted. */
  bundledNode: z.string().regex(/^v?\d+\.\d+\.\d+$/),
  /** `13` on macOS; `['22.04','24.04','26.04']` on Ubuntu; a build number on Windows. */
  os: z.record(z.string(), z.unknown()),
});
export type ReleaseRequirements = z.infer<typeof requirements>;

export const releaseManifestSchema = z.object({
  schemaVersion: z.number().int().positive(),
  version: z.string().min(1),
  tag: z.string().min(1),
  commit: z.string().min(7),
  /** UTC, ISO 8601. */
  builtAt: z.string().min(1),
  builtBy: z.string().min(1).optional(),
  /** Whether anything here carries a platform signature. Today: nothing does. */
  signed: z.object({ windows: z.boolean(), macos: z.boolean(), ubuntu: z.boolean() }),
  /**
   * The oldest installation that can read this release directly.
   *
   * An installation whose updater is older than this does not fail: it fetches
   * a newer verified updater helper and hands over. The number is what tells it
   * to do that rather than to try and misunderstand a newer layout.
   */
  minimumUpdaterSchema: z.number().int().positive(),
  installLayoutSchema: z.number().int().positive(),
  platforms: z.record(
    z.enum(PLATFORMS),
    z.object({
      supported: z.boolean(),
      architectures: z.array(z.enum(ARCHITECTURES)).min(1),
      methods: z.array(z.enum(INSTALL_METHODS)).min(1),
      requirements,
    }),
  ),
  artifacts: z.array(artifact),
  /** The highest migration in this release, so an older database knows the span. */
  migrations: z.object({ latest: z.string().min(1), count: z.number().int().nonnegative() }),
});
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

/** Parsed, or a reason. Never a half-read document. */
export function parseReleaseManifest(text: string): { ok: true; manifest: ReleaseManifest } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `the release manifest is not JSON: ${(error as Error).message}` };
  }
  const parsed = releaseManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: `the release manifest does not match the schema: ${parsed.error.issues[0]?.message ?? 'unknown'}` };
  }
  return { ok: true, manifest: parsed.data };
}

/** The artifact a given platform and architecture installs, or null. */
export function artifactFor(
  manifest: ReleaseManifest,
  platform: Platform,
  arch: Architecture,
): ReleaseArtifact | null {
  const kind = platform === 'windows' ? 'app-package' : 'app-package';
  return (
    manifest.artifacts.find(
      (entry) => entry.kind === kind && entry.platform === platform && (entry.arch === arch || entry.arch === null),
    ) ?? null
  );
}

/**
 * Semver-ish comparison for the version strings vendors actually print.
 *
 * `docker info` says `27.4.0`, `28.0.1-rc.2`, sometimes with a build suffix.
 * Only the numbers before the first dash are compared, because a prerelease of
 * the version we need is not a version we can promise anything about.
 */
export function compareVersionNumbers(left: string, right: string): number {
  const numbers = (value: string) =>
    value
      .trim()
      .replace(/^v/, '')
      .split('-')[0]!
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = numbers(left);
  const b = numbers(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

export interface PreflightInput {
  platform: Platform;
  arch: Architecture;
  /** `24.04`, `13.5`, `26200`. Whatever the platform reports for itself. */
  osVersion: string;
  dockerVersion: string | null;
  chromeMajor: number | null;
}

export interface PreflightVerdict {
  ok: boolean;
  /** Empty when ok. One sentence per thing that has to change, in plain words. */
  blockers: string[];
  /** True, unavailable, or simply not needed: a headless server has no Chrome. */
  notes: string[];
}

/**
 * Whether this release can run here, asked before anything is stopped.
 *
 * The point of doing this first is that the answer "no" must be survivable. An
 * update that discovers the problem after replacing the application has already
 * taken the working version away from somebody.
 */
export function preflight(manifest: ReleaseManifest, input: PreflightInput): PreflightVerdict {
  const blockers: string[] = [];
  const notes: string[] = [];
  const platform = manifest.platforms[input.platform];

  if (!platform || !platform.supported) {
    return { ok: false, blockers: [`AI17Z ${manifest.version} does not publish a ${input.platform} build.`], notes };
  }
  if (!platform.architectures.includes(input.arch)) {
    blockers.push(`AI17Z ${manifest.version} has no ${input.arch} build for ${input.platform}.`);
  }

  const osRule = platform.requirements.os;
  if (input.platform === 'ubuntu') {
    const allowed = (osRule.releases as string[] | undefined) ?? [];
    if (allowed.length > 0 && !allowed.includes(input.osVersion)) {
      blockers.push(
        `AI17Z ${manifest.version} supports Ubuntu ${allowed.join(', ')}. This is Ubuntu ${input.osVersion}.`,
      );
    }
  } else if (input.platform === 'macos') {
    const minimum = Number(osRule.minimumMajor ?? 0);
    const major = Number.parseInt(input.osVersion.split('.')[0] ?? '0', 10);
    if (minimum > 0 && major > 0 && major < minimum) {
      blockers.push(`AI17Z ${manifest.version} needs macOS ${minimum} or newer. This is macOS ${input.osVersion}.`);
    }
  } else {
    const minimum = Number(osRule.minimumBuild ?? 0);
    const build = Number.parseInt(input.osVersion, 10);
    if (minimum > 0 && build > 0 && build < minimum) {
      blockers.push(`AI17Z ${manifest.version} needs Windows build ${minimum} or newer. This is ${input.osVersion}.`);
    }
  }

  if (input.dockerVersion === null) {
    blockers.push('Docker is not running. AI17Z needs it for the database and cannot check an engine that does not answer.');
  } else if (compareVersionNumbers(input.dockerVersion, platform.requirements.minimumDocker) < 0) {
    blockers.push(
      `AI17Z ${manifest.version} needs Docker ${platform.requirements.minimumDocker} or newer. This is ${input.dockerVersion}. ` +
        'Update Docker first; AI17Z will not update it for you while updating itself.',
    );
  }

  const chromeFloor = platform.requirements.minimumChromeMajor;
  if (chromeFloor !== null) {
    if (input.chromeMajor === null) {
      // Never a blocker. An installation with no Chrome is an installation that
      // cannot drive a browser, which is a smaller thing than one that will not
      // start, and saying otherwise would refuse to update a working server.
      notes.push('Google Chrome was not found, so anything needing a browser stays unavailable until it is installed.');
    } else if (input.chromeMajor < chromeFloor) {
      notes.push(
        `Google Chrome ${input.chromeMajor} is older than the ${chromeFloor} AI17Z drives. Update Chrome to use browser features.`,
      );
    }
  }

  return { ok: blockers.length === 0, blockers, notes };
}

// ---------------------------------------------------------------------------
// Whether an update may proceed when the gate could not answer
// ---------------------------------------------------------------------------

/**
 * The install-layout schema from which the compatibility gate is part of the
 * protocol.
 *
 * Schema 3 is the first that ships `packaging/preflight.mts`, a private Node to
 * run it with, and a release manifest to run it against. An installation
 * recording 3 therefore has every piece the gate needs, and the absence of any
 * of them is a fault rather than an era.
 */
export const UPDATER_GATE_SCHEMA = 3;

/** Why the gate produced no verdict. */
export type GateUnavailable =
  | 'no-manifest'
  | 'no-bridge'
  | 'no-runtime'
  | 'crashed'
  | 'unreadable';

export type GateOutcome =
  | { kind: 'allowed'; notes: string[] }
  | { kind: 'refused'; blockers: string[] }
  | { kind: 'unavailable'; why: GateUnavailable };

export interface UpdateDecision {
  proceed: boolean;
  /** What to say. Empty when there is nothing worth saying. */
  reasons: string[];
  /** Whether the gate was required here, for a log line that explains itself. */
  gateRequired: boolean;
}

/**
 * May this update stop the working installation and replace it?
 *
 * The hard part is not the refusal. It is that "the gate said nothing" has two
 * completely different meanings, and for a long time this treated them as one:
 *
 * **A release published before manifests existed, reaching an installation made
 * before the gate existed.** There is nothing to ask and nothing to ask it
 * with. Refusing would strand exactly the installations the update exists to
 * move forward, so it carries on -- which is what the original design got right.
 *
 * **A current installation whose gate did not answer.** Schema 3 ships the
 * bridge, the runtime and the manifest. If one of them is missing, corrupt, or
 * crashed, something is wrong with this copy *right now*, and the next thing
 * the updater does is stop a working installation and replace it. Carrying on
 * means finding out afterwards, which is the one outcome the whole gate exists
 * to prevent.
 *
 * The two are told apart by what the installation records about itself, never
 * by "the file is missing so it is probably old". A missing file is the symptom
 * both states share; the schema is the fact that separates them.
 */
export function decideUpdate(input: {
  /** From INSTALL_INFO.json. Null when there is no record at all, which is itself pre-gate. */
  installedSchema: number | null;
  outcome: GateOutcome;
}): UpdateDecision {
  const gateRequired = input.installedSchema !== null && input.installedSchema >= UPDATER_GATE_SCHEMA;

  if (input.outcome.kind === 'allowed') {
    return { proceed: true, reasons: input.outcome.notes, gateRequired };
  }
  if (input.outcome.kind === 'refused') {
    return { proceed: false, reasons: input.outcome.blockers, gateRequired };
  }

  if (!gateRequired) {
    return {
      proceed: true,
      reasons: [`This installation predates the compatibility check (${WHY[input.outcome.why]}). Continuing.`],
      gateRequired,
    };
  }

  return {
    proceed: false,
    reasons: [
      `AI17Z could not check whether this release can run here: ${WHY[input.outcome.why]}.`,
      'This installation is new enough that the check is part of how it updates, so something is wrong with it.',
      'Nothing was changed. The AI17Z you have is still installed and still running.',
    ],
    gateRequired,
  };
}

const WHY: Record<GateUnavailable, string> = {
  'no-manifest': 'the release published no compatibility manifest',
  'no-bridge': 'the compatibility check is missing from this installation',
  'no-runtime': 'this installation has no runtime to run the check with',
  crashed: 'the check did not finish',
  unreadable: 'the check produced nothing that could be read',
};
