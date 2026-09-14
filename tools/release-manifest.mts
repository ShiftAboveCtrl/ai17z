#!/usr/bin/env tsx
/**
 * Writes the release manifest from the artifacts that are actually about to be
 * published.
 *
 * Built in the publish job, from the directory the release is attached out of,
 * so its hashes are the ones somebody will get rather than the ones a build job
 * hoped for. Everything it names comes from `@xbam/shared`, which is the only
 * place an asset name is composed.
 *
 *   release-manifest.mts --dist <dir> --version <x.y.z> --commit <sha>
 *                        [--run <url>] [--expect windows,macos,ubuntu]
 *
 * `--expect` is the list of platforms this directory is supposed to hold a
 * complete set for, and defaults to all three. Anything a named platform owes
 * and has not got stops this rather than quietly leaving it out.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ARCHITECTURES,
  CHECKSUMS_ASSET,
  INSTALL_LAYOUT_SCHEMA,
  MANIFEST_ASSET,
  PLATFORMS,
  RELEASE_MANIFEST_SCHEMA,
  expectedAssets,
  installerScriptAsset,
  macosPackageAsset,
  releaseManifestSchema,
  ubuntuPackageAsset,
  windowsInstallerAsset,
  windowsPackageAsset,
  windowsSetupAsset,
  type Architecture,
  type ReleaseArtifact,
  type ReleaseManifest,
} from '@xbam/shared';

const argv = process.argv.slice(2);
const flag = (name: string): string => {
  const at = argv.indexOf(`--${name}`);
  const value = at >= 0 ? argv[at + 1] : undefined;
  if (!value) {
    console.error(`  --${name} is required`);
    process.exit(2);
  }
  return value;
};
const optional = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};

const dist = resolve(flag('dist'));
const version = flag('version').replace(/^v/, '');
const commit = flag('commit');
const runUrl = optional('run');

/**
 * Which platforms this directory is supposed to be complete for.
 *
 * The release publishes all three at once; the packaging validation workflow
 * builds macOS and Ubuntu and never sees a Windows artifact, so it says so
 * rather than being told a release is broken every time it runs.
 */
const expected = (optional('expect') ?? PLATFORMS.join(','))
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name.length > 0);
for (const platform of expected) {
  if (!PLATFORMS.includes(platform as (typeof PLATFORMS)[number])) {
    console.error(`  --expect: ${platform} is not a platform`);
    process.exit(2);
  }
}

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const nodeRuntime = JSON.parse(readFileSync(join(root, 'packaging/node-runtime.json'), 'utf8')) as { version: string };
const migrations = readdirSync(join(root, 'migrations')).filter((name) => name.endsWith('.sql')).sort();

const present = new Set(readdirSync(dist));

// What each named platform owes, checked against the directory before a line of
// the manifest is composed.
//
// Without this the generator described whatever it found: a release that had
// lost one of the four packages would have published a manifest saying that
// platform was unsupported, which is true of the directory and a lie about the
// release. `if-no-files-found: error` on the uploads makes that hard to reach,
// which is exactly what was said about the attestation step that had never run.
const owed = [
  // Shared, and the whole trust chain: every installer checks a package against
  // this file before it unpacks a byte, so a release without it is one that
  // deliberately cannot be installed.
  { platform: 'every platform', name: CHECKSUMS_ASSET },
  ...expected.flatMap((platform) =>
    expectedAssets(version, platform as (typeof PLATFORMS)[number]).map((name) => ({ platform, name })),
  ),
];
const absent = owed.filter((entry) => !present.has(entry.name));
if (absent.length > 0) {
  console.error(`  ${dist} is missing ${absent.length} file(s) it was told to expect:`);
  for (const entry of absent) console.error(`    ${entry.platform}: ${entry.name}`);
  console.error('  A manifest built from this would describe a release nobody could install.');
  process.exit(1);
}
function artifact(name: string, kind: ReleaseArtifact['kind'], platform: ReleaseArtifact['platform'], arch: Architecture | null): ReleaseArtifact | null {
  if (!present.has(name)) return null;
  const bytes = readFileSync(join(dist, name));
  return {
    name,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: statSync(join(dist, name)).size,
    platform,
    arch,
    kind,
  };
}

const artifacts: ReleaseArtifact[] = [];
const add = (entry: ReleaseArtifact | null) => { if (entry) artifacts.push(entry); };

add(artifact(windowsPackageAsset(version), 'app-package', 'windows', null));
add(artifact(windowsSetupAsset(version), 'setup-script', 'windows', null));
add(artifact(windowsInstallerAsset(version), 'installer-exe', 'windows', null));
add(artifact('install.ps1', 'installer-script', 'windows', null));
for (const arch of ARCHITECTURES) {
  add(artifact(macosPackageAsset(version, arch), 'app-package', 'macos', arch));
  add(artifact(ubuntuPackageAsset(version, arch), 'app-package', 'ubuntu', arch));
}
add(artifact(installerScriptAsset('macos'), 'installer-script', 'macos', null));
add(artifact(installerScriptAsset('ubuntu'), 'installer-script', 'ubuntu', null));
add(artifact(CHECKSUMS_ASSET, 'checksums', null, null));

/** Which architectures a platform actually produced, rather than which it hoped for. */
const builtFor = (platform: 'macos' | 'ubuntu'): Architecture[] =>
  ARCHITECTURES.filter((arch) =>
    artifacts.some((entry) => entry.platform === platform && entry.arch === arch && entry.kind === 'app-package'),
  );

const manifest: ReleaseManifest = {
  schemaVersion: RELEASE_MANIFEST_SCHEMA,
  version,
  tag: `v${version}`,
  commit,
  builtAt: new Date().toISOString(),
  ...(runUrl ? { builtBy: runUrl } : {}),
  // Nothing here carries a platform signature, and the manifest says so rather
  // than leaving a reader to assume.
  signed: { windows: false, macos: false, ubuntu: false },
  minimumUpdaterSchema: 1,
  installLayoutSchema: INSTALL_LAYOUT_SCHEMA,
  platforms: {
    windows: {
      supported: true,
      architectures: ['x64'],
      methods: ['BOOTSTRAP', 'INSTALLER'],
      requirements: {
        minimumDocker: '20.10.0',
        minimumChromeMajor: null,
        bundledNode: nodeRuntime.version,
        // Docker Desktop's own floor, which is what AI17Z inherits.
        os: { minimumBuild: 19045 },
      },
    },
    macos: {
      supported: builtFor('macos').length > 0,
      architectures: builtFor('macos').length > 0 ? builtFor('macos') : ['arm64'],
      methods: ['MACOS_PKG'],
      requirements: {
        minimumDocker: '20.10.0',
        // Google's floor for Chrome on macOS, not a number AI17Z chose.
        minimumChromeMajor: null,
        bundledNode: nodeRuntime.version,
        os: { minimumMajor: 13 },
      },
    },
    ubuntu: {
      supported: builtFor('ubuntu').length > 0,
      architectures: builtFor('ubuntu').length > 0 ? builtFor('ubuntu') : ['x64'],
      methods: ['UBUNTU_DEB'],
      requirements: {
        minimumDocker: '20.10.0',
        minimumChromeMajor: null,
        bundledNode: nodeRuntime.version,
        // Docker Engine's own supported list, intersected with what AI17Z needs.
        os: { releases: ['22.04', '24.04', '26.04'] },
      },
    },
  },
  artifacts,
  migrations: { latest: migrations[migrations.length - 1] ?? 'none', count: migrations.length },
};

// Validated against the same schema every reader parses it with. A manifest
// this tool cannot itself read back is one no installer could either.
const checked = releaseManifestSchema.safeParse(manifest);
if (!checked.success) {
  console.error('  the manifest this produced does not match its own schema:');
  console.error(`  ${checked.error.issues[0]?.path.join('.')}: ${checked.error.issues[0]?.message}`);
  process.exit(1);
}

writeFileSync(join(dist, MANIFEST_ASSET), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`  ${MANIFEST_ASSET}: ${artifacts.length} artifacts, ${migrations.length} migrations`);
for (const entry of artifacts) {
  console.log(`    ${entry.name}  ${entry.sha256.slice(0, 12)}  ${entry.platform ?? 'any'}/${entry.arch ?? 'any'}`);
}
